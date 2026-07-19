# Analytics layer — `stg` / `int` / `mart` documentation

What Stage 2 (`arena_transform.py`) builds on top of the `raw` schema, and what
the app may rely on. Companion to [`SCHEMA.md`](SCHEMA.md) (raw layer) and
implementation of [`PRD_analytics_etl.md`](PRD_analytics_etl.md). The DDL
source of truth is [`schema_analytics.sql`](schema_analytics.sql) (idempotent,
auto-applied on every run); the same docs live in-database via `COMMENT ON`.

Verified end-to-end against a 1,218-hand live sample on **2026-07-15**
(0 walker errors, 0 QA violations).

## The one idea everything hangs off: mirror pairs

The ladder plays **duplicate poker**. Each hand's `Joined` events carry
`sandboxPvpBlockId` (one fixed A-vs-B head-to-head session) and
`sandboxPvpHandNumber` (1-indexed). Consecutive odd/even hand numbers are the
**same deck played twice**: hole cards stay glued to the *seat*, the two agents
swap seats, the dealer button stays on seat 1.

```
mirror_pair_id = block_id || ':' || ceil(hand_number / 2.0)
orientation    = 1 (odd, first-dealt) | 2 (even, mirror)
```

Across a completed pair each agent has played both sides of the identical deck,
so **card and button luck cancel by construction** — `skill_delta_bb` on
`int.mirror_pairs` is a direct luck-neutralized skill readout. Pair by the key
above, **never** by adjacency (partners lag up to minutes / ~600 table numbers)
and never by board equality (preflop folds leave partial boards; the sample
contains pairs where one orientation shows a 5-card board and the other an
empty one).

## Pipeline

```
raw.replays ──(Python walker, per hand)──► stg.hands / stg.hand_seats / stg.actions
                                           int.board_texture / int.hand_features
                                           int.hand_street_lines / int.hand_equity
                                           int.action_equity          [equity: holdem.py]
stg.* ──(SQL, set-based)──► int.mirror_pairs (+ int.pair_agent view)
stg/int ──(SQL)──► mart.hand_header / mart.hand_step         (incremental)
                   mart.leaderboard / mart.season_summary /
                   mart.hands_over_time / mart.rank_history /
                   mart.agent_stats / mart.agent_leaks /
                   mart.matchups / mart.agent_daily_performance
                                                            (full rebuild per run)
```

* **Incremental**: the walker processes `raw.replays` with
  `(fetched_at, table_id)` past the watermark in `stg.transform_state`,
  in batches (one commit per batch — killed runs resume mid-walk). Everything
  is `INSERT … ON CONFLICT DO UPDATE` on stable natural keys; re-runs are no-ops.
* **Open blocks**: `int.mirror_pairs` recomputes every block touched this run
  *plus* every still-incomplete pair, so a pair flips to `is_complete` whenever
  the partner hand lands. Incomplete pairs are **excluded from all
  duplicate-adjusted metrics** (their `*_pair_bb` stay NULL).
* **QA gate**: after every run, structural checks run (zero-sum per hand,
  2 seats per hand, one hand per orientation, chip-commitment reconciliation
  action-by-action, mirror deck identity, EV-identity for non-all-in hands).
  Violations are logged, stored in `stg.transform_state(step='qa')`, and make
  the run exit 1 so systemd/cron alerts — data stays committed.

## Tier 1 — `stg`

### `stg.hands` — one row per hand
Everything hand-level from the replay: mirror keys (+ generated
`mirror_pair_id`), `dealer_seat_number` (observed always 1), final board,
`street_reached` (street of the closing fold, or `Showdown` when contested),
`went_to_showdown`, `pot_final_chips` (= Σ both seats' committed = Σ payouts;
rake-free, QA-checked), blind/buy-in sizes, timestamps.

### `stg.hand_seats` — one row per (hand, seat); 2 per hand
Agent identity, `hole_cards` (always face-up in this dataset), button/position
flags (HU: button = small blind = in position postflop), commitments, payouts,
generated `chip_delta` and `result_bb` (= chips/10; every hand is a fresh
1000-chip 100bb buy-in, so bb/100 has no stack-depth confounder).

### `stg.actions` — one row per `ActionTaken` event
Enriched by the walker using the replay's event `snapshot`s (a snapshot is the
state *after* its event; the *facing* state comes from the previous event's
snapshot):

* `invested_chips` = `payload.stackBefore` − post-snapshot stack — exact
  incremental chips of the action (QA-reconciled against `totalCommittedChips`
  for every seat of every hand).
* `pot_before` = `payload.pot`, `pot_after` = post-snapshot pot,
  `current_bet_before` / `min_raise_to_before` = previous snapshot.
* `size_bb`, `size_pot_fraction` (= invested / pot_before) for bets/raises.
* `reasoning_text` = the substring after `Strategy note:` in `message`
  (the native `reasoning` field is null platform-wide; never read it).
  `message_raw` kept verbatim; `bot_self_reported_eq` parses `eq=0.392`-style
  prose (NOT ground truth — in the sample it correlates only ~0.47 with real
  equity, which is itself a fun leak signal).

## Tier 2 — `int`

### `int.mirror_pairs` + `int.pair_agent` — the spine
One row per mirror pair; `agent_a_id` = canonical `least(agent_id)` so a
matchup has one direction; `skill_delta_bb = agent_a_pair_bb`
(zero-sum: `agent_b_pair_bb = −agent_a_pair_bb`). `int.pair_agent` is the
long-form view (one row per pair × agent) for aggregation.

### `int.hand_equity` — all-in EV adjustment (the Python step)
When betting closed all-in **before the river** (detected as: contested
showdown whose last action street < River — checks are events too, so this is
exact), the realized result is replaced by
`equity × final_pot − committed` (bb). Equity is **exact by enumeration**
vs the actual opponent hand on the board-so-far (`holdem.py`, phevaluator).
Otherwise `ev_result_bb = result_bb` (QA-enforced identity).

### `int.action_equity` — per-decision equity for the replayer
Omniscient (uses the opponent's real cards): a fair post-hoc "how strong was
this actually" readout, **not** a decision-quality/GTO score. Computed once
per (hand, street) — equity only changes when the board does — and fanned out
to actions. Flop/turn/river are exact by enumeration (990 / 44 / 1 runouts);
**preflop uses deterministic-seed Monte Carlo** (`is_exact = false`,
`ARENA_EQ_MC_SAMPLES` default 10k ⇒ SE ≈ 0.5%) because exact preflop is
C(48,5) ≈ 1.7M runouts (~5 s). Same inputs ⇒ bit-identical outputs, so re-runs
stay idempotent. Preflop *all-in* hands are upgraded to exact via
`int.hand_equity`'s computation (shared cache).

### `int.equity_cache` — persistent preflop cache
Keyed by a suit-isomorphism-canonical form of (hero, villain, board) — all 24
suit permutations, lexicographically smallest — so mirror partners and
recurring matchups collapse onto one entry. Exact entries are never
downgraded to MC. Effect measured on the sample: cold walk 26 hands/s, warm
rebuild of the same 1,218 hands in ~3 s. Survives `rebuild`.

### `int.board_texture` — flop-based texture per hand
`is_paired/monotone/two_tone/rainbow/connected` (wheel-aware),
`high_card_rank`, and `flop_texture_class`: monotone +2, two-tone +1,
connected (3 distinct ranks inside a 5-rank window) +2 → `wet` ≥ 3,
`semi_wet` ≥ 1, else `dry`. Only for hands that saw a flop.

### `int.hand_features` — the stat feeder
Classic HU flags per (hand, seat), each rate stat paired with its `_opp`
opportunity flag so mart denominators are honest: VPIP (BB checking its option
is not voluntary), PFR, 3bet (BB post = 1-bet, open = 2-bet), fold-to-3bet,
c-bet flop/turn/river (= single/double/triple barrel, opportunity = aggressor
with a no-bet-facing decision), check-raise (+ opportunity = checked then
faced a bet), WTSD/W$SD/WWSF, won_hand, and postflop action counters for
AF/AFq. An `all-in` action counts by what it *did to the price*: as a bet or
raise when it raised, as a call when it just called (the raw label is kept on
`stg.actions.is_aggressive` per PRD).

### `int.hand_street_lines` — one line label per (hand, seat, street)
Extension beyond the PRD's table list; feeds `mart.agent_leaks` bucketing and
the mirror-divergence attribution. Taxonomy (v1, deliberately compact):

* **Preflop, button**: `fold` · `limp[_fold|_call|_raise]` ·
  `open[_fold|_call]` · `4bet`
* **Preflop, BB**: `bb_check` · `fold_vs_open` · `fold_vs_limp` ·
  `call_vs_open` · `3bet[_fold|_call|_raise]` · `raise_vs_limp[...]`
* **Postflop first-in bet**: with initiative `cbet` / `double_barrel` /
  `triple_barrel` (intact barrel chain) or `delayed_cbet`; without initiative
  `donk` (flop, OOP), `probe` (turn/river, OOP), `stab` (IP after a check);
  all with `[_fold|_call|_raise]` suffixes when raised.
* **Checked first**: `check_through` · `check_call` · `check_fold` ·
  `check_raise`.
* **Facing a bet without checking**: `call_vs_{cbet|barrel2|barrel3|bet}`,
  `fold_vs_…`, `raise_vs_…`.
* `no_action` appears only in divergence attribution (seat never got to act,
  e.g. BB after a button open-fold).

## Tier 3 — `mart` (the five views)

| View | Tables | Notes |
|---|---|---|
| 0 Overview | `leaderboard`, `season_summary`, `hands_over_time`, `rank_history` | raw / dup-adj / EV-adj bb/100 side by side; **`rank` = position by `total_score` DESC** (the arena.dev.fun ordering — the API's own `rank` field is a *global* dev.fun rank across all arenas, so it is recomputed here); `trueskill_mu` = roster `totalScore` (no sigma → NULL); 7d deltas from `raw.leaderboard_history` (needs polling coverage). `rank_history` = the same position through time (per-snapshot, full board carried-forward) for the Overview drill-down. Only agents with observed hands appear. |
| 1 Agent dashboard | `agent_stats`, `agent_daily_performance` | `agent_stats`: grain (competition, agent, position ∈ IP/OOP/ALL). Every rate's true denominator is in `opportunities` (jsonb) — **the UI must grey thin splits**. Sizing histogram buckets: %-of-pot 0-33 / 33-66 / 66-100 / 100+. AF = (bets+raises)/calls, AFq = aggr/(aggr+calls+folds), both postflop. `agent_daily_performance`: the "Trends" sparkline feeder — see below. |
| 2 Leak map | `agent_leaks` | grain (competition, agent, position, street, texture, line); texture `'na'` for preflop (a PK can't hold NULL). `bb_per_100_spot`/`ev_bb_per_100_spot` = whole-hand result over hands where the agent took that line. **`mirror_delta_bb`** = avg (own result − counterpart's result on the identical deck) × 100 over deck-sides whose *first line divergence* was this spot, with `mirror_n` as its sample size. |
| 3 Replayer | `hand_header`, `hand_step` | `mirror_hand_id` links the identical-deck partner for side-by-side diffing. Steps carry pot/stack/board from event snapshots (no re-simulation), omniscient `equity_at_decision`, parsed `reasoning_text` (63% of sample actions carry a strategy note). |
| 4 Head-to-head | `matchups` | both directions materialized; the block *is* the matchup. `spot_deltas` = top ±3 mirror-delta spots vs that specific opponent. |

**Trends mart (`mart.agent_daily_performance`)** — grain (competition, agent,
UTC day). Cumulative `hands_cum`, `raw_bb100_cum`, `dup_adj_bb100_cum`,
`ev_adj_bb100_cum` per agent, built from the **same source definitions as
`mart.leaderboard`** (raw = `avg(result_bb)` over `stg.hand_seats`, dup-adj =
`sum(pair_bb)/(2·pairs)` over *completed* `int.pair_agent` pairs, ev-adj =
`avg(ev_result_bb)` over `int.hand_equity`), so each agent's final day equals
their leaderboard row. `dup_adj_bb100_cum` is NULL until the first completed
mirror pair (same NULL handling as the leaderboard: NULLIF on a zero
denominator). Days are bucketed in UTC explicitly so the grain is stable
across deploys. Fully retroactive (stg/int carry per-hand and per-pair
timestamps) and rebuilt in full every run — no backfill needed. Score/rank
trajectories are **not** here; they stay in `mart.rank_history`. Read path:
`app_readonly` is granted SELECT on all of `mart.*` (re-applied by
`ensure_schema` on every run, plus `ALTER DEFAULT PRIVILEGES` from
`db/role_app_readonly.sql`), so the FE sees the table as soon as the next
transform run creates it — until then the API degrades to an empty series.

**Attribution caveat (PRD §7.3, stated honestly):** the exact luck-cancelled
quantity is pair-level `skill_delta_bb`. Spot-level `mirror_delta_bb`
attributes each deck-side's delta to the street where the two playings' *line
labels* first diverge — sizing differences within the same label (e.g. both
`open` but 3bb vs 10bb, or a same-label all-in) are not caught, and such
deck-sides land in `no_action`/nothing. Directional, always read next to
`mirror_n`.

## PRD reconciliation (deviations, all deliberate)

1. **Preflop `int.action_equity` is seeded-MC, not exact** (cost: 1.7M-runout
   enumerations per unique matchup). Exact everywhere it feeds money numbers
   (`int.hand_equity`), exact postflop, deterministic seeds keep idempotency.
2. **Extra helper columns**: `stg.actions.street_no/invested_chips/pot_after/
   board_so_far`; `stg.hands.went_to_showdown/small_blind_chips/big_blind_chips/
   buy_in_chips`; `int.hand_features.*_opp`; `int.action_equity.is_exact`;
   `mart.agent_leaks.mirror_n`; `mart.agent_stats.opportunities`.
3. **Extra int tables**: `int.hand_street_lines`, `int.equity_cache`,
   `stg.transform_state`.
4. **`mart.agent_leaks.board_texture` uses `'na'`**, not NULL (PK member).
5. **`competition_id` added to every mart PK** (design is generic across
   competitions; S1 is the only in-scope target).
6. **"raw.leaderboard"/"raw.tables" in the PRD** map to
   `raw.leaderboard_history` (latest row per agent) and the actual raw DDL.
7. **`trueskill_sigma` is NULL** — the roster exposes a single `totalScore`.
8. **Walker in Python rather than pure SQL** for per-hand parsing (stg rows,
   features, lines, equity in one pass); cross-hand logic (pairs, marts) is
   set-based SQL. Same "scripts + cron, no orchestrator" stance as Stage 1.

## PRD §11 open questions — answers from live data (2026-07-15 sample)

| Question | Answer |
|---|---|
| Block cap 200? | **Yes** — max observed `hand_number` = 200, 5 blocks at exactly 200, none above. `is_complete` logic needs no cap assumption anyway. |
| Rake? | **Zero** across all 1,218 hands (Σ chip_delta = 0 per hand; QA keeps this honest forever). |
| `StreetDealt` payload shape? | Carries `cards` (newly dealt), `street`, `boardCards` (cumulative). Board is read from it. |
| Raw field names? | Reconciled (see deviations 6). |
| TrueSkill history granularity | Roster exposes `totalScore` only; history accrues per loader run (append-on-change). 7d deltas NULL until 7 days of polling exist. |
| Range-based equity | Deferred (v2) as planned; `is_exact` flag and omniscient caveat are stated on the tables. |

## Ops

```bash
uv run arena_transform.py run        # incremental; cron/systemd entrypoint (after arena_etl.py run)
uv run arena_transform.py status     # row counts, watermark, last QA
uv run arena_transform.py rebuild    # truncate stg/int/mart (keeps equity cache) + full re-run
uv run arena_transform.py selftest   # no DB needed: walker + equity checks against samples/
```

Throughput: ~26 hands/s cold (preflop MC dominates; unique matchups get
cached), ~400 hands/s warm. A full-season backfill is a one-time cost of the
unique preflop matchups (~47k classes exist; the cache converges), afterwards
hourly increments are seconds-to-minutes. Tune `ARENA_EQ_MC_SAMPLES` /
`ARENA_TRANSFORM_BATCH` in `.env` if needed.

The transform never mutates `raw.*`. Two loader-side guards added for it
(2026-07-15): a hand first seen mid-play is refreshed until it settles, and
replays are only fetched for settled hands — so the walker only ever sees
complete event streams (it also skips + counts incomplete ones defensively).
