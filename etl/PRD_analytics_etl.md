# PRD — Arena Heads-Up Ladder: Analytics Layer (Tiers 1–3)

**Status:** Draft v1
**Companion to:** `PRD_arena_raw_ingestion.md` (Stage 1 raw landing)
**Scope:** Transform layer only — `raw` → `stg` → `int` → `mart`. Feeds five front-end views.
**Target competition:** dev.fun Arena, `[poker] heads-up ladder`, Season 1 (`competition_id = cmr3n8tft01nilecm1u5jlny7` observed). Design is generic across competitions; S1 is the only in-scope target.
**Audience for the app:** agent developers tuning bots (diagnostic loop, not spectator overview).

---

## 1. Purpose

Turn the raw landing tables into a small set of typed, materialized analytics tables that power the app's five views. Every table here exists to answer a developer's question in the tuning loop: *how am I doing → where am I bleeding chips → show me those exact hands → what was my bot thinking.*

The layer is ELT: all logic runs after raw landing, mostly in SQL, with one Python step for equity. No new loader work is required — every field we need is already inside the `raw.replays` payloads we land 1:1 with hands.

## 2. The single most important finding, and what it changes

The ladder runs **duplicate (mirror) poker**, confirmed both structurally and empirically against live data:

- **Structural:** each hand's two `Joined` events carry `sandboxPvpBlockId` (a cuid shared by one fixed pair of agents for a long head-to-head session) and `sandboxPvpHandNumber` (1-indexed position within the block). Consecutive odd/even hand numbers are mirror partners.
- **Empirical:** within a block, decks repeat in exact pairs — identical board, hole cards glued to the *seat*, the two agents swapped between seats, and `dealerSeatNumber` fixed at 1 so the button moves to the other agent. Each agent therefore plays every deck from both sides.

**Consequence for this layer:** the base unit of analysis is the **mirror pair**, not the single hand.

```
mirror_pair_id = sandboxPvpBlockId || ':' || ceil(sandboxPvpHandNumber / 2.0)
orientation    = 1 if sandboxPvpHandNumber is odd else 2   -- first-dealt vs mirror
```

Because both agents hold both sides of every deck across a completed pair, **card and button luck cancel between them by construction**. A block is a fixed A-vs-B match, and it is **zero-sum** (winner takes the whole pot; no rake observed in sample — see §9). So an agent's summed result across a completed pair is a **luck-neutralized skill signal** we can read directly, not something we have to model toward.

This unlocks the layer's headline capability: **mirror-differential metrics** — comparing an agent's result on a deck against its counterpart's result on the *identical* deck. That is the cleanest possible leak finder, because it holds the cards perfectly constant and isolates decisions.

### Facts from the API investigation that pin down specific build decisions

| Finding | Design decision |
|---|---|
| `blockId`/`handNumber` live **only in replay `Joined` payloads**, not in `getTexasTables` list rows | The mirror spine is built off the **replay-pass**, during transform. No loader change. |
| No `seed`/`deckId`/`equity`/`EV` field exists anywhere | We compute equity ourselves by enumeration (both hole cards + board always known). |
| `reasoning` field is **null platform-wide** (`reasoningRequired: false`) | The bot's strategy text lives in `message`: a constant engine template optionally followed by a `Strategy note: …` suffix. Parse the suffix; keep `reasoning` as an optional column. |
| Both seats' hole cards are **always face-up** (list, replay, snapshots, showdown), even uncontested preflop hands | Full-fidelity replayer and exact equity are always computable. |
| Every hand is a **fresh 1000-chip buy-in at 5/10 blinds** (100bb); no carried stack across a block | `bb = chips / 10`; bb/100 has **no stack-depth confounder**; cumulative lines are just sums of per-hand deltas. |
| No native `chipDelta` field | Derive it: `chip_delta = payout_chips − total_committed_chips` (nets zero-sum across the two seats). |
| Mirror partners are **not adjacent** in the global feed (can lag minutes / ~1000 table numbers) | Pair on `(block_id, ceil(hand_number/2))` — **never by adjacency**. This also pairs preflop-fold hands that card-matching can't. |
| List feed occasionally returns the same table on overlapping pages | Absorbed by the existing `ON CONFLICT DO NOTHING`; dedup on `hand_id`. |
| A block observed mid-play can have an **odd trailing hand** (mirror not yet dealt) | Exclude incomplete pairs from all duplicate-adjusted metrics until closed. |

## 3. Design principles

1. **Mirror pair is the spine.** Duplicate-adjusted metrics are first-class, alongside (not instead of) raw and EV-adjusted metrics and TrueSkill.
2. **ELT, mostly SQL.** One Python step (equity). Layer is dbt-friendly but requires only plain SQL + a scheduler, consistent with the "just scripts" philosophy of the raw layer.
3. **Materialized, incrementally refreshed.** Marts are tables, not live views, rebuilt on a watermark. Open blocks are reprocessed each run; closed blocks are finalized once.
4. **Sample size is always visible.** Every rate metric carries its `sample_n` so the UI can grey out thin numbers. HU ranges are wide; small-N stats mislead.
5. **Everything splits by position.** In HU, button = in position postflop. An agent can be a monster IP and a leak OOP; unsplit stats hide that.
6. **Faithful to raw.** Nothing here mutates `raw`. If a raw field name below differs from the actual raw DDL, reconcile to raw (see §10 open items).

## 4. Architecture

```
raw.replays        (JSONB: {table, events[]})   ┐
raw.tables         (list-pass rows)             ├─► stg ─► int ─► mart ─► 5 views
raw.leaderboard        (current TrueSkill)      │
raw.leaderboard_history(append-on-change)       ┘

stg   flatten JSONB → typed facts (hands, hand_seats, actions)
int   enrichment reused everywhere (mirror_pairs, equity, board_texture, hand_features)
mart  1–2 tables per view (leaderboard, agent_stats, agent_leaks, hand_timeline, matchups, season_summary)
```

Schemas: `stg`, `int`, `mart` (mirrors the existing `raw`). Grain is stated for every table.

---

## 5. Tier 1 — Staging (flatten JSONB into typed facts)

Purpose: one clean, typed row-set per grain, extracted from `raw.replays` (and cross-checked against `raw.tables`). This is where the mirror keys are computed **once**.

### 5.1 `stg.hands` — grain: one hand

```sql
CREATE TABLE stg.hands (
  hand_id           text PRIMARY KEY,          -- replay table.id (cuid)
  table_number      bigint NOT NULL,
  competition_id    text   NOT NULL,
  block_id          text   NOT NULL,           -- Joined.sandboxPvpBlockId
  hand_number       int    NOT NULL,           -- Joined.sandboxPvpHandNumber
  mirror_pair_id    text   GENERATED ALWAYS AS  -- block_id + pair index
                      (block_id || ':' || ceil(hand_number / 2.0)::int) STORED,
  orientation       smallint NOT NULL,         -- 1 = odd/first-dealt, 2 = even/mirror
  dealer_seat_number int   NOT NULL,           -- TableStarted.dealerSeatNumber (observed always 1)
  board_cards       text[] NOT NULL DEFAULT '{}', -- final board (0,3,4,5 cards)
  board_len         int    GENERATED ALWAYS AS (cardinality(board_cards)) STORED,
  street_reached    text   NOT NULL,           -- PreDeal/Preflop/Flop/Turn/River/Showdown
  status            text   NOT NULL,
  pot_final_chips   int,
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz,
  loaded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stg.hands (block_id, hand_number);
CREATE INDEX ON stg.hands (mirror_pair_id);
CREATE INDEX ON stg.hands (competition_id, started_at);
```
Source: `block_id`/`hand_number` from either `Joined` payload; `dealer_seat_number` from `TableStarted.payload`; board/street/status/pot from `table` + final `Showdown`/`snapshot`. `orientation = CASE WHEN hand_number % 2 = 1 THEN 1 ELSE 2 END`.

### 5.2 `stg.hand_seats` — grain: one (hand, seat); 2 rows per hand

```sql
CREATE TABLE stg.hand_seats (
  hand_id              text NOT NULL REFERENCES stg.hands(hand_id),
  seat_number          int  NOT NULL,          -- 1 or 2
  agent_id             text NOT NULL,
  agent_name           text,
  agent_handle         text,
  hole_cards           text[] NOT NULL,        -- exactly 2, always present
  is_button            boolean NOT NULL,       -- seat_number = dealer_seat_number
  is_in_position       boolean NOT NULL,       -- HU: = is_button (button acts last postflop)
  posted_blind         text,                   -- 'small' (=button in HU) | 'big' | NULL
  total_committed_chips int  NOT NULL,
  payout_chips         int  NOT NULL,
  chip_delta           int  GENERATED ALWAYS AS (payout_chips - total_committed_chips) STORED,
  result_bb            numeric GENERATED ALWAYS AS ((payout_chips - total_committed_chips) / 10.0) STORED,
  status               text,                   -- Folded/Settled/...
  PRIMARY KEY (hand_id, seat_number)
);
CREATE INDEX ON stg.hand_seats (agent_id);
```
`chip_delta` sums to 0 across the two seats (zero-sum check — see §9 QA). `bb = chips/10` because BB = 10.

### 5.3 `stg.actions` — grain: one `ActionTaken` event

```sql
CREATE TABLE stg.actions (
  action_id             text PRIMARY KEY,      -- event.id
  hand_id               text NOT NULL REFERENCES stg.hands(hand_id),
  sequence              int  NOT NULL,
  street                text NOT NULL,         -- Preflop/Flop/Turn/River
  actor_seat_number     int  NOT NULL,
  agent_id              text NOT NULL,
  action                text NOT NULL,         -- fold/check/call/bet/raise/all-in
  to_amount             int,                   -- toAmount: total committed this street after acting
  amount                int,
  call_amount           int,
  pot_before            int,
  stack_before          int,
  current_bet_before    int,
  min_raise_to_before   int,
  size_bb               numeric,               -- derived, bets/raises only
  size_pot_fraction     numeric,               -- derived: incremental amount / pot_before
  is_aggressive         boolean GENERATED ALWAYS AS (action IN ('bet','raise','all-in')) STORED,
  reasoning_text        text,                  -- parsed 'Strategy note:' suffix of message (may be NULL)
  bot_self_reported_eq  numeric,               -- optional regex from message text (e.g. "eq=0.392")
  message_raw           text,                  -- kept verbatim for audit
  occurred_at           timestamptz NOT NULL
);
CREATE INDEX ON stg.actions (hand_id, sequence);
CREATE INDEX ON stg.actions (agent_id, street);
```

**Message parsing rule.** `message` is `On {street} with pot {N} … avoiding unsupported sizing.` optionally followed by ` Strategy note: {suffix}`. Set `reasoning_text` to the substring after `Strategy note:` when present, else NULL. Never read the native `reasoning` field for content (always null). Keep `message_raw` so the replayer can fall back to the full template.

---

## 6. Tier 2 — Intermediate (enrichment reused everywhere)

### 6.1 `int.mirror_pairs` — grain: one mirror pair (**the spine**)

```sql
CREATE TABLE int.mirror_pairs (
  mirror_pair_id     text PRIMARY KEY,
  block_id           text NOT NULL,
  pair_index         int  NOT NULL,
  competition_id     text NOT NULL,
  agent_a_id         text NOT NULL,            -- canonical: least(agent_id) for stable matchup direction
  agent_b_id         text NOT NULL,
  hand_id_o1         text REFERENCES stg.hands(hand_id),  -- orientation 1 (odd)
  hand_id_o2         text REFERENCES stg.hands(hand_id),  -- orientation 2 (even)
  is_complete        boolean NOT NULL,         -- both hands present
  agent_a_pair_bb    numeric,                  -- A's result_bb summed over both hands
  agent_b_pair_bb    numeric,                  -- = -agent_a_pair_bb (zero-sum)
  skill_delta_bb     numeric,                  -- = agent_a_pair_bb; luck-cancelled A-vs-B result
  started_at         timestamptz,
  ended_at           timestamptz
);
CREATE INDEX ON int.mirror_pairs (agent_a_id, agent_b_id);
CREATE INDEX ON int.mirror_pairs (block_id);
```
Only `is_complete` pairs feed duplicate-adjusted metrics. `agent_a_pair_bb = Σ result_bb for agent_a across hand_o1 + hand_o2`. Canonicalize `(agent_a_id, agent_b_id)` by ID sort so a matchup has one direction; carry `skill_delta_bb` from A's perspective.

Convenience long-form for aggregation:
```sql
CREATE VIEW int.pair_agent AS
  SELECT mirror_pair_id, block_id, competition_id, agent_a_id AS agent_id,
         agent_b_id AS opponent_id, agent_a_pair_bb AS pair_bb, is_complete FROM int.mirror_pairs
  UNION ALL
  SELECT mirror_pair_id, block_id, competition_id, agent_b_id, agent_a_id,
         agent_b_pair_bb, is_complete FROM int.mirror_pairs;
```

### 6.2 `int.hand_equity` — grain: one (hand, seat) · **the one Python step**

```sql
CREATE TABLE int.hand_equity (
  hand_id            text NOT NULL REFERENCES stg.hands(hand_id),
  seat_number        int  NOT NULL,
  agent_id           text NOT NULL,
  went_all_in        boolean NOT NULL,
  all_in_street      text,                     -- street the last all-in closed action on, if any
  equity_at_all_in   numeric,                  -- exact HU equity vs actual opp hand, board-so-far, by enumeration
  ev_result_bb       numeric,                  -- all-in-adjusted result; = result_bb when no all-in with cards to come
  PRIMARY KEY (hand_id, seat_number)
);
```
When a hand goes all-in with cards to come, replace the realized result with `equity_at_all_in × final_pot − total_committed` (in bb). Standard all-in-EV uses the **actual** opponent hand (both known), so this is exact by enumeration — cheap for HU. When no all-in with cards to come, `ev_result_bb = result_bb`.

Optional heavier table for the replayer's per-decision equity:
```sql
CREATE TABLE int.action_equity (
  action_id          text PRIMARY KEY REFERENCES stg.actions(action_id),
  equity_vs_actual   numeric   -- acting agent's exact equity vs opponent's actual hand, given board-so-far
);
```
Caveat: `equity_vs_actual` is *omniscient* (uses the opponent's real cards, which the bot couldn't see). It is a fair post-hoc "how strong was this actually" readout for the replayer, **not** a decision-quality/GTO score — a range-based equity would need range modeling (future, §11).

### 6.3 `int.board_texture` — grain: one hand

```sql
CREATE TABLE int.board_texture (
  hand_id          text PRIMARY KEY REFERENCES stg.hands(hand_id),
  is_paired        boolean,
  is_monotone      boolean,   -- 3+ same suit on flop
  is_two_tone      boolean,
  is_rainbow       boolean,
  is_connected     boolean,   -- straighty flop
  high_card_rank   int,       -- 2..14
  flop_texture_class text     -- 'dry' | 'semi_wet' | 'wet'
);
```
Classification is flop-based for v1 (the street where texture matters most). Only populated for hands that saw a flop (`board_len >= 3`).

### 6.4 `int.hand_features` — grain: one (hand, seat) · the stat feeder

Boolean/counter flags that `mart.agent_stats` and `mart.agent_leaks` aggregate. Computed by walking `stg.actions` per hand in street order.

```sql
CREATE TABLE int.hand_features (
  hand_id                 text NOT NULL REFERENCES stg.hands(hand_id),
  seat_number             int  NOT NULL,
  agent_id                text NOT NULL,
  is_button               boolean NOT NULL,
  -- preflop
  vpip                    boolean,   -- voluntarily put money in (call/raise; BB checking option ≠ voluntary)
  pfr                     boolean,   -- raised preflop
  three_bet               boolean,   -- reraised preflop (BB forced = 1bet, open = 2bet, reraise = 3bet)
  faced_three_bet         boolean,
  folded_to_three_bet     boolean,
  was_preflop_aggressor   boolean,
  -- postflop
  saw_flop                boolean,
  cbet_flop               boolean,   -- preflop aggressor bets flop
  faced_cbet_flop         boolean,
  folded_to_cbet_flop     boolean,
  cbet_turn               boolean,   -- double barrel
  cbet_river              boolean,   -- triple barrel
  check_raised            boolean,
  -- outcomes
  wtsd                    boolean,   -- went to showdown
  wwsf                    boolean,   -- won when saw flop
  won_hand                boolean,
  won_at_showdown         boolean,
  -- aggression factor components
  bets_count              int,
  raises_count            int,
  calls_count             int,
  PRIMARY KEY (hand_id, seat_number)
);
```

---

## 7. Tier 3 — Marts (one or two tables per view)

### 7.1 View 0 — Overview hub

`mart.leaderboard` — grain: one agent
```sql
CREATE TABLE mart.leaderboard (
  agent_id            text PRIMARY KEY,
  agent_name          text,
  agent_handle        text,
  rank                int,        -- from raw.leaderboard
  trueskill_mu        numeric,
  trueskill_sigma     numeric,
  hands_played        int,
  blocks_played       int,
  completed_pairs     int,
  distinct_opponents  int,
  raw_bb_per_100      numeric,    -- Σ result_bb / hands * 100
  dup_adj_bb_per_100  numeric,    -- from completed mirror pairs (luck-cancelled)
  ev_adj_bb_per_100   numeric,    -- from int.hand_equity
  net_chips           bigint,
  rank_delta_7d       int,        -- from raw.leaderboard_history
  mu_delta_7d         numeric,
  last_updated        timestamptz
);
```
`mart.season_summary` — grain: 1 row (header): `total_agents, total_hands, total_blocks, completed_pairs, competition_status, first_hand_at, last_hand_at`.
`mart.hands_over_time` — grain: time bucket (sparkline): `bucket_ts, hands_cumulative, active_agents`.

### 7.2 View 1 — Agent dashboard

`mart.agent_stats` — grain: one (agent, position); position ∈ {`IP`, `OOP`, `ALL`}
```sql
CREATE TABLE mart.agent_stats (
  agent_id             text NOT NULL,
  position             text NOT NULL,          -- IP / OOP / ALL
  sample_n             int  NOT NULL,          -- hands in this split
  vpip_pct             numeric,
  pfr_pct              numeric,
  three_bet_pct        numeric,
  fold_to_three_bet_pct numeric,
  cbet_flop_pct        numeric,
  fold_to_cbet_flop_pct numeric,
  cbet_turn_pct        numeric,                -- double-barrel %
  cbet_river_pct       numeric,                -- triple-barrel %
  check_raise_pct      numeric,
  wtsd_pct             numeric,
  wsd_pct              numeric,                -- won $ at showdown
  wwsf_pct             numeric,
  aggression_factor    numeric,                -- (bets+raises)/calls
  aggression_freq_pct  numeric,
  avg_bet_pot_fraction numeric,
  sizing_histogram     jsonb,                  -- {"0-33":..,"33-66":..,"66-100":..,"100+":..}
  bb_per_100           numeric,
  PRIMARY KEY (agent_id, position)
);
```
Aggregated from `int.hand_features` joined to `int.board_texture` and `stg.actions`. The `ALL` row is the headline; `IP`/`OOP` expose the positional split that matters most in HU. UI greys out any split with low `sample_n`.

### 7.3 View 2 — Leak / EV attribution (**the money map**)

`mart.agent_leaks` — grain: one (agent, position, street, board_texture, line)
```sql
CREATE TABLE mart.agent_leaks (
  agent_id           text NOT NULL,
  position           text NOT NULL,            -- IP / OOP
  street             text NOT NULL,            -- Preflop/Flop/Turn/River
  board_texture      text,                     -- dry/semi_wet/wet/NULL(preflop)
  line               text NOT NULL,            -- cbet / double_barrel / triple_barrel /
                                               -- check_call / check_raise / call_vs_cbet / probe / fold ...
  sample_n           int NOT NULL,
  bb_per_100_spot    numeric,                  -- absolute win-rate in this spot
  ev_bb_per_100_spot numeric,                  -- all-in-adjusted
  mirror_delta_bb    numeric,                  -- HEADLINE: duplicate-differenced result vs mirror counterpart
  PRIMARY KEY (agent_id, position, street, board_texture, line)
);
```
`mirror_delta_bb` is the value the whole app is built around: for the spots reached inside completed mirror pairs, the agent's result minus the counterpart's result on the identical deck, bucketed by spot. A persistently negative bucket ("−40 bb/100 double-barreling turns OOP on paired boards") is a **real** leak, not variance, because the deck is held constant.

**Attribution caveat (state honestly):** the clean, exact quantity is the *pair-level* `skill_delta_bb`. Decomposing that pair difference down to (street × texture × line) buckets is an approximation — attribute the pair delta to the spot where the divergence in lines first occurs, and treat spot-level `mirror_delta_bb` as directional, always shown next to `sample_n`. Pair-level totals reconcile exactly; spot-level is a decomposition.

### 7.4 View 3 — Hand replayer with reasoning (**the debugger**)

`mart.hand_header` — grain: one hand
```sql
CREATE TABLE mart.hand_header (
  hand_id          text PRIMARY KEY,
  mirror_hand_id   text,                       -- partner hand (identical deck) for side-by-side
  block_id         text, pair_index int, orientation smallint,
  competition_id   text,
  agent1_id text, agent1_name text, agent1_hole text[], agent1_result_bb numeric, agent1_is_button boolean,
  agent2_id text, agent2_name text, agent2_hole text[], agent2_result_bb numeric,
  board_cards      text[],
  final_pot_chips  int,
  winner_agent_id  text,
  started_at       timestamptz
);
```
`mart.hand_step` — grain: one action (UI-ready timeline)
```sql
CREATE TABLE mart.hand_step (
  hand_id           text NOT NULL REFERENCES mart.hand_header(hand_id),
  sequence          int  NOT NULL,
  street            text,
  actor_agent_id    text, actor_name text, is_button boolean,
  action            text,
  size_bb           numeric, size_pot_fraction numeric,
  pot_before        int, pot_after int,
  stack_before      int,
  board_so_far      text[],                     -- from event snapshot
  equity_at_decision numeric,                   -- from int.action_equity (omniscient; see 6.2)
  reasoning_text    text,                        -- parsed message suffix
  PRIMARY KEY (hand_id, sequence)
);
```
`mirror_hand_id` is the payoff: the replayer can render two bots playing the **identical** cards side by side and diff their lines and reasoning — the single most useful thing this dataset does for someone tuning a bot. Pot/stack/board per step come straight from event `snapshot`, so no re-simulation.

### 7.5 View 4 — Head-to-head breakdown

`mart.matchups` — grain: one ordered matchup (agent_a, agent_b)
```sql
CREATE TABLE mart.matchups (
  agent_a_id          text NOT NULL,
  agent_b_id          text NOT NULL,
  blocks              int,
  completed_pairs     int,
  hands               int,
  a_raw_bb_per_100    numeric,
  a_dup_adj_bb_per_100 numeric,                 -- A's luck-cancelled win-rate vs B
  a_win_rate          numeric,
  a_ev_adj_bb_per_100 numeric,
  spot_deltas         jsonb,                     -- top +/- mirror_delta_bb buckets vs THIS opponent
  PRIMARY KEY (agent_a_id, agent_b_id)
);
```
Falls almost directly out of `int.mirror_pairs` — the block *is* the matchup. `spot_deltas` reuses the `mart.agent_leaks` logic scoped to one opponent, so a dev can see exactly which rival exploits them and where.

---

## 8. Metric glossary (unambiguous definitions)

- **bb** = chips / 10 (BB = 10). **bb/100** = Σ result_bb / hands × 100.
- **raw bb/100** — realized results, no adjustment. Noisy at low N.
- **duplicate-adjusted (dup_adj) bb/100** — computed over *completed mirror pairs*; card and button luck cancel between the two agents. The honest skill number for a matchup. Zero-sum: A's = −B's.
- **EV-adjusted (ev_adj) bb/100** — realized results except all-ins-with-cards-to-come are replaced by `equity × pot`. Removes coinflip variance; equity computed by exact enumeration vs the known opponent hand.
- **mirror_delta_bb** — within completed pairs, agent's result minus counterpart's on the identical deck, per spot. Leak signal.
- **VPIP / PFR** — voluntarily put money in preflop / raised preflop. BB checking its option is not voluntary.
- **3-bet** — preflop reraise (BB forced = 1bet, open = 2bet, reraise = 3bet).
- **c-bet / double / triple barrel** — preflop aggressor bets flop / turn / river.
- **WTSD / W$SD / WWSF** — went to showdown / won money at showdown / won when saw flop.
- **Aggression factor** — (bets + raises) / calls.
- **IP / OOP** — in / out of position postflop. In HU, IP = button = dealer seat = small blind.

## 9. Data-quality rules & edge cases

1. **Odd trailing hand** — a mid-play block can have an unpaired final odd hand. `is_complete = false`; excluded from all dup-adj metrics until its mirror lands.
2. **Zero-sum check** — per hand, Σ `chip_delta` over both seats must equal 0; per completed pair, `agent_a_pair_bb + agent_b_pair_bb` must equal 0. Alert on violation (would imply rake or data loss). Rake looked absent in sample; this check is how we keep that assumption honest.
3. **Overlapping list pages** — same table on two pages; dedup on `hand_id` (already handled upstream by `ON CONFLICT DO NOTHING`).
4. **Preflop-fold hands** — ~half of hands end preflop with an empty/partial board; card-matching can't pair them but `(block_id, ceil(hand_number/2))` does. Never pair by board equality.
5. **Partial boards on mirrors** — a pair where one hand folds early shows different partial boards despite the identical deck. Expected; pairing is by block/hand-number, not board.
6. **Null reasoning** — never surface the native `reasoning` field; use the parsed `message` suffix, and fall back to the template text if no suffix.
7. **No equity field** — always computed; never expect one from the API. Bot-self-reported `eq=…` inside message text is prose, not ground truth (store separately for "did the bot's math match reality" checks).
8. **Sample-size gating** — every rate metric carries `sample_n`; the UI must visibly de-emphasize thin splits.
9. **Mid-play blocks** — reprocess open blocks each run; finalize on block completion. Never treat an open block's partial dup-adj number as final.

## 10. Refresh & orchestration

- **Watermark:** transforms process `raw` rows with `loaded_at > last_run_watermark`, plus a re-scan of any block still open (has an odd trailing hand or no `TableEnded` on its latest hand).
- **Order:** `stg.*` (upsert new hands) → `int.mirror_pairs` (finalize newly-completed pairs) → **Python equity step** (`int.hand_equity`, optional `int.action_equity`) → `int.board_texture`, `int.hand_features` → `mart.*`.
- **Materialization:** `stg`/`int` upsert incrementally by key. Marts rebuild per affected agent/matchup (bounded blast radius) rather than full-table each run.
- **Cadence:** a cron-driven script, matching the raw layer's "scripts, no Airflow" stance. dbt is optional and this layering maps cleanly onto it if adopted later.
- **Idempotent:** every step is `INSERT … ON CONFLICT DO UPDATE` on stable keys, so re-runs over the same window are safe.

## 11. Open questions / assumptions to validate

1. **Block cap** — is a block exactly 200 hands (100 decks)? Observed up to 200 but unconfirmed. Affects "is this block complete" logic; validate against a fully-ended block.
2. **Rake** — assumed zero (winner takes whole pot; +5/−5 in sample). The §9.2 zero-sum check is the guardrail; confirm across a large batch.
3. **`StreetDealt` payload shape** — assumed to carry the new board cards; board is currently reconstructed from `snapshot.boardCards`/`Showdown`. Confirm the field names.
4. **Raw table/field names** — this PRD references `raw.replays`, `raw.tables`, `raw.leaderboard`, `raw.leaderboard_history`. Reconcile to the actual raw DDL from the ingestion PRD.
5. **TrueSkill history granularity** — `rank_delta_7d`/`mu_delta_7d` depend on `raw.leaderboard_history` cadence; confirm it captures enough points for trends.
6. **Range-based equity** — v1 equity is vs the known opponent hand (omniscient). A decision-quality metric needs opponent range modeling; deferred.

## 12. Out of scope (v1)

Preflop range grid, style/meta map, ladder-race bump chart, and luck-vs-skill scatter (all spectator/meta-flavored) — natural follow-ons once the diagnostic core ships. GTO/solver comparison and range-based decision scoring are future work.