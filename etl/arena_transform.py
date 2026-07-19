#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "psycopg[binary]>=3.2",
#   "python-dotenv>=1.0",
#   "phevaluator>=0.5",
# ]
# ///
"""Arena analytics transform (Stage 2) — raw.* -> stg -> int -> mart.

Implements etl/PRD_analytics_etl.md: flattens raw.replays into typed facts,
builds the mirror-pair spine (the ladder plays duplicate poker), computes
equity (the one Python-heavy piece, see holdem.py), and materializes the
mart tables behind the app's five views. Everything is idempotent and
watermark-incremental; see etl/ANALYTICS.md for the full documentation.

Usage:
    arena_transform.py init-db              apply schema_analytics.sql
    arena_transform.py run                  incremental transform (cron entrypoint)
    arena_transform.py run --limit N        process at most N new replays (testing)
    arena_transform.py rebuild              truncate stg/int/mart (keeps equity cache) + full re-run
    arena_transform.py status               row counts, watermark lag, last QA
    arena_transform.py selftest             walker + equity checks against samples/ (no DB)

Config via env / .env next to the script: ARENA_RAW_DB_URL (same DSN as the
loader), ARENA_EQ_MC_SAMPLES (default 10000), ARENA_TRANSFORM_BATCH (default 200).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

import holdem

log = logging.getLogger("arena_transform")
SCRIPT_DIR = Path(__file__).resolve().parent

STREET_NO = {"Preflop": 0, "Flop": 1, "Turn": 2, "River": 3}
STREETS = ["Preflop", "Flop", "Turn", "River"]
WALK_STEP = "walk_replays"

_RE_STRATEGY_NOTE = re.compile(r"Strategy note:\s*(.+)\s*$", re.DOTALL)
_RE_SELF_EQ = re.compile(r"\beq(?:uity)?\s*[=:]\s*([01]?\.\d+)", re.IGNORECASE)


def parse_ts(value):
    """Epoch-ms int or ISO string -> aware UTC datetime (same as the loader)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


# ===========================================================================
# The walker: one replay payload -> typed rows for every stg/int table.
# Pure function of (payload, equity engine) — testable without a DB.
# ===========================================================================

class SkipReplay(Exception):
    """Replay can't be transformed (mid-play, malformed, ...). Carries a reason."""


def _eff_action(action: str, to_amount, current_bet_before) -> str:
    """Effective action for stats/lines: an 'all-in' is a bet, raise or call
    depending on what it did to the price (PRD's is_aggressive column keeps
    the raw label; features use this)."""
    if action != "all-in":
        return action
    to_amount = to_amount or 0
    facing = current_bet_before or 0
    if to_amount > facing:
        return "bet" if facing == 0 else "raise"
    return "call"


def walk_replay(payload: dict, engine: holdem.EquityEngine) -> dict:
    """Parse one raw.replays payload into row-dicts for every target table.

    Raises SkipReplay for hands the transform must not ingest (not completed,
    wrong seat count, missing mirror keys)."""
    table = payload.get("table") or {}
    events = sorted(payload.get("events") or [], key=lambda e: e.get("sequence", 0))
    hand_id = table.get("id")
    if not hand_id:
        raise SkipReplay("no_table_id")
    if table.get("status") != "Completed":
        raise SkipReplay("not_completed")
    if not any(e.get("type") == "TableEnded" for e in events):
        raise SkipReplay("no_table_ended")
    seats = table.get("seats") or []
    if len(seats) != 2:
        raise SkipReplay("bad_seat_count")

    # --- mirror keys (only place they exist: the Joined payloads) ----------
    block_id = hand_number = None
    for e in events:
        if e.get("type") == "Joined":
            p = e.get("payload") or {}
            block_id = block_id or p.get("sandboxPvpBlockId")
            hand_number = hand_number or p.get("sandboxPvpHandNumber")
    if not block_id or not hand_number:
        raise SkipReplay("no_block_key")

    dealer_seat = None
    for e in events:
        if e.get("type") == "TableStarted":
            dealer_seat = (e.get("payload") or {}).get("dealerSeatNumber")
    if dealer_seat is None:
        raise SkipReplay("no_table_started")

    seat_by_no = {s["seatNumber"]: s for s in seats}
    if set(seat_by_no) != {1, 2}:
        raise SkipReplay("bad_seat_numbers")
    for s in seats:
        if len(s.get("holeCards") or []) != 2:
            raise SkipReplay("missing_hole_cards")

    # --- event walk: actions, blinds, street boards ------------------------
    actions = []                       # enriched dicts, chronological
    street_boards = {0: []}            # street_no -> board as dealt
    blind_of, blind_amount = {}, {}
    committed = {1: 0, 2: 0}           # this street (fallback for invested)
    board, prev_snap = [], None

    for e in events:
        etype, p, snap = e.get("type"), e.get("payload") or {}, e.get("snapshot") or {}
        if etype == "BlindPosted":
            blind_of[p["seatNumber"]] = p.get("blind")
            blind_amount[p["seatNumber"]] = p.get("amount") or 0
            committed[p["seatNumber"]] = p.get("amount") or 0
        elif etype == "StreetDealt":
            board = list(p.get("boardCards") or [])
            sn = STREET_NO.get(p.get("street") or e.get("street"))
            if sn is not None:
                street_boards[sn] = list(board)
            committed = {1: 0, 2: 0}
        elif etype == "ActionTaken":
            seat = p["seatNumber"]
            street = e.get("street")
            sn = STREET_NO.get(street)
            if sn is None:
                raise SkipReplay("bad_action_street")
            cur_before = (prev_snap or {}).get("currentBet")
            minr_before = (prev_snap or {}).get("minRaiseTo")
            stack_before = p.get("stackBefore")
            post_seat = next((x for x in (snap.get("seats") or [])
                              if x.get("seatNumber") == seat), None)
            if stack_before is not None and post_seat and post_seat.get("stackChips") is not None:
                invested = stack_before - post_seat["stackChips"]
            else:                       # fallback from tracked street commitment
                act = p.get("action")
                if act == "call":
                    invested = p.get("amount") or p.get("callAmount") or 0
                elif act in ("bet", "raise", "all-in"):
                    invested = (p.get("toAmount") or 0) - committed[seat]
                else:
                    invested = 0
            committed[seat] += invested
            message = p.get("message") or ""
            note = _RE_STRATEGY_NOTE.search(message)
            self_eq = _RE_SELF_EQ.search(message)
            eff = _eff_action(p.get("action"), p.get("toAmount"), cur_before)
            actions.append({
                "action_id": e.get("id"),
                "hand_id": hand_id,
                "sequence": e.get("sequence"),
                "street": street, "street_no": sn,
                "actor_seat_number": seat,
                "agent_id": e.get("agentId") or seat_by_no[seat].get("agentId"),
                "action": p.get("action"), "eff": eff,
                "to_amount": p.get("toAmount"), "amount": p.get("amount"),
                "call_amount": p.get("callAmount"),
                "invested_chips": invested,
                "pot_before": p.get("pot"),
                "pot_after": snap.get("potChips"),
                "stack_before": stack_before,
                "current_bet_before": cur_before,
                "min_raise_to_before": minr_before,
                "board_so_far": list(board),
                "size_bb": round(invested / 10.0, 2) if eff in ("bet", "raise") else None,
                "size_pot_fraction": (round(invested / p["pot"], 4)
                                      if eff in ("bet", "raise") and p.get("pot") else None),
                "reasoning_text": note.group(1).strip() if note else None,
                "bot_self_reported_eq": float(self_eq.group(1)) if self_eq else None,
                "message_raw": message or None,
                "occurred_at": parse_ts(e.get("occurredAt")),
            })
        if snap:
            prev_snap = snap

    if not actions:
        raise SkipReplay("no_actions")

    # --- hand-level facts ---------------------------------------------------
    last_action = actions[-1]
    went_to_showdown = last_action["action"] != "fold"
    street_reached = "Showdown" if went_to_showdown else last_action["street"]
    final_board = list(table.get("boardCards") or [])
    pot_final = sum(s.get("totalCommittedChips") or 0 for s in seats)
    winners = table.get("winners") or []
    orientation = 1 if hand_number % 2 == 1 else 2

    hand_row = {
        "hand_id": hand_id,
        "table_number": table.get("tableNumber"),
        "competition_id": table.get("competitionId"),
        "block_id": block_id, "hand_number": hand_number,
        "orientation": orientation,
        "dealer_seat_number": dealer_seat,
        "board_cards": final_board,
        "street_reached": street_reached,
        "status": table.get("status"),
        "pot_final_chips": pot_final,
        "went_to_showdown": went_to_showdown,
        "small_blind_chips": table.get("smallBlindChips"),
        "big_blind_chips": table.get("bigBlindChips"),
        "buy_in_chips": table.get("buyInChips"),
        "started_at": parse_ts(table.get("startedAt")),
        "ended_at": parse_ts(table.get("endedAt")),
    }

    seat_rows = []
    for s in seats:
        n = s["seatNumber"]
        seat_rows.append({
            "hand_id": hand_id, "seat_number": n,
            "agent_id": s.get("agentId"), "agent_name": s.get("agentName"),
            "agent_handle": s.get("agentHandle"),
            "hole_cards": list(s.get("holeCards") or []),
            "is_button": n == dealer_seat,
            "is_in_position": n == dealer_seat,
            "posted_blind": blind_of.get(n),
            "total_committed_chips": s.get("totalCommittedChips") or 0,
            "payout_chips": s.get("payoutChips") or 0,
            "status": s.get("status"),
        })

    features, lines = _features_and_lines(hand_id, actions, seat_by_no, dealer_seat,
                                          went_to_showdown, seat_rows)

    texture_row = None
    if len(final_board) >= 3:
        t = holdem.classify_flop(final_board)
        t["hand_id"] = hand_id
        texture_row = t

    equity_rows, action_eq_rows = _equity_rows(
        hand_id, actions, seat_rows, street_boards, went_to_showdown,
        pot_final, engine)

    return {
        "hands": [hand_row], "hand_seats": seat_rows, "actions": actions,
        "features": features, "lines": lines,
        "textures": [texture_row] if texture_row else [],
        "hand_equity": equity_rows, "action_equity": action_eq_rows,
    }


# ---------------------------------------------------------------------------
# Features + line labels (PRD §6.4 / §7.3): one street-ordered pass.
# Line taxonomy is documented in ANALYTICS.md.
# ---------------------------------------------------------------------------

def _suffixed(base: str, rest: list[str]) -> str:
    """base + response to being raised afterwards, capped one level deep."""
    if not rest:
        return base
    return base + {"fold": "_fold", "call": "_call", "raise": "_raise",
                   "bet": "_raise", "check": ""}[rest[0]]


def _features_and_lines(hand_id, actions, seat_by_no, dealer_seat,
                        went_to_showdown, seat_rows):
    chip_delta = {r["seat_number"]: r["payout_chips"] - r["total_committed_chips"]
                  for r in seat_rows}
    payout = {r["seat_number"]: r["payout_chips"] for r in seat_rows}
    f = {n: {
        "hand_id": hand_id, "seat_number": n,
        "agent_id": seat_by_no[n].get("agentId"),
        "is_button": n == dealer_seat,
        "vpip": False, "pfr": False,
        "three_bet": False, "three_bet_opp": False,
        "faced_three_bet": False, "folded_to_three_bet": False,
        "was_preflop_aggressor": False,
        "saw_flop": False,
        "cbet_flop": False, "cbet_flop_opp": False,
        "faced_cbet_flop": False, "folded_to_cbet_flop": False,
        "cbet_turn": False, "cbet_turn_opp": False,
        "cbet_river": False, "cbet_river_opp": False,
        "check_raised": False, "check_raise_opp": False,
        "wtsd": went_to_showdown,
        "wwsf": False,
        "won_hand": chip_delta[n] > 0,
        "won_at_showdown": went_to_showdown and payout[n] > 0,
        "bets_count": 0, "raises_count": 0, "calls_count": 0,
        "checks_count": 0, "folds_count": 0,
    } for n in (1, 2)}

    by_street: dict[int, list[dict]] = {}
    for a in actions:
        by_street.setdefault(a["street_no"], []).append(a)

    # ---- preflop: bet levels (BB post = level 1, open = 2, 3bet = 3) ------
    level, opener, three_bettor, last_aggressor = 1, None, None, None
    pre_own: dict[int, list[tuple[str, int]]] = {1: [], 2: []}   # (eff, level_before)
    for a in by_street.get(0, []):
        seat, eff = a["actor_seat_number"], a["eff"]
        pre_own[seat].append((eff, level))
        if eff in ("raise", "bet"):
            level += 1
            if level == 2:
                opener = seat
            elif level == 3:
                three_bettor = seat
            last_aggressor = seat
        if eff in ("call", "raise", "bet"):
            f[seat]["vpip"] = True
        if eff in ("raise", "bet"):
            f[seat]["pfr"] = True
    for n in (1, 2):
        f[n]["three_bet"] = n == three_bettor
        f[n]["three_bet_opp"] = any(lb == 2 for _, lb in pre_own[n])
        f[n]["faced_three_bet"] = (three_bettor is not None and n == opener
                                   and any(lb >= 3 for _, lb in pre_own[n]))
        f[n]["folded_to_three_bet"] = any(
            eff == "fold" and lb >= 3 for eff, lb in pre_own[n]) and n == opener
        f[n]["was_preflop_aggressor"] = (last_aggressor == n)

    saw_flop = 1 in by_street or (went_to_showdown and last_aggressor is not None
                                  and max(by_street) == 0)  # preflop all-in runout
    if saw_flop:
        for n in (1, 2):
            f[n]["saw_flop"] = True
            f[n]["wwsf"] = f[n]["won_hand"]

    # ---- postflop streets: initiative, barrels, check-raises, lines -------
    lines = []
    for n in (1, 2):
        line = _preflop_line(n, n == dealer_seat, pre_own[n])
        if line:
            lines.append({
                "hand_id": hand_id, "seat_number": n,
                "agent_id": seat_by_no[n].get("agentId"),
                "street": "Preflop", "street_no": 0,
                "position": "IP" if n == dealer_seat else "OOP",
                "line": line,
            })

    initiative = last_aggressor                     # carried into each street
    barrel = {1: {"chain": f[1]["was_preflop_aggressor"]},
              2: {"chain": f[2]["was_preflop_aggressor"]}}
    facing_label = {}                               # seat -> label of the bet it faces

    for sn in (1, 2, 3):
        street_acts = by_street.get(sn)
        if not street_acts:
            continue
        street = STREETS[sn]
        own: dict[int, list[dict]] = {1: [], 2: []}
        for a in street_acts:
            own[a["actor_seat_number"]].append(a)
        first_bettor = next((a["actor_seat_number"] for a in street_acts
                             if a["eff"] == "bet"), None)
        first_bet_label = None
        if first_bettor is not None:
            has_init = first_bettor == initiative
            ip = first_bettor == dealer_seat
            if has_init:
                if barrel[first_bettor]["chain"]:
                    first_bet_label = {1: "cbet", 2: "double_barrel",
                                       3: "triple_barrel"}[sn]
                else:
                    first_bet_label = "delayed_cbet"
            else:
                first_bet_label = ("stab" if ip
                                   else ("donk" if sn == 1 else "probe"))
        # barrel chain continues only if the street's first-in bet was theirs
        for n in (1, 2):
            barrel[n]["chain"] = barrel[n]["chain"] and first_bettor == n

        for a in street_acts:                       # initiative + counters
            n, eff = a["actor_seat_number"], a["eff"]
            if eff in ("bet", "raise"):
                initiative = n
            key = {"bet": "bets_count", "raise": "raises_count",
                   "call": "calls_count", "check": "checks_count",
                   "fold": "folds_count"}.get(eff)
            if key:
                f[n][key] += 1

        for n in (1, 2):
            acts = own[n]
            if not acts:
                continue
            effs = [a["eff"] for a in acts]
            opp = 2 if n == 1 else 1
            # cbet family (flop cbet -> turn double -> river triple)
            if sn == 1:
                if f[n]["was_preflop_aggressor"]:
                    if acts[0]["eff"] == "bet":
                        f[n]["cbet_flop"] = f[n]["cbet_flop_opp"] = True
                    elif (acts[0]["current_bet_before"] or 0) == 0:
                        f[n]["cbet_flop_opp"] = True
                if f[opp]["was_preflop_aggressor"] and first_bettor == opp \
                        and first_bet_label == "cbet":
                    f[n]["faced_cbet_flop"] = True
                    resp = next((x for x in acts
                                 if (x["current_bet_before"] or 0) > 0), None)
                    f[n]["folded_to_cbet_flop"] = bool(resp and resp["eff"] == "fold")
            elif sn == 2 and f[n]["cbet_flop"]:
                if acts[0]["eff"] == "bet":
                    f[n]["cbet_turn"] = f[n]["cbet_turn_opp"] = True
                elif (acts[0]["current_bet_before"] or 0) == 0:
                    f[n]["cbet_turn_opp"] = True
            elif sn == 3 and f[n]["cbet_turn"]:
                if acts[0]["eff"] == "bet":
                    f[n]["cbet_river"] = f[n]["cbet_river_opp"] = True
                elif (acts[0]["current_bet_before"] or 0) == 0:
                    f[n]["cbet_river_opp"] = True
            # check-raise (any street)
            if "check" in effs:
                after = effs[effs.index("check") + 1:]
                if after:                            # opp bet after our check
                    f[n]["check_raise_opp"] = True
                    if "raise" in after:
                        f[n]["check_raised"] = True
            # line label
            label = _postflop_line(effs, n == first_bettor, first_bet_label,
                                   facing=first_bet_label if first_bettor == opp else None,
                                   sn=sn)
            if label:
                lines.append({
                    "hand_id": hand_id, "seat_number": n,
                    "agent_id": seat_by_no[n].get("agentId"),
                    "street": street, "street_no": sn,
                    "position": "IP" if n == dealer_seat else "OOP",
                    "line": label,
                })

    return list(f.values()), lines


def _preflop_line(seat, is_button, acts):
    if not acts:
        return None
    effs = [e for e, _ in acts]
    first, level_before = acts[0]
    if is_button:                                   # button/SB acts first preflop in HU
        if first == "fold":
            return "fold"
        if first == "call":
            return _suffixed("limp", effs[1:]) if len(effs) > 1 else "limp"
        if first in ("raise", "bet"):
            if len(effs) == 1:
                return "open"
            nxt = effs[1]
            return {"fold": "open_fold", "call": "open_call",
                    "raise": "4bet", "bet": "4bet", "check": "open"}[nxt]
        return None
    # big blind
    if first == "check":
        return "bb_check"
    if first == "fold":
        return "fold_vs_open" if level_before >= 2 else "fold_vs_limp"
    if first == "call":
        return "call_vs_open"
    if first in ("raise", "bet"):
        base = "3bet" if level_before >= 2 else "raise_vs_limp"
        return _suffixed(base, effs[1:])
    return None


def _postflop_line(effs, is_first_bettor, first_bet_label, facing, sn):
    """One label per (seat, street). See ANALYTICS.md for the taxonomy."""
    facing_short = {"cbet": "cbet", "double_barrel": "barrel2",
                    "triple_barrel": "barrel3"}.get(facing, "bet") if facing else None
    first = effs[0]
    if first == "bet":
        base = first_bet_label if is_first_bettor else "bet"
        return _suffixed(base, effs[1:])
    if first == "check":
        if len(effs) == 1:
            return "check_through"
        return {"fold": "check_fold", "call": "check_call",
                "raise": "check_raise", "bet": "check_through",
                "check": "check_through"}[effs[1]]
    if first in ("call", "fold", "raise"):
        target = facing_short or "bet"
        return {"call": f"call_vs_{target}", "fold": f"fold_vs_{target}",
                "raise": f"raise_vs_{target}"}[first]
    return None


# ---------------------------------------------------------------------------
# Equity rows (PRD §6.2): all-in EV per (hand, seat) + per-street decision
# equity assigned to every action.
# ---------------------------------------------------------------------------

def _equity_rows(hand_id, actions, seat_rows, street_boards, went_to_showdown,
                 pot_final, engine):
    holes = {r["seat_number"]: r["hole_cards"] for r in seat_rows}
    committed = {r["seat_number"]: r["total_committed_chips"] for r in seat_rows}
    result_bb = {r["seat_number"]: (r["payout_chips"] - r["total_committed_chips"]) / 10.0
                 for r in seat_rows}
    agent = {r["seat_number"]: r["agent_id"] for r in seat_rows}

    last_sn = actions[-1]["street_no"]
    all_in_runout = went_to_showdown and last_sn < 3     # betting closed before river
    equity_rows, action_eq_rows = [], []

    # All-in EV first (exact): a preflop all-in then also serves the per-street
    # loop below from the cache, upgraded from MC to exact.
    if all_in_runout:
        board = street_boards.get(last_sn, [])
        eq1, _ = engine.equity(holes[1], holes[2], board, need_exact=True)
        for n in (1, 2):
            eq = eq1 if n == 1 else 1.0 - eq1
            ev_bb = (eq * pot_final - committed[n]) / 10.0
            equity_rows.append({
                "hand_id": hand_id, "seat_number": n, "agent_id": agent[n],
                "went_all_in": True, "all_in_street": STREETS[last_sn],
                "equity_at_all_in": round(eq, 6),
                "ev_result_bb": round(ev_bb, 4),
            })
    else:
        for n in (1, 2):
            equity_rows.append({
                "hand_id": hand_id, "seat_number": n, "agent_id": agent[n],
                "went_all_in": False, "all_in_street": None,
                "equity_at_all_in": None,
                "ev_result_bb": result_bb[n],
            })

    # equity of seat 1 per street that had decisions (seat 2 = 1 - seat 1)
    eq1_by_street: dict[int, tuple[float, bool]] = {}
    for sn in sorted({a["street_no"] for a in actions}):
        board = street_boards.get(sn, [])
        try:
            eq1_by_street[sn] = engine.equity(holes[1], holes[2], board)
        except Exception as err:                      # bad card data — skip equity only
            log.warning("equity failed for %s street %s: %s", hand_id, sn, err)

    for a in actions:
        got = eq1_by_street.get(a["street_no"])
        if got is None:
            continue
        eq1, is_exact = got
        eq = eq1 if a["actor_seat_number"] == 1 else 1.0 - eq1
        action_eq_rows.append({"action_id": a["action_id"],
                               "equity_vs_actual": round(eq, 6),
                               "is_exact": is_exact})
    return equity_rows, action_eq_rows


# ===========================================================================
# DB layer: batched idempotent upserts
# ===========================================================================

def _upsert_sql(table: str, cols: list[str], key_cols: list[str],
                extra_set: str = "") -> str:
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols if c not in key_cols)
    if extra_set:
        updates += ", " + extra_set
    return (f"INSERT INTO {table} ({', '.join(cols)}) "
            f"VALUES ({', '.join(f'%({c})s' for c in cols)}) "
            f"ON CONFLICT ({', '.join(key_cols)}) DO UPDATE SET {updates}")


UPSERTS = {
    "hands": _upsert_sql("stg.hands", [
        "hand_id", "table_number", "competition_id", "block_id", "hand_number",
        "orientation", "dealer_seat_number", "board_cards", "street_reached",
        "status", "pot_final_chips", "went_to_showdown", "small_blind_chips",
        "big_blind_chips", "buy_in_chips", "started_at", "ended_at",
    ], ["hand_id"], extra_set="loaded_at = now()"),
    "hand_seats": _upsert_sql("stg.hand_seats", [
        "hand_id", "seat_number", "agent_id", "agent_name", "agent_handle",
        "hole_cards", "is_button", "is_in_position", "posted_blind",
        "total_committed_chips", "payout_chips", "status",
    ], ["hand_id", "seat_number"]),
    "actions": _upsert_sql("stg.actions", [
        "action_id", "hand_id", "sequence", "street", "street_no",
        "actor_seat_number", "agent_id", "action", "to_amount", "amount",
        "call_amount", "invested_chips", "pot_before", "pot_after",
        "stack_before", "current_bet_before", "min_raise_to_before",
        "board_so_far", "size_bb", "size_pot_fraction", "reasoning_text",
        "bot_self_reported_eq", "message_raw", "occurred_at",
    ], ["action_id"]),
    "textures": _upsert_sql("int.board_texture", [
        "hand_id", "is_paired", "is_monotone", "is_two_tone", "is_rainbow",
        "is_connected", "high_card_rank", "flop_texture_class",
    ], ["hand_id"]),
    "features": _upsert_sql("int.hand_features", [
        "hand_id", "seat_number", "agent_id", "is_button",
        "vpip", "pfr", "three_bet", "three_bet_opp", "faced_three_bet",
        "folded_to_three_bet", "was_preflop_aggressor", "saw_flop",
        "cbet_flop", "cbet_flop_opp", "faced_cbet_flop", "folded_to_cbet_flop",
        "cbet_turn", "cbet_turn_opp", "cbet_river", "cbet_river_opp",
        "check_raised", "check_raise_opp", "wtsd", "wwsf", "won_hand",
        "won_at_showdown", "bets_count", "raises_count", "calls_count",
        "checks_count", "folds_count",
    ], ["hand_id", "seat_number"]),
    "lines": _upsert_sql("int.hand_street_lines", [
        "hand_id", "seat_number", "agent_id", "street", "street_no",
        "position", "line",
    ], ["hand_id", "seat_number", "street_no"]),
    "hand_equity": _upsert_sql("int.hand_equity", [
        "hand_id", "seat_number", "agent_id", "went_all_in", "all_in_street",
        "equity_at_all_in", "ev_result_bb",
    ], ["hand_id", "seat_number"]),
    "action_equity": _upsert_sql("int.action_equity", [
        "action_id", "equity_vs_actual", "is_exact",
    ], ["action_id"]),
}

# Table order matters for FKs: hands before everything referencing them.
UPSERT_ORDER = ["hands", "hand_seats", "actions", "textures", "features",
                "lines", "hand_equity", "action_equity"]

EQUITY_CACHE_UPSERT = """
INSERT INTO int.equity_cache (cache_key, equity, is_exact)
VALUES (%s, %s, %s)
ON CONFLICT (cache_key) DO UPDATE
   SET equity = EXCLUDED.equity, is_exact = EXCLUDED.is_exact, computed_at = now()
 WHERE NOT int.equity_cache.is_exact           -- exact never downgraded to MC
"""


# ===========================================================================
# Tier 2/3 SQL
# ===========================================================================

MIRROR_PAIRS_SQL = """
WITH target_blocks AS (
    SELECT DISTINCT block_id FROM stg.hands WHERE loaded_at >= %(ts0)s
    UNION
    SELECT block_id FROM int.mirror_pairs WHERE NOT is_complete
),
pair_hands AS (
    SELECT h.mirror_pair_id, h.block_id, ceil(h.hand_number / 2.0)::int AS pair_index,
           h.competition_id, h.hand_id, h.orientation, h.started_at, h.ended_at
    FROM stg.hands h JOIN target_blocks tb USING (block_id)
),
pairs AS (
    SELECT mirror_pair_id,
           min(block_id)       AS block_id,
           min(pair_index)     AS pair_index,
           min(competition_id) AS competition_id,
           min(hand_id) FILTER (WHERE orientation = 1) AS hand_id_o1,
           min(hand_id) FILTER (WHERE orientation = 2) AS hand_id_o2,
           min(started_at)     AS started_at,
           max(ended_at)       AS ended_at
    FROM pair_hands GROUP BY mirror_pair_id
),
agents AS (
    SELECT ph.mirror_pair_id, s.agent_id, sum(s.result_bb) AS pair_bb
    FROM pair_hands ph JOIN stg.hand_seats s USING (hand_id)
    GROUP BY 1, 2
),
sides AS (
    SELECT mirror_pair_id, min(agent_id) AS agent_a_id, max(agent_id) AS agent_b_id
    FROM agents GROUP BY 1
)
INSERT INTO int.mirror_pairs (mirror_pair_id, block_id, pair_index, competition_id,
    agent_a_id, agent_b_id, hand_id_o1, hand_id_o2, is_complete,
    agent_a_pair_bb, agent_b_pair_bb, skill_delta_bb, started_at, ended_at)
SELECT p.mirror_pair_id, p.block_id, p.pair_index, p.competition_id,
       s.agent_a_id, s.agent_b_id, p.hand_id_o1, p.hand_id_o2,
       (p.hand_id_o1 IS NOT NULL AND p.hand_id_o2 IS NOT NULL),
       CASE WHEN p.hand_id_o1 IS NOT NULL AND p.hand_id_o2 IS NOT NULL THEN a.pair_bb END,
       CASE WHEN p.hand_id_o1 IS NOT NULL AND p.hand_id_o2 IS NOT NULL THEN -a.pair_bb END,
       CASE WHEN p.hand_id_o1 IS NOT NULL AND p.hand_id_o2 IS NOT NULL THEN a.pair_bb END,
       p.started_at, p.ended_at
FROM pairs p
JOIN sides s USING (mirror_pair_id)
JOIN agents a ON a.mirror_pair_id = p.mirror_pair_id AND a.agent_id = s.agent_a_id
ON CONFLICT (mirror_pair_id) DO UPDATE SET
    agent_a_id = EXCLUDED.agent_a_id, agent_b_id = EXCLUDED.agent_b_id,
    hand_id_o1 = EXCLUDED.hand_id_o1, hand_id_o2 = EXCLUDED.hand_id_o2,
    is_complete = EXCLUDED.is_complete,
    agent_a_pair_bb = EXCLUDED.agent_a_pair_bb,
    agent_b_pair_bb = EXCLUDED.agent_b_pair_bb,
    skill_delta_bb = EXCLUDED.skill_delta_bb,
    started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at
"""

HAND_HEADER_SQL = """
WITH touched AS (
    SELECT DISTINCT mirror_pair_id FROM stg.hands WHERE loaded_at >= %(ts0)s
)
INSERT INTO mart.hand_header (hand_id, mirror_hand_id, block_id, pair_index,
    orientation, competition_id,
    agent1_id, agent1_name, agent1_hole, agent1_result_bb, agent1_is_button,
    agent2_id, agent2_name, agent2_hole, agent2_result_bb,
    board_cards, final_pot_chips, winner_agent_id, street_reached, started_at)
SELECT h.hand_id, hm.hand_id, h.block_id, ceil(h.hand_number / 2.0)::int,
       h.orientation, h.competition_id,
       s1.agent_id, s1.agent_name, s1.hole_cards, s1.result_bb, s1.is_button,
       s2.agent_id, s2.agent_name, s2.hole_cards, s2.result_bb,
       h.board_cards, h.pot_final_chips, w.agent_id, h.street_reached, h.started_at
FROM stg.hands h
JOIN touched t ON t.mirror_pair_id = h.mirror_pair_id
JOIN stg.hand_seats s1 ON s1.hand_id = h.hand_id AND s1.seat_number = 1
JOIN stg.hand_seats s2 ON s2.hand_id = h.hand_id AND s2.seat_number = 2
LEFT JOIN stg.hands hm ON hm.mirror_pair_id = h.mirror_pair_id AND hm.hand_id <> h.hand_id
LEFT JOIN LATERAL (
    SELECT agent_id FROM stg.hand_seats w
    WHERE w.hand_id = h.hand_id AND w.payout_chips - w.total_committed_chips > 0
) w ON true
ON CONFLICT (hand_id) DO UPDATE SET
    mirror_hand_id = EXCLUDED.mirror_hand_id,
    agent1_name = EXCLUDED.agent1_name, agent2_name = EXCLUDED.agent2_name,
    agent1_result_bb = EXCLUDED.agent1_result_bb,
    agent2_result_bb = EXCLUDED.agent2_result_bb,
    winner_agent_id = EXCLUDED.winner_agent_id,
    street_reached = EXCLUDED.street_reached
"""

HAND_STEP_SQL = """
WITH touched AS (
    SELECT DISTINCT mirror_pair_id FROM stg.hands WHERE loaded_at >= %(ts0)s
),
target AS (
    SELECT h.hand_id FROM stg.hands h JOIN touched t USING (mirror_pair_id)
)
INSERT INTO mart.hand_step (hand_id, sequence, street, actor_agent_id, actor_name,
    is_button, action, size_bb, size_pot_fraction, pot_before, pot_after,
    stack_before, board_so_far, equity_at_decision, reasoning_text)
SELECT a.hand_id, a.sequence, a.street, a.agent_id, hs.agent_name, hs.is_button,
       a.action, a.size_bb, a.size_pot_fraction, a.pot_before, a.pot_after,
       a.stack_before, a.board_so_far, ae.equity_vs_actual, a.reasoning_text
FROM stg.actions a
JOIN target t ON t.hand_id = a.hand_id
JOIN stg.hand_seats hs ON hs.hand_id = a.hand_id AND hs.seat_number = a.actor_seat_number
LEFT JOIN int.action_equity ae ON ae.action_id = a.action_id
ON CONFLICT (hand_id, sequence) DO UPDATE SET
    equity_at_decision = EXCLUDED.equity_at_decision,
    reasoning_text = EXCLUDED.reasoning_text,
    actor_name = EXCLUDED.actor_name
"""

LEADERBOARD_SQL = """
WITH per_hand AS (
    SELECT s.agent_id, h.hand_id, h.block_id, s.result_bb, s.chip_delta,
           o.agent_id AS opponent_id
    FROM stg.hands h
    JOIN stg.hand_seats s USING (hand_id)
    JOIN stg.hand_seats o ON o.hand_id = h.hand_id AND o.seat_number <> s.seat_number
    WHERE h.competition_id = %(cid)s
),
agg AS (
    SELECT agent_id, count(*) AS hands, count(DISTINCT block_id) AS blocks,
           count(DISTINCT opponent_id) AS opponents,
           sum(chip_delta) AS net_chips, avg(result_bb) * 100 AS raw_bb100
    FROM per_hand GROUP BY 1
),
dup AS (
    SELECT agent_id,
           count(*) FILTER (WHERE is_complete) AS pairs,
           sum(pair_bb) FILTER (WHERE is_complete)
             / NULLIF(2 * count(*) FILTER (WHERE is_complete), 0) * 100 AS dup_bb100
    FROM int.pair_agent WHERE competition_id = %(cid)s GROUP BY 1
),
ev AS (
    SELECT e.agent_id, avg(e.ev_result_bb) * 100 AS ev_bb100
    FROM int.hand_equity e JOIN stg.hands h USING (hand_id)
    WHERE h.competition_id = %(cid)s GROUP BY 1
),
-- Ladder rank = position when the whole board is ordered by total_score DESC —
-- the order arena.dev.fun shows. The API's own `rank` field is a global dev.fun
-- platform rank across all arenas (not this ladder), so we recompute it here.
lb_now AS (
    SELECT agent_id, total_score, name, handle,
           row_number() OVER (ORDER BY total_score DESC NULLS LAST) AS rank
    FROM (
        SELECT DISTINCT ON (agent_id) agent_id, total_score,
               payload ->> 'name' AS name, payload ->> 'handle' AS handle
        FROM raw.leaderboard_history WHERE arena_id = %(cid)s
        ORDER BY agent_id, captured_at DESC
    ) latest
),
lb_7d AS (
    SELECT agent_id, total_score,
           row_number() OVER (ORDER BY total_score DESC NULLS LAST) AS rank
    FROM (
        SELECT DISTINCT ON (agent_id) agent_id, total_score
        FROM raw.leaderboard_history
        WHERE arena_id = %(cid)s AND captured_at <= now() - interval '7 days'
        ORDER BY agent_id, captured_at DESC
    ) latest7
),
names AS (
    SELECT DISTINCT ON (s.agent_id) s.agent_id, s.agent_name, s.agent_handle
    FROM stg.hand_seats s JOIN stg.hands h USING (hand_id)
    WHERE h.competition_id = %(cid)s
    ORDER BY s.agent_id, h.started_at DESC
)
INSERT INTO mart.leaderboard (competition_id, agent_id, agent_name, agent_handle,
    rank, trueskill_mu, trueskill_sigma, hands_played, blocks_played,
    completed_pairs, distinct_opponents, raw_bb_per_100, dup_adj_bb_per_100,
    ev_adj_bb_per_100, net_chips, rank_delta_7d, mu_delta_7d, last_updated)
SELECT %(cid)s, a.agent_id,
       COALESCE(lb.name, n.agent_name), COALESCE(lb.handle, n.agent_handle),
       lb.rank, lb.total_score, NULL,
       a.hands, a.blocks, COALESCE(d.pairs, 0), a.opponents,
       round(a.raw_bb100, 2), round(d.dup_bb100, 2), round(e.ev_bb100, 2),
       a.net_chips,
       lb7.rank - lb.rank, lb.total_score - lb7.total_score, now()
FROM agg a
LEFT JOIN dup d USING (agent_id)
LEFT JOIN ev e USING (agent_id)
LEFT JOIN lb_now lb USING (agent_id)
LEFT JOIN lb_7d lb7 USING (agent_id)
LEFT JOIN names n USING (agent_id)
"""

AGENT_STATS_SQL = """
WITH base AS (
    SELECT f.*, s.result_bb,
           CASE WHEN f.is_button THEN 'IP' ELSE 'OOP' END AS pos
    FROM int.hand_features f
    JOIN stg.hand_seats s USING (hand_id, seat_number)
    JOIN stg.hands h USING (hand_id)
    WHERE h.competition_id = %(cid)s
),
expanded AS (
    SELECT b.*, p.position
    FROM base b CROSS JOIN LATERAL (VALUES (b.pos), ('ALL')) AS p(position)
),
stats AS (
    SELECT agent_id, position,
           count(*) AS sample_n,
           round(100.0 * count(*) FILTER (WHERE vpip) / count(*), 2) AS vpip_pct,
           round(100.0 * count(*) FILTER (WHERE pfr) / count(*), 2) AS pfr_pct,
           round(100.0 * count(*) FILTER (WHERE three_bet)
                 / NULLIF(count(*) FILTER (WHERE three_bet_opp), 0), 2) AS three_bet_pct,
           round(100.0 * count(*) FILTER (WHERE folded_to_three_bet)
                 / NULLIF(count(*) FILTER (WHERE faced_three_bet), 0), 2) AS fold_to_three_bet_pct,
           round(100.0 * count(*) FILTER (WHERE cbet_flop)
                 / NULLIF(count(*) FILTER (WHERE cbet_flop_opp), 0), 2) AS cbet_flop_pct,
           round(100.0 * count(*) FILTER (WHERE folded_to_cbet_flop)
                 / NULLIF(count(*) FILTER (WHERE faced_cbet_flop), 0), 2) AS fold_to_cbet_flop_pct,
           round(100.0 * count(*) FILTER (WHERE cbet_turn)
                 / NULLIF(count(*) FILTER (WHERE cbet_turn_opp), 0), 2) AS cbet_turn_pct,
           round(100.0 * count(*) FILTER (WHERE cbet_river)
                 / NULLIF(count(*) FILTER (WHERE cbet_river_opp), 0), 2) AS cbet_river_pct,
           round(100.0 * count(*) FILTER (WHERE check_raised)
                 / NULLIF(count(*) FILTER (WHERE check_raise_opp), 0), 2) AS check_raise_pct,
           round(100.0 * count(*) FILTER (WHERE wtsd AND saw_flop)
                 / NULLIF(count(*) FILTER (WHERE saw_flop), 0), 2) AS wtsd_pct,
           round(100.0 * count(*) FILTER (WHERE won_at_showdown)
                 / NULLIF(count(*) FILTER (WHERE wtsd), 0), 2) AS wsd_pct,
           round(100.0 * count(*) FILTER (WHERE wwsf)
                 / NULLIF(count(*) FILTER (WHERE saw_flop), 0), 2) AS wwsf_pct,
           round((sum(bets_count) + sum(raises_count))::numeric
                 / NULLIF(sum(calls_count), 0), 3) AS aggression_factor,
           round(100.0 * (sum(bets_count) + sum(raises_count))
                 / NULLIF(sum(bets_count) + sum(raises_count)
                          + sum(calls_count) + sum(folds_count), 0), 2) AS aggression_freq_pct,
           round(avg(result_bb) * 100, 2) AS bb_per_100,
           jsonb_build_object(
               'hands', count(*),
               'three_bet', count(*) FILTER (WHERE three_bet_opp),
               'fold_to_three_bet', count(*) FILTER (WHERE faced_three_bet),
               'cbet_flop', count(*) FILTER (WHERE cbet_flop_opp),
               'fold_to_cbet_flop', count(*) FILTER (WHERE faced_cbet_flop),
               'cbet_turn', count(*) FILTER (WHERE cbet_turn_opp),
               'cbet_river', count(*) FILTER (WHERE cbet_river_opp),
               'check_raise', count(*) FILTER (WHERE check_raise_opp),
               'saw_flop', count(*) FILTER (WHERE saw_flop),
               'wtsd', count(*) FILTER (WHERE wtsd)
           ) AS opportunities
    FROM expanded GROUP BY 1, 2
),
sizes AS (
    SELECT a.agent_id,
           CASE WHEN hs.is_button THEN 'IP' ELSE 'OOP' END AS pos,
           a.size_pot_fraction
    FROM stg.actions a
    JOIN stg.hands h USING (hand_id)
    JOIN stg.hand_seats hs ON hs.hand_id = a.hand_id AND hs.seat_number = a.actor_seat_number
    WHERE h.competition_id = %(cid)s AND a.size_pot_fraction IS NOT NULL
),
sizes_x AS (
    SELECT s.*, p.position
    FROM sizes s CROSS JOIN LATERAL (VALUES (s.pos), ('ALL')) AS p(position)
),
size_agg AS (
    SELECT agent_id, position,
           round(avg(size_pot_fraction), 4) AS avg_bet_pot_fraction,
           jsonb_build_object(
               '0-33',   count(*) FILTER (WHERE size_pot_fraction < 0.3333),
               '33-66',  count(*) FILTER (WHERE size_pot_fraction >= 0.3333
                                            AND size_pot_fraction < 0.6667),
               '66-100', count(*) FILTER (WHERE size_pot_fraction >= 0.6667
                                            AND size_pot_fraction <= 1.0),
               '100+',   count(*) FILTER (WHERE size_pot_fraction > 1.0)
           ) AS sizing_histogram
    FROM sizes_x GROUP BY 1, 2
)
INSERT INTO mart.agent_stats (competition_id, agent_id, position, sample_n,
    vpip_pct, pfr_pct, three_bet_pct, fold_to_three_bet_pct, cbet_flop_pct,
    fold_to_cbet_flop_pct, cbet_turn_pct, cbet_river_pct, check_raise_pct,
    wtsd_pct, wsd_pct, wwsf_pct, aggression_factor, aggression_freq_pct,
    avg_bet_pot_fraction, sizing_histogram, bb_per_100, opportunities)
SELECT %(cid)s, st.agent_id, st.position, st.sample_n,
       st.vpip_pct, st.pfr_pct, st.three_bet_pct, st.fold_to_three_bet_pct,
       st.cbet_flop_pct, st.fold_to_cbet_flop_pct, st.cbet_turn_pct,
       st.cbet_river_pct, st.check_raise_pct, st.wtsd_pct, st.wsd_pct,
       st.wwsf_pct, st.aggression_factor, st.aggression_freq_pct,
       sz.avg_bet_pot_fraction, sz.sizing_histogram, st.bb_per_100, st.opportunities
FROM stats st LEFT JOIN size_agg sz USING (agent_id, position)
"""

# Shared mirror-divergence attribution: per completed pair and deck-side
# (seat), find the FIRST street where the two playings' lines differ and
# attribute the whole deck-side delta there (PRD §7.3 attribution caveat).
_MIRROR_ATTRIBUTION_CTE = """
sides AS (
    SELECT p.mirror_pair_id, sn.seat_number, st.street, st.street_no,
           CASE WHEN sn.seat_number = h1.dealer_seat_number THEN 'IP' ELSE 'OOP' END AS position,
           CASE WHEN st.street_no = 0 THEN 'na'
                ELSE COALESCE(bt.flop_texture_class, 'na') END AS board_texture,
           l1.line AS line1, l2.line AS line2,
           s1.agent_id AS agent1, s2.agent_id AS agent2,
           s1.result_bb AS r1, s2.result_bb AS r2,
           row_number() OVER (PARTITION BY p.mirror_pair_id, sn.seat_number
                              ORDER BY st.street_no) AS rn
    FROM int.mirror_pairs p
    JOIN stg.hands h1 ON h1.hand_id = p.hand_id_o1
    CROSS JOIN (VALUES (1), (2)) AS sn(seat_number)
    CROSS JOIN (VALUES ('Preflop', 0), ('Flop', 1), ('Turn', 2), ('River', 3))
        AS st(street, street_no)
    JOIN stg.hand_seats s1 ON s1.hand_id = p.hand_id_o1 AND s1.seat_number = sn.seat_number
    JOIN stg.hand_seats s2 ON s2.hand_id = p.hand_id_o2 AND s2.seat_number = sn.seat_number
    LEFT JOIN int.hand_street_lines l1
           ON l1.hand_id = p.hand_id_o1 AND l1.seat_number = sn.seat_number
          AND l1.street_no = st.street_no
    LEFT JOIN int.hand_street_lines l2
           ON l2.hand_id = p.hand_id_o2 AND l2.seat_number = sn.seat_number
          AND l2.street_no = st.street_no
    LEFT JOIN int.board_texture bt ON bt.hand_id = p.hand_id_o1
    WHERE p.is_complete AND p.competition_id = %(cid)s
      AND l1.line IS DISTINCT FROM l2.line
),
attributed AS (
    SELECT agent1 AS agent_id, agent2 AS opponent_id, position, street,
           board_texture, COALESCE(line1, 'no_action') AS line,
           (r1 - r2) AS delta_bb
    FROM sides WHERE rn = 1
    UNION ALL
    SELECT agent2, agent1, position, street,
           board_texture, COALESCE(line2, 'no_action'),
           (r2 - r1)
    FROM sides WHERE rn = 1
)
"""

AGENT_LEAKS_SQL = """
WITH spot_agg AS (
    SELECT l.agent_id, l.position, l.street,
           CASE WHEN l.street_no = 0 THEN 'na'
                ELSE COALESCE(bt.flop_texture_class, 'na') END AS board_texture,
           l.line,
           count(*) AS sample_n,
           round(avg(s.result_bb) * 100, 2) AS bb100,
           round(avg(e.ev_result_bb) * 100, 2) AS ev_bb100
    FROM int.hand_street_lines l
    JOIN stg.hands h USING (hand_id)
    JOIN stg.hand_seats s ON s.hand_id = l.hand_id AND s.seat_number = l.seat_number
    LEFT JOIN int.hand_equity e ON e.hand_id = l.hand_id AND e.seat_number = l.seat_number
    LEFT JOIN int.board_texture bt ON bt.hand_id = l.hand_id
    WHERE h.competition_id = %(cid)s
    GROUP BY 1, 2, 3, 4, 5
),
""" + _MIRROR_ATTRIBUTION_CTE + """,
mirror_agg AS (
    SELECT agent_id, position, street, board_texture, line,
           count(*) AS mirror_n,
           round(avg(delta_bb) * 100, 2) AS mirror_delta_bb
    FROM attributed GROUP BY 1, 2, 3, 4, 5
)
INSERT INTO mart.agent_leaks (competition_id, agent_id, position, street,
    board_texture, line, sample_n, bb_per_100_spot, ev_bb_per_100_spot,
    mirror_n, mirror_delta_bb)
SELECT %(cid)s, agent_id, position, street, board_texture, line,
       COALESCE(sa.sample_n, 0), sa.bb100, sa.ev_bb100,
       COALESCE(ma.mirror_n, 0), ma.mirror_delta_bb
FROM spot_agg sa
FULL JOIN mirror_agg ma USING (agent_id, position, street, board_texture, line)
"""

MATCHUPS_SQL = """
WITH per_hand AS (
    SELECT s.agent_id, o.agent_id AS opponent_id, h.hand_id, h.block_id,
           s.result_bb, s.chip_delta, e.ev_result_bb
    FROM stg.hands h
    JOIN stg.hand_seats s USING (hand_id)
    JOIN stg.hand_seats o ON o.hand_id = h.hand_id AND o.seat_number <> s.seat_number
    LEFT JOIN int.hand_equity e ON e.hand_id = s.hand_id AND e.seat_number = s.seat_number
    WHERE h.competition_id = %(cid)s
),
agg AS (
    SELECT agent_id, opponent_id, count(*) AS hands,
           count(DISTINCT block_id) AS blocks,
           round(avg(result_bb) * 100, 2) AS raw_bb100,
           round(avg(ev_result_bb) * 100, 2) AS ev_bb100,
           round(avg(CASE WHEN chip_delta > 0 THEN 1.0 ELSE 0.0 END), 4) AS win_rate
    FROM per_hand GROUP BY 1, 2
),
dup AS (
    SELECT agent_id, opponent_id,
           count(*) FILTER (WHERE is_complete) AS pairs,
           round(sum(pair_bb) FILTER (WHERE is_complete)
             / NULLIF(2 * count(*) FILTER (WHERE is_complete), 0) * 100, 2) AS dup_bb100
    FROM int.pair_agent WHERE competition_id = %(cid)s GROUP BY 1, 2
),
""" + _MIRROR_ATTRIBUTION_CTE + """,
div_spots AS (
    SELECT agent_id, opponent_id, position, street, board_texture, line,
           count(*) AS n, round(avg(delta_bb) * 100, 2) AS delta_bb100
    FROM attributed GROUP BY 1, 2, 3, 4, 5, 6
),
ranked AS (
    SELECT *,
           row_number() OVER (PARTITION BY agent_id, opponent_id
                              ORDER BY delta_bb100 DESC) AS r_top,
           row_number() OVER (PARTITION BY agent_id, opponent_id
                              ORDER BY delta_bb100 ASC) AS r_bot
    FROM div_spots
),
spot_json AS (
    SELECT agent_id, opponent_id,
           jsonb_agg(jsonb_build_object(
               'position', position, 'street', street,
               'board_texture', board_texture, 'line', line,
               'mirror_n', n, 'mirror_delta_bb', delta_bb100)
               ORDER BY delta_bb100 DESC)
             FILTER (WHERE r_top <= 3 OR r_bot <= 3) AS spot_deltas
    FROM ranked GROUP BY 1, 2
)
INSERT INTO mart.matchups (competition_id, agent_a_id, agent_b_id, blocks,
    completed_pairs, hands, a_raw_bb_per_100, a_dup_adj_bb_per_100,
    a_ev_adj_bb_per_100, a_win_rate, spot_deltas, last_updated)
SELECT %(cid)s, g.agent_id, g.opponent_id, g.blocks, COALESCE(d.pairs, 0),
       g.hands, g.raw_bb100, d.dup_bb100, g.ev_bb100, g.win_rate,
       sj.spot_deltas, now()
FROM agg g
LEFT JOIN dup d USING (agent_id, opponent_id)
LEFT JOIN spot_json sj USING (agent_id, opponent_id)
"""

SEASON_SUMMARY_SQL = """
INSERT INTO mart.season_summary (competition_id, competition_name,
    competition_status, total_agents, total_hands, total_blocks,
    completed_pairs, first_hand_at, last_hand_at, last_updated)
SELECT %(cid)s, c.payload ->> 'name', c.status,
       (SELECT count(DISTINCT s.agent_id) FROM stg.hand_seats s
         JOIN stg.hands h USING (hand_id) WHERE h.competition_id = %(cid)s),
       (SELECT count(*) FROM stg.hands WHERE competition_id = %(cid)s),
       (SELECT count(DISTINCT block_id) FROM stg.hands WHERE competition_id = %(cid)s),
       (SELECT count(*) FROM int.mirror_pairs
         WHERE competition_id = %(cid)s AND is_complete),
       (SELECT min(started_at) FROM stg.hands WHERE competition_id = %(cid)s),
       (SELECT max(started_at) FROM stg.hands WHERE competition_id = %(cid)s),
       now()
FROM raw.competitions c WHERE c.competition_id = %(cid)s
"""

HANDS_OVER_TIME_SQL = """
WITH b AS (
    SELECT date_trunc('hour', h.started_at) AS bucket_ts,
           count(DISTINCT h.hand_id) AS n,
           count(DISTINCT s.agent_id) AS agents
    FROM stg.hands h JOIN stg.hand_seats s USING (hand_id)
    WHERE h.competition_id = %(cid)s
    GROUP BY 1
)
INSERT INTO mart.hands_over_time (competition_id, bucket_ts, hands_in_bucket,
    hands_cumulative, active_agents)
SELECT %(cid)s, bucket_ts, n, sum(n) OVER (ORDER BY bucket_ts), agents FROM b
"""

# Per-snapshot ladder position over time (Overview rank-history drill-down).
# raw.leaderboard_history is append-on-change, so at any captured_at only the
# agents that moved have a row; to rank the *whole* board at that instant we
# carry-forward each agent's last-known total_score (LATERAL as-of lookup),
# then row_number() by total_score DESC — the same ordering as mart.leaderboard.
# Full rebuild per run; trivial at current depth (a few dozen snapshots).
RANK_HISTORY_SQL = """
WITH snaps AS (
    SELECT DISTINCT captured_at
    FROM raw.leaderboard_history WHERE arena_id = %(cid)s
),
board AS (
    SELECT DISTINCT agent_id
    FROM raw.leaderboard_history WHERE arena_id = %(cid)s
),
asof AS (
    SELECT s.captured_at, b.agent_id, lh.total_score
    FROM snaps s
    CROSS JOIN board b
    JOIN LATERAL (
        SELECT h.total_score
        FROM raw.leaderboard_history h
        WHERE h.arena_id = %(cid)s AND h.agent_id = b.agent_id
          AND h.captured_at <= s.captured_at
        ORDER BY h.captured_at DESC
        LIMIT 1
    ) lh ON true
    WHERE lh.total_score IS NOT NULL
)
INSERT INTO mart.rank_history (competition_id, agent_id, captured_at,
    total_score, rank, field_size)
SELECT %(cid)s, agent_id, captured_at, total_score,
       row_number() OVER (PARTITION BY captured_at ORDER BY total_score DESC),
       count(*)     OVER (PARTITION BY captured_at)
FROM asof
"""

# Agent dashboard "Trends": cumulative raw/dup-adj/ev-adj bb/100 per agent per
# UTC day. Same source definitions as LEADERBOARD_SQL (raw = avg(result_bb)
# over stg.hand_seats; dup-adj = sum(pair_bb)/(2*completed pairs) over
# int.pair_agent; ev-adj = avg(ev_result_bb) over int.hand_equity), accumulated
# day by day, so each agent's final day reconciles with mart.leaderboard.
# Days are bucketed in UTC explicitly (not the session zone) so the grain is
# stable across deploys. dup-adj stays NULL until the first completed pair —
# the same NULL handling as the leaderboard (NULLIF on a zero denominator).
# Full rebuild per run; trivial at current scale.
AGENT_DAILY_PERFORMANCE_SQL = """
WITH hand_days AS (
    SELECT s.agent_id, (h.started_at AT TIME ZONE 'UTC')::date AS day,
           count(*) AS hands, sum(s.result_bb) AS sum_bb
    FROM stg.hands h
    JOIN stg.hand_seats s USING (hand_id)
    WHERE h.competition_id = %(cid)s
    GROUP BY 1, 2
),
pair_days AS (
    SELECT agent_id, (started_at AT TIME ZONE 'UTC')::date AS day,
           count(*) FILTER (WHERE is_complete) AS pairs,
           sum(pair_bb) FILTER (WHERE is_complete) AS sum_pair_bb
    FROM int.pair_agent
    WHERE competition_id = %(cid)s
    GROUP BY 1, 2
),
ev_days AS (
    SELECT e.agent_id, (h.started_at AT TIME ZONE 'UTC')::date AS day,
           count(*) AS n, sum(e.ev_result_bb) AS sum_ev_bb
    FROM int.hand_equity e
    JOIN stg.hands h USING (hand_id)
    WHERE h.competition_id = %(cid)s
    GROUP BY 1, 2
),
spine AS (
    SELECT agent_id, day FROM hand_days
    UNION
    SELECT agent_id, day FROM pair_days
    UNION
    SELECT agent_id, day FROM ev_days
)
INSERT INTO mart.agent_daily_performance (competition_id, agent_id, day,
    hands_cum, raw_bb100_cum, dup_adj_bb100_cum, ev_adj_bb100_cum)
SELECT %(cid)s, s.agent_id, s.day,
       (sum(COALESCE(hd.hands, 0)) OVER w)::bigint,
       round(sum(COALESCE(hd.sum_bb, 0)) OVER w
             / NULLIF(sum(COALESCE(hd.hands, 0)) OVER w, 0) * 100, 2),
       round(sum(COALESCE(pd.sum_pair_bb, 0)) OVER w
             / NULLIF(2 * sum(COALESCE(pd.pairs, 0)) OVER w, 0) * 100, 2),
       round(sum(COALESCE(ed.sum_ev_bb, 0)) OVER w
             / NULLIF(sum(COALESCE(ed.n, 0)) OVER w, 0) * 100, 2)
FROM spine s
LEFT JOIN hand_days hd ON hd.agent_id = s.agent_id AND hd.day = s.day
LEFT JOIN pair_days pd ON pd.agent_id = s.agent_id AND pd.day = s.day
LEFT JOIN ev_days   ed ON ed.agent_id = s.agent_id AND ed.day = s.day
WINDOW w AS (PARTITION BY s.agent_id ORDER BY s.day)
ORDER BY s.agent_id, s.day
"""

# Marts rebuilt in full per competition each run (small at this scale);
# hand_header/hand_step are the incremental exceptions above.
MART_REBUILDS = [
    ("mart.leaderboard", LEADERBOARD_SQL),
    ("mart.agent_stats", AGENT_STATS_SQL),
    ("mart.agent_leaks", AGENT_LEAKS_SQL),
    ("mart.matchups", MATCHUPS_SQL),
    ("mart.season_summary", SEASON_SUMMARY_SQL),
    ("mart.hands_over_time", HANDS_OVER_TIME_SQL),
    ("mart.rank_history", RANK_HISTORY_SQL),
    ("mart.agent_daily_performance", AGENT_DAILY_PERFORMANCE_SQL),
]

# ---------------------------------------------------------------------------
# QA (PRD §9): violations make the run exit non-zero (data stays committed).
# ---------------------------------------------------------------------------

QA_CHECKS = [
    ("zero_sum_hand", """
        SELECT count(*) FROM (
            SELECT hand_id FROM stg.hand_seats
            GROUP BY hand_id HAVING sum(chip_delta) <> 0) x"""),
    ("two_seats_per_hand", """
        SELECT count(*) FROM (
            SELECT hand_id FROM stg.hand_seats
            GROUP BY hand_id HAVING count(*) <> 2) x"""),
    ("duplicate_orientation", """
        SELECT count(*) FROM (
            SELECT mirror_pair_id FROM stg.hands
            GROUP BY mirror_pair_id, orientation HAVING count(*) > 1) x"""),
    ("pair_has_two_agents", """
        SELECT count(*) FROM (
            SELECT h.mirror_pair_id FROM stg.hands h
            JOIN stg.hand_seats s USING (hand_id)
            GROUP BY h.mirror_pair_id
            HAVING count(DISTINCT s.agent_id) <> 2) x"""),
    ("committed_reconciles", """
        SELECT count(*) FROM (
            SELECT s.hand_id, s.seat_number
            FROM stg.hand_seats s
            JOIN stg.hands h USING (hand_id)
            LEFT JOIN stg.actions a
                   ON a.hand_id = s.hand_id AND a.actor_seat_number = s.seat_number
            GROUP BY s.hand_id, s.seat_number, s.total_committed_chips,
                     s.posted_blind, h.small_blind_chips, h.big_blind_chips
            HAVING s.total_committed_chips <>
                   COALESCE(sum(a.invested_chips), 0)
                   + CASE s.posted_blind
                       WHEN 'small' THEN COALESCE(h.small_blind_chips, 0)
                       WHEN 'big'   THEN COALESCE(h.big_blind_chips, 0)
                       ELSE 0 END) x"""),
    ("mirror_deck_identity", """
        SELECT count(*) FROM int.mirror_pairs p
        JOIN stg.hands h1 ON h1.hand_id = p.hand_id_o1
        JOIN stg.hands h2 ON h2.hand_id = p.hand_id_o2
        WHERE p.is_complete AND (
            (h1.board_len >= 3 AND h2.board_len >= 3
             AND h1.board_cards[1:3] <> h2.board_cards[1:3])
            OR EXISTS (
                SELECT 1 FROM stg.hand_seats s1
                JOIN stg.hand_seats s2 ON s2.hand_id = p.hand_id_o2
                                      AND s2.seat_number = s1.seat_number
                WHERE s1.hand_id = p.hand_id_o1
                  AND NOT (s1.hole_cards @> s2.hole_cards
                           AND s1.hole_cards <@ s2.hole_cards)))"""),
    ("ev_equals_result_when_no_allin", """
        SELECT count(*) FROM int.hand_equity e
        JOIN stg.hand_seats s USING (hand_id, seat_number)
        WHERE NOT e.went_all_in AND e.ev_result_bb <> s.result_bb"""),
]

QA_INFO = [
    ("pairs_total", "SELECT count(*) FROM int.mirror_pairs"),
    ("pairs_complete", "SELECT count(*) FROM int.mirror_pairs WHERE is_complete"),
    ("max_hand_number", "SELECT COALESCE(max(hand_number), 0) FROM stg.hands"),
    ("blocks_at_200", """
        SELECT count(*) FROM (
            SELECT block_id FROM stg.hands
            GROUP BY block_id HAVING max(hand_number) = 200) x"""),
    ("hands_at_cap_201plus", """
        SELECT count(*) FROM stg.hands WHERE hand_number > 200"""),
]


# ===========================================================================
# Runner
# ===========================================================================

class Config:
    def __init__(self, args):
        self.db_url = args.db_url or os.environ.get("ARENA_RAW_DB_URL", "")
        self.batch_size = args.batch_size or int(os.environ.get("ARENA_TRANSFORM_BATCH", "200"))
        self.mc_samples = args.mc_samples or int(os.environ.get("ARENA_EQ_MC_SAMPLES", "10000"))
        self.limit = args.limit

    def require_db(self):
        if not self.db_url:
            sys.exit("ARENA_RAW_DB_URL is not set (env, .env, or --db-url).")
        return self.db_url


# Single-instance guard — see the twin comment in arena_etl.py. Two concurrent
# transforms would walk the same replays and contend on every mart rebuild.
# Different key from the loader: loader-vs-transform overlap is safe and normal
# (the transform only reads raw.*), transform-vs-transform is not.
ADVISORY_LOCK = (4711, 2)  # arena_etl.py uses (4711, 1)


def try_advisory_lock(conn, classid: int, objid: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s, %s)", (classid, objid))
        return cur.fetchone()[0]


def ensure_schema(conn):
    path = SCRIPT_DIR / "schema_analytics.sql"
    if not path.exists():
        sys.exit(f"schema_analytics.sql not found next to the script ({path})")
    with conn.cursor() as cur:
        cur.execute(path.read_text())
    conn.commit()


def get_watermark(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT watermark, detail FROM stg.transform_state WHERE step = %s",
                    (WALK_STEP,))
        row = cur.fetchone()
    if not row or row[0] is None:
        return datetime(1970, 1, 1, tzinfo=timezone.utc), ""
    return row[0], (row[1] or {}).get("last_table_id", "")


def set_state(conn, step, watermark, last_table_id, status, detail):
    detail = dict(detail or {})
    if last_table_id is not None:
        detail["last_table_id"] = last_table_id
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO stg.transform_state (step, watermark, last_run_at, last_status, detail)
            VALUES (%s, %s, now(), %s, %s)
            ON CONFLICT (step) DO UPDATE SET
                watermark = COALESCE(EXCLUDED.watermark, stg.transform_state.watermark),
                last_run_at = EXCLUDED.last_run_at,
                last_status = EXCLUDED.last_status,
                detail = EXCLUDED.detail
        """, (step, watermark, status, Jsonb(detail)))


def step_walk(conn, cfg, engine):
    """Flatten new raw.replays into stg/int rows, batch by batch."""
    wm_ts, wm_id = get_watermark(conn)
    stats = {"replays": 0, "hands": 0, "skips": {}, "errors": 0}
    processed = 0
    t_start = time.time()

    while True:
        limit = cfg.batch_size
        if cfg.limit:
            limit = min(limit, cfg.limit - processed)
            if limit <= 0:
                break
        with conn.cursor() as cur:
            cur.execute("""
                SELECT table_id, payload, fetched_at FROM raw.replays
                WHERE (fetched_at, table_id) > (%s, %s)
                ORDER BY fetched_at, table_id LIMIT %s
            """, (wm_ts, wm_id, limit))
            rows = cur.fetchall()
        if not rows:
            break

        batch = {k: [] for k in UPSERT_ORDER}
        for table_id, payload, fetched_at in rows:
            stats["replays"] += 1
            try:
                out = walk_replay(payload, engine)
            except SkipReplay as skip:
                reason = str(skip)
                stats["skips"][reason] = stats["skips"].get(reason, 0) + 1
                continue
            except Exception:
                stats["errors"] += 1
                log.exception("walker failed on %s", table_id)
                continue
            for key in UPSERT_ORDER:
                batch[key].extend(out.get(key, []))
            stats["hands"] += 1

        with conn.cursor() as cur:
            for key in UPSERT_ORDER:
                if batch[key]:
                    cur.executemany(UPSERTS[key], batch[key])
            if engine.dirty:
                cur.executemany(EQUITY_CACHE_UPSERT,
                                [(k, eq, ex) for k, (eq, ex) in engine.dirty.items()])
                engine.dirty.clear()
        wm_ts, wm_id = rows[-1][2], rows[-1][0]
        set_state(conn, WALK_STEP, wm_ts, wm_id, "running", stats)
        conn.commit()
        processed += len(rows)
        log.info("walk: %d replays processed (%d hands, %d skips, %.0f/s)",
                 stats["replays"], stats["hands"], sum(stats["skips"].values()),
                 stats["replays"] / max(time.time() - t_start, 0.001))

    set_state(conn, WALK_STEP, wm_ts, wm_id, "ok", stats)
    conn.commit()
    log.info("walk done: %s", stats)
    return stats


def step_tier23(conn, ts0):
    """Mirror pairs + all marts. ts0 scopes the incremental hand marts."""
    with conn.cursor() as cur:
        cur.execute(MIRROR_PAIRS_SQL, {"ts0": ts0})
        log.info("mirror_pairs: %d upserted", cur.rowcount)
        cur.execute(HAND_HEADER_SQL, {"ts0": ts0})
        log.info("hand_header: %d upserted", cur.rowcount)
        cur.execute(HAND_STEP_SQL, {"ts0": ts0})
        log.info("hand_step: %d upserted", cur.rowcount)
        cur.execute("SELECT DISTINCT competition_id FROM stg.hands")
        comps = [r[0] for r in cur.fetchall()]
        for cid in comps:
            for table, sql in MART_REBUILDS:
                cur.execute(f"DELETE FROM {table} WHERE competition_id = %(cid)s",
                            {"cid": cid})
                cur.execute(sql, {"cid": cid})
                log.info("%s[%s]: %d rows", table, cid, cur.rowcount)
    conn.commit()


def step_qa(conn):
    violations, info = {}, {}
    with conn.cursor() as cur:
        for name, sql in QA_CHECKS:
            cur.execute(sql)
            n = cur.fetchone()[0]
            if n:
                violations[name] = n
                log.error("QA VIOLATION %s: %d rows", name, n)
        for name, sql in QA_INFO:
            cur.execute(sql)
            info[name] = cur.fetchone()[0]
    detail = {"violations": violations, "info": info}
    set_state(conn, "qa", None, None,
              "ok" if not violations else f"violations:{len(violations)}", detail)
    conn.commit()
    log.info("QA: %s", detail)
    return violations


TRUNCATE_TABLES = [
    "stg.hands", "stg.hand_seats", "stg.actions",
    "int.mirror_pairs", "int.hand_equity", "int.action_equity",
    "int.board_texture", "int.hand_features", "int.hand_street_lines",
    "mart.hand_header", "mart.hand_step", "mart.leaderboard",
    "mart.agent_stats", "mart.agent_leaks", "mart.matchups",
    "mart.season_summary", "mart.hands_over_time", "mart.rank_history",
    "mart.agent_daily_performance",
]


def cmd_run(conn, cfg):
    engine = holdem.EquityEngine(cfg.mc_samples)
    with conn.cursor() as cur:
        cur.execute("SELECT cache_key, equity, is_exact FROM int.equity_cache")
        engine.preload(cur.fetchall())
        cur.execute("SELECT now()")
        ts0 = cur.fetchone()[0]
    log.info("equity cache preloaded: %d entries", len(engine._cache))
    step_walk(conn, cfg, engine)
    step_tier23(conn, ts0)
    violations = step_qa(conn)
    print_status(conn)
    return 1 if violations else 0


def cmd_rebuild(conn, cfg):
    log.warning("rebuild: truncating stg/int/mart (equity cache kept) ...")
    with conn.cursor() as cur:
        cur.execute("TRUNCATE " + ", ".join(TRUNCATE_TABLES))
        cur.execute("DELETE FROM stg.transform_state WHERE step = %s", (WALK_STEP,))
    conn.commit()
    return cmd_run(conn, cfg)


def print_status(conn):
    tables = ["stg.hands", "stg.hand_seats", "stg.actions", "int.mirror_pairs",
              "int.hand_equity", "int.action_equity", "int.board_texture",
              "int.hand_features", "int.hand_street_lines", "int.equity_cache",
              "mart.leaderboard", "mart.agent_stats", "mart.agent_leaks",
              "mart.hand_header", "mart.hand_step", "mart.matchups",
              "mart.season_summary", "mart.hands_over_time", "mart.rank_history",
              "mart.agent_daily_performance"]
    with conn.cursor() as cur:
        print(f"{'table':<28} {'rows':>10}")
        for t in tables:
            cur.execute(f"SELECT count(*) FROM {t}")
            print(f"{t:<28} {cur.fetchone()[0]:>10}")
        cur.execute("""
            SELECT (SELECT count(*) FROM raw.replays) -
                   (SELECT count(*) FROM stg.hands)""")
        print(f"\nreplays not yet in stg.hands (incl. skips): {cur.fetchone()[0]}")
        cur.execute("SELECT step, watermark, last_run_at, last_status, detail "
                    "FROM stg.transform_state ORDER BY step")
        for step, wm, run_at, status, detail in cur.fetchall():
            print(f"\n{step}: watermark={wm} last_run={run_at} status={status}")
            if detail:
                print(f"  {json.dumps(detail, default=str)[:500]}")


def cmd_selftest():
    holdem._selftest()
    sample = SCRIPT_DIR / "samples" / "replay.json"
    payload = json.loads(sample.read_text())["result"]["data"]["json"]
    engine = holdem.EquityEngine(mc_samples=2000)
    out = walk_replay(payload, engine)

    hand = out["hands"][0]
    assert hand["block_id"] == "cmrluyx4tzramst8n4h47qey1", hand["block_id"]
    assert hand["hand_number"] == 142 and hand["orientation"] == 2
    assert hand["went_to_showdown"] is False
    assert hand["street_reached"] == "River"
    assert hand["pot_final_chips"] == 426

    seats = {r["seat_number"]: r for r in out["hand_seats"]}
    assert seats[1]["is_button"] and seats[1]["posted_blind"] == "small"
    assert seats[2]["posted_blind"] == "big"

    acts = out["actions"]
    assert len(acts) == 10
    inv = {1: 0, 2: 0}
    for a in acts:
        inv[a["actor_seat_number"]] += a["invested_chips"]
    assert inv[1] == 218 - 5 and inv[2] == 208 - 10, inv   # committed minus blind

    feats = {f["seat_number"]: f for f in out["features"]}
    assert feats[2]["was_preflop_aggressor"] and feats[2]["pfr"]
    assert feats[2]["cbet_flop"] and feats[2]["cbet_turn"] and not feats[2]["cbet_river"]
    assert feats[1]["vpip"] and not feats[1]["pfr"]
    assert feats[1]["faced_cbet_flop"] and not feats[1]["folded_to_cbet_flop"]
    assert feats[2]["check_raise_opp"] and not feats[2]["check_raised"]
    assert not feats[1]["wtsd"] and feats[1]["won_hand"] and feats[1]["wwsf"]

    lines = {(r["seat_number"], r["street"]): r["line"] for r in out["lines"]}
    assert lines[(1, "Preflop")] == "limp_call", lines
    assert lines[(2, "Preflop")] == "raise_vs_limp", lines
    assert lines[(2, "Flop")] == "cbet" and lines[(1, "Flop")] == "call_vs_cbet"
    assert lines[(2, "Turn")] == "double_barrel" and lines[(1, "Turn")] == "call_vs_barrel2"
    assert lines[(2, "River")] == "check_fold" and lines[(1, "River")] == "stab"

    eq = {r["seat_number"]: r for r in out["hand_equity"]}
    assert not eq[1]["went_all_in"] and eq[1]["ev_result_bb"] == 20.8
    assert eq[2]["ev_result_bb"] == -20.8
    assert len(out["action_equity"]) == 10
    tex = out["textures"][0]
    assert tex["flop_texture_class"] in ("dry", "semi_wet", "wet")
    print("arena_transform.py selftest OK "
          f"(lines={sorted(set(lines.values()))}, texture={tex['flop_texture_class']})")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["init-db", "run", "rebuild", "status", "selftest"])
    parser.add_argument("--db-url", help="Postgres DSN (default: $ARENA_RAW_DB_URL)")
    parser.add_argument("--limit", type=int, default=0,
                        help="process at most N new replays (testing)")
    parser.add_argument("--batch-size", type=int, default=0)
    parser.add_argument("--mc-samples", type=int, default=0,
                        help="Monte Carlo samples for preflop equity (default 10000)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s", stream=sys.stdout)

    try:
        from dotenv import load_dotenv
        load_dotenv(SCRIPT_DIR / ".env")
        load_dotenv()
    except ImportError:
        pass

    if args.command == "selftest":
        cmd_selftest()
        return 0

    cfg = Config(args)
    conn = psycopg.connect(cfg.require_db())
    try:
        if args.command != "status" and not try_advisory_lock(conn, *ADVISORY_LOCK):
            log.warning("another arena_transform.py run holds the lock — skipping this run")
            return 0
        ensure_schema(conn)
        if args.command == "init-db":
            log.info("schema applied (stg/int/mart)")
            return 0
        if args.command == "run":
            return cmd_run(conn, cfg)
        if args.command == "rebuild":
            return cmd_rebuild(conn, cfg)
        if args.command == "status":
            print_status(conn)
            return 0
        return 2
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
