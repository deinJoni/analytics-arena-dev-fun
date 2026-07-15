"""Heads-up Texas Hold'em card math for the Arena analytics transform.

Everything card-shaped lives here so arena_transform.py stays orchestration:
  * exact hand-vs-hand equity by full board enumeration (phevaluator),
  * deterministic-seed Monte Carlo for the expensive preflop case,
  * suit-isomorphism canonical cache keys (mirror partners and common
    matchups collapse onto one key),
  * flop texture classification (int.board_texture).

Both hole cards are always face-up in this dataset, so "equity" is always
vs the opponent's ACTUAL hand — exact and cheap for HU. phevaluator ranks:
LOWER value = STRONGER hand.

Self-test: `python holdem.py` (or `uv run --with phevaluator holdem.py`).
"""

from __future__ import annotations

import itertools
import random
import zlib

from phevaluator import evaluate_cards

RANKS = "23456789TJQKA"                    # index 0..12 -> rank value 2..14
SUITS = "cdhs"
FULL_DECK = tuple(r + s for r in RANKS for s in SUITS)
RANK_VALUE = {r: i + 2 for i, r in enumerate(RANKS)}
_SUIT_PERMS = [dict(zip(SUITS, p)) for p in itertools.permutations(SUITS)]

# Monte Carlo sample count for preflop per-decision equity (SE ~ 0.5% at 10k).
MC_SAMPLES_DEFAULT = 10_000


def norm_card(card: str) -> str:
    """API cards arrive as e.g. '6h', 'Ts', 'Kd' — normalise defensively."""
    if len(card) != 2:
        raise ValueError(f"bad card {card!r}")
    c = card[0].upper() + card[1].lower()
    if c[0] not in RANKS or c[1] not in SUITS:
        raise ValueError(f"bad card {card!r}")
    return c


def canonical_key(hero: list[str], villain: list[str], board: list[str]) -> str:
    """Suit-isomorphism-canonical form of (hero, villain, board).

    Applies all 24 suit permutations, sorts each group, and keeps the
    lexicographically smallest rendering — so e.g. AhAs-vs-KhKs and
    AdAc-vs-KdKc share one cache entry."""
    best = None
    for perm in _SUIT_PERMS:
        h = sorted(c[0] + perm[c[1]] for c in hero)
        v = sorted(c[0] + perm[c[1]] for c in villain)
        b = sorted(c[0] + perm[c[1]] for c in board)
        key = "".join(h) + "|" + "".join(v) + "|" + "".join(b)
        if best is None or key < best:
            best = key
    return best


def _score(wins_hero: int, ties: int, total: int) -> float:
    return (wins_hero + ties / 2.0) / total


def equity_exact(hero: list[str], villain: list[str], board: list[str]) -> float:
    """Hero's exact equity vs villain by enumerating every runout.

    Cost: preflop C(48,5)=1.7M runouts (~seconds — cache it); flop 990;
    turn 44; river = a single showdown compare."""
    dead = set(hero) | set(villain) | set(board)
    remaining = [c for c in FULL_DECK if c not in dead]
    need = 5 - len(board)
    wins = ties = total = 0
    for extra in itertools.combinations(remaining, need):
        full = list(board) + list(extra)
        rh = evaluate_cards(*hero, *full)
        rv = evaluate_cards(*villain, *full)
        if rh < rv:
            wins += 1
        elif rh == rv:
            ties += 1
        total += 1
    return _score(wins, ties, total)


def equity_mc(hero: list[str], villain: list[str], board: list[str],
              samples: int = MC_SAMPLES_DEFAULT) -> float:
    """Monte Carlo equity with a DETERMINISTIC seed derived from the canonical
    key, so re-runs are idempotent (same inputs -> bit-identical output)."""
    key = canonical_key(hero, villain, board)
    rng = random.Random(zlib.crc32(key.encode()))
    dead = set(hero) | set(villain) | set(board)
    remaining = [c for c in FULL_DECK if c not in dead]
    need = 5 - len(board)
    wins = ties = 0
    for _ in range(samples):
        extra = rng.sample(remaining, need)
        full = list(board) + extra
        rh = evaluate_cards(*hero, *full)
        rv = evaluate_cards(*villain, *full)
        if rh < rv:
            wins += 1
        elif rh == rv:
            ties += 1
    return _score(wins, ties, samples)


class EquityEngine:
    """Equity with a two-level cache: an in-memory dict for this run, and
    (optionally, via preload()/dirty) the persistent int.equity_cache table.

    Only preflop results are cached — postflop enumeration is cheaper than a
    cache round-trip. Exact entries overwrite Monte Carlo ones, never the
    reverse."""

    def __init__(self, mc_samples: int = MC_SAMPLES_DEFAULT):
        self.mc_samples = mc_samples
        self._cache: dict[str, tuple[float, bool]] = {}
        self.dirty: dict[str, tuple[float, bool]] = {}   # new/upgraded entries to persist

    def preload(self, rows: list[tuple[str, float, bool]]) -> None:
        for key, eq, is_exact in rows:
            self._cache[key] = (float(eq), bool(is_exact))

    def equity(self, hero: list[str], villain: list[str], board: list[str],
               need_exact: bool = False) -> tuple[float, bool]:
        """Returns (hero equity, is_exact). need_exact forces enumeration
        (used for all-in EV, PRD §6.2); otherwise preflop uses seeded MC."""
        hero = [norm_card(c) for c in hero]
        villain = [norm_card(c) for c in villain]
        board = [norm_card(c) for c in board]

        if len(board) >= 3:                       # flop/turn/river: always exact, not cached
            return equity_exact(hero, villain, board), True

        if len(board) != 0:
            raise ValueError(f"unexpected board length {len(board)}")

        key = canonical_key(hero, villain, board)
        hit = self._cache.get(key)
        if hit is not None and (hit[1] or not need_exact):
            return hit

        if need_exact:
            eq, is_exact = equity_exact(hero, villain, board), True
        else:
            eq, is_exact = equity_mc(hero, villain, board, self.mc_samples), False
        self._cache[key] = (eq, is_exact)
        self.dirty[key] = (eq, is_exact)
        return eq, is_exact


# ---------------------------------------------------------------------------
# Flop texture (int.board_texture) — PRD §6.3, flop-based for v1
# ---------------------------------------------------------------------------

def classify_flop(board: list[str]) -> dict:
    """Texture flags + a dry/semi_wet/wet class for the first 3 board cards."""
    flop = [norm_card(c) for c in board[:3]]
    ranks = sorted((RANK_VALUE[c[0]] for c in flop), reverse=True)
    suits = [c[1] for c in flop]
    n_suits = len(set(suits))

    is_paired = len(set(ranks)) < 3
    is_monotone = n_suits == 1
    is_two_tone = n_suits == 2
    is_rainbow = n_suits == 3
    # "straighty": 3 distinct ranks packed inside a 5-card straight window,
    # counting the ace as low for wheel boards (A-2-3, A-3-4, ...).
    spans = [ranks[0] - ranks[2]]
    if ranks[0] == 14:
        low = sorted([1, ranks[1], ranks[2]], reverse=True)
        spans.append(low[0] - low[2])
    is_connected = (not is_paired) and min(spans) <= 4

    score = (2 if is_monotone else 0) + (1 if is_two_tone else 0) + (2 if is_connected else 0)
    texture = "wet" if score >= 3 else ("semi_wet" if score >= 1 else "dry")
    return {
        "is_paired": is_paired,
        "is_monotone": is_monotone,
        "is_two_tone": is_two_tone,
        "is_rainbow": is_rainbow,
        "is_connected": is_connected,
        "high_card_rank": ranks[0],
        "flop_texture_class": texture,
    }


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def _selftest() -> None:
    # Exact symmetry: AsKs vs AhKh is suit-isomorphic to its own swap -> 0.5.
    eq = equity_exact(["As", "Ks"], ["Ah", "Kh"], [])
    assert abs(eq - 0.5) < 1e-12, eq
    # Locked hand: royal flush on the flop never loses.
    assert equity_exact(["As", "Ks"], ["2h", "2d"], ["Qs", "Js", "Ts"]) == 1.0
    # Full-board tie: both play the board straight (rainbow, no flush possible).
    assert equity_exact(["2h", "3h"], ["2d", "3d"], ["As", "Kd", "Qh", "Jc", "Tc"]) == 0.5
    # Canonicalization collapses suit-isomorphic matchups.
    assert canonical_key(["Ah", "As"], ["Kh", "Ks"], []) == \
           canonical_key(["Ad", "Ac"], ["Kd", "Kc"], [])
    # MC determinism + agreement with exact on AhAs vs KhKs (0.8264 — the
    # both-suits-shared case, where KK's flush outs are minimal).
    mc1 = equity_mc(["Ah", "As"], ["Kh", "Ks"], [], samples=40_000)
    mc2 = equity_mc(["Ah", "As"], ["Kh", "Ks"], [], samples=40_000)
    assert mc1 == mc2, "MC must be deterministic"
    ex = equity_exact(["Ah", "As"], ["Kh", "Ks"], [])
    assert abs(ex - 0.8264) < 0.002, ex
    assert abs(mc1 - ex) < 0.02, (mc1, ex)
    # Engine cache: second preflop call is a hit; exact upgrade sticks.
    eng = EquityEngine(mc_samples=2_000)
    e1, x1 = eng.equity(["Ah", "As"], ["Kh", "Ks"], [])
    e2, _ = eng.equity(["Ad", "Ac"], ["Kd", "Kc"], [])          # isomorphic -> cache hit
    assert e1 == e2 and not x1
    e3, x3 = eng.equity(["Ah", "As"], ["Kh", "Ks"], [], need_exact=True)
    assert x3 and abs(e3 - ex) < 1e-12
    # Texture spot checks.
    assert classify_flop(["Kd", "7s", "2h"])["flop_texture_class"] == "dry"
    assert classify_flop(["9h", "8h", "7h"])["flop_texture_class"] == "wet"
    assert classify_flop(["Kh", "7h", "2s"])["flop_texture_class"] == "semi_wet"
    assert classify_flop(["Ah", "2s", "3d"])["is_connected"] is True   # wheel
    assert classify_flop(["Kd", "Ks", "2h"])["is_paired"] is True
    print("holdem.py selftest OK "
          f"(AAvKK exact={ex:.4f}, mc={mc1:.4f})")


if __name__ == "__main__":
    _selftest()
