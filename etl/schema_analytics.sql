-- ============================================================================
-- Arena Analytics Layer — Tiers 1–3 (stg -> int -> mart)
-- ============================================================================
-- Companion to schema.sql (raw landing). See etl/PRD_analytics_etl.md and
-- etl/ANALYTICS.md. Applied idempotently by arena_transform.py before every
-- run (and once by `arena_transform.py init-db`).
--
-- Design (PRD §3):
--   * The MIRROR PAIR is the spine: the ladder plays duplicate poker
--     (sandboxPvpBlockId + sandboxPvpHandNumber pair consecutive odd/even
--     hands on identical decks with agents swapped between seats).
--   * stg  = typed facts flattened from raw.replays (one clean row per grain).
--   * int  = enrichment reused everywhere (pairs, equity, texture, features).
--   * mart = one or two tables per front-end view, materialized + upserted.
--   * Nothing here mutates raw.*.
--
-- Deviations from the PRD DDL sketches are deliberate and documented in
-- ANALYTICS.md §"PRD reconciliation" (extra helper columns like street_no /
-- invested_chips / pot_after / board_so_far, texture sentinel 'na' instead of
-- NULL in a PK, competition_id added to mart PKs, int.hand_street_lines and
-- int.equity_cache as extra int tables).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS stg;
CREATE SCHEMA IF NOT EXISTS int;
CREATE SCHEMA IF NOT EXISTS mart;

COMMENT ON SCHEMA stg  IS 'Tier 1: typed facts flattened 1:1 from raw.replays (hands, hand_seats, actions). Mirror keys are computed once, here.';
COMMENT ON SCHEMA int  IS 'Tier 2: enrichment reused everywhere — mirror pairs (the spine), equity (the one Python-computed piece), board texture, per-hand stat features, per-street lines.';
COMMENT ON SCHEMA mart IS 'Tier 3: materialized, incrementally-refreshed tables backing the five front-end views. Read-only for the app.';

-- ----------------------------------------------------------------------------
-- stg.transform_state — transform bookkeeping (watermarks), mirrors
-- raw.ingest_state in spirit.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stg.transform_state (
    step         text        PRIMARY KEY,
    watermark    timestamptz,
    last_run_at  timestamptz,
    last_status  text,
    detail       jsonb
);

COMMENT ON TABLE stg.transform_state IS
  'Watermark + run stats per transform step. The main watermark row (step=walk_replays) stores the max raw.replays.fetched_at fully processed; each run handles rows with fetched_at > watermark. QA results land in detail of step=qa.';

-- ============================================================================
-- Tier 1 — Staging
-- ============================================================================

-- ----------------------------------------------------------------------------
-- stg.hands — grain: one hand (= one raw.replays row). PRD §5.1.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stg.hands (
    hand_id            text PRIMARY KEY,           -- replay table.id (= raw.tables.table_id)
    table_number       bigint NOT NULL,
    competition_id     text   NOT NULL,
    block_id           text   NOT NULL,            -- Joined.payload.sandboxPvpBlockId
    hand_number        int    NOT NULL,            -- Joined.payload.sandboxPvpHandNumber (1-indexed in block)
    mirror_pair_id     text   GENERATED ALWAYS AS
                         (block_id || ':' || (ceil(hand_number / 2.0)::int)::text) STORED,
    orientation        smallint NOT NULL CHECK (orientation IN (1, 2)),  -- 1 = odd/first-dealt, 2 = even/mirror
    dealer_seat_number int    NOT NULL,            -- TableStarted.payload.dealerSeatNumber (observed always 1)
    board_cards        text[] NOT NULL DEFAULT '{}',
    board_len          int    GENERATED ALWAYS AS (cardinality(board_cards)) STORED,
    street_reached     text   NOT NULL,            -- Preflop/Flop/Turn/River of the closing action, or Showdown when contested
    status             text   NOT NULL,            -- table.status (Completed)
    pot_final_chips    int,                        -- sum of both seats'' totalCommittedChips (= sum of payouts, rake-free)
    went_to_showdown   boolean NOT NULL DEFAULT false,  -- contested showdown (nobody folded)
    small_blind_chips  int,                        -- table.smallBlindChips (5 on the S1 ladder)
    big_blind_chips    int,                        -- table.bigBlindChips (10; bb = chips/10 assumes this)
    buy_in_chips       int,                        -- table.buyInChips (1000 = fresh 100bb every hand)
    started_at         timestamptz NOT NULL,
    ended_at           timestamptz,
    loaded_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_stg_hands_block       ON stg.hands (block_id, hand_number);
CREATE INDEX IF NOT EXISTS ix_stg_hands_mirror_pair ON stg.hands (mirror_pair_id);
CREATE INDEX IF NOT EXISTS ix_stg_hands_comp_time   ON stg.hands (competition_id, started_at);

COMMENT ON TABLE stg.hands IS
  'One row per hand, flattened from raw.replays. mirror_pair_id = block_id:ceil(hand_number/2) — the duplicate-poker pairing key (NEVER pair by adjacency or board equality; preflop folds leave partial boards). orientation = hand_number parity (1=odd=first-dealt).';
COMMENT ON COLUMN stg.hands.street_reached IS 'Showdown when contested to showdown; otherwise the street the closing fold happened on.';
COMMENT ON COLUMN stg.hands.pot_final_chips IS 'Total chips both seats put in = total paid out (zero rake, QA-checked).';

-- ----------------------------------------------------------------------------
-- stg.hand_seats — grain: one (hand, seat); exactly 2 rows per hand. PRD §5.2.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stg.hand_seats (
    hand_id               text NOT NULL REFERENCES stg.hands(hand_id),
    seat_number           int  NOT NULL,
    agent_id              text NOT NULL,
    agent_name            text,
    agent_handle          text,
    hole_cards            text[] NOT NULL,         -- exactly 2, always face-up in this dataset
    is_button             boolean NOT NULL,        -- seat_number = dealer_seat_number
    is_in_position        boolean NOT NULL,        -- HU: = is_button (button acts last postflop)
    posted_blind          text,                    -- 'small' (= button in HU) | 'big'
    total_committed_chips int  NOT NULL,
    payout_chips          int  NOT NULL,
    chip_delta            int  GENERATED ALWAYS AS (payout_chips - total_committed_chips) STORED,
    result_bb             numeric GENERATED ALWAYS AS ((payout_chips - total_committed_chips) / 10.0) STORED,
    status                text,                    -- seat status (Settled/Folded/...)
    PRIMARY KEY (hand_id, seat_number)
);

CREATE INDEX IF NOT EXISTS ix_stg_hand_seats_agent ON stg.hand_seats (agent_id);

COMMENT ON TABLE stg.hand_seats IS
  'Per-seat facts. chip_delta sums to 0 across the two seats of a hand (zero-sum QA check). bb = chips/10 — every hand is a fresh 1000-chip buy-in at 5/10, so bb/100 has no stack-depth confounder.';

-- ----------------------------------------------------------------------------
-- stg.actions — grain: one ActionTaken event. PRD §5.3.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stg.actions (
    action_id            text PRIMARY KEY,         -- event.id (uuid)
    hand_id              text NOT NULL REFERENCES stg.hands(hand_id),
    sequence             int  NOT NULL,            -- event.sequence (within-replay order incl. non-action events)
    street               text NOT NULL,            -- Preflop/Flop/Turn/River
    street_no            smallint NOT NULL,        -- 0..3, for ordering/joins
    actor_seat_number    int  NOT NULL,
    agent_id             text NOT NULL,
    action               text NOT NULL,            -- fold/check/call/bet/raise/all-in
    to_amount            int,                      -- payload.toAmount: total committed this street after acting (bets/raises)
    amount               int,                      -- payload.amount (calls: incremental chips)
    call_amount          int,                      -- payload.callAmount: chips needed to call when facing a bet
    invested_chips       int  NOT NULL DEFAULT 0,  -- incremental chips this action = stackBefore - post-snapshot stack
    pot_before           int,                      -- payload.pot (pot when the decision was made)
    pot_after            int,                      -- post-event snapshot potChips
    stack_before         int,                      -- payload.stackBefore
    current_bet_before   int,                      -- facing bet: previous event''s snapshot currentBet
    min_raise_to_before  int,                      -- previous event''s snapshot minRaiseTo
    board_so_far         text[] NOT NULL DEFAULT '{}',  -- board visible at the decision
    size_bb              numeric,                  -- invested_chips/10, bets/raises/all-ins only
    size_pot_fraction    numeric,                  -- invested_chips / pot_before, bets/raises/all-ins only
    is_aggressive        boolean GENERATED ALWAYS AS (action IN ('bet','raise','all-in')) STORED,
    reasoning_text       text,                     -- parsed 'Strategy note:' suffix of message (NULL when absent)
    bot_self_reported_eq numeric,                  -- optional 'eq=0.392'-style figure parsed from message text (prose, not ground truth)
    message_raw          text,                     -- verbatim payload.message (replayer fallback)
    occurred_at          timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_stg_actions_hand   ON stg.actions (hand_id, sequence);
CREATE INDEX IF NOT EXISTS ix_stg_actions_agent  ON stg.actions (agent_id, street);

COMMENT ON TABLE stg.actions IS
  'One row per ActionTaken replay event, enriched by the Python walker. The native reasoning field is null platform-wide (reasoningRequired:false) — reasoning_text is parsed from the message''s ''Strategy note:'' suffix instead. size_pot_fraction = incremental chips / pot_before.';

-- ============================================================================
-- Tier 2 — Intermediate
-- ============================================================================

-- ----------------------------------------------------------------------------
-- int.mirror_pairs — grain: one mirror pair. THE SPINE. PRD §6.1.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS int.mirror_pairs (
    mirror_pair_id  text PRIMARY KEY,
    block_id        text NOT NULL,
    pair_index      int  NOT NULL,                 -- ceil(hand_number/2)
    competition_id  text NOT NULL,
    agent_a_id      text NOT NULL,                 -- canonical: least(agent ids) -> one direction per matchup
    agent_b_id      text NOT NULL,
    hand_id_o1      text REFERENCES stg.hands(hand_id),   -- orientation 1 (odd hand_number)
    hand_id_o2      text REFERENCES stg.hands(hand_id),   -- orientation 2 (even = mirror)
    is_complete     boolean NOT NULL,              -- both hands landed; only complete pairs feed dup-adjusted metrics
    agent_a_pair_bb numeric,                       -- A''s result_bb summed over both orientations
    agent_b_pair_bb numeric,                       -- = -agent_a_pair_bb (zero-sum QA check)
    skill_delta_bb  numeric,                       -- = agent_a_pair_bb: luck-cancelled A-vs-B result on this deck
    started_at      timestamptz,
    ended_at        timestamptz
);

CREATE INDEX IF NOT EXISTS ix_int_mirror_pairs_agents ON int.mirror_pairs (agent_a_id, agent_b_id);
CREATE INDEX IF NOT EXISTS ix_int_mirror_pairs_block  ON int.mirror_pairs (block_id);
CREATE INDEX IF NOT EXISTS ix_int_mirror_pairs_open   ON int.mirror_pairs (is_complete) WHERE NOT is_complete;

COMMENT ON TABLE int.mirror_pairs IS
  'One row per mirror pair (identical deck played twice, agents swapped between seats; cards stay with the SEAT, dealer fixed at seat 1). Both agents hold both sides of every deck across a completed pair, so card and button luck cancel by construction: skill_delta_bb is a luck-neutralized skill signal, not a model.';

CREATE OR REPLACE VIEW int.pair_agent AS
  SELECT mirror_pair_id, block_id, competition_id,
         agent_a_id AS agent_id, agent_b_id AS opponent_id,
         agent_a_pair_bb AS pair_bb, is_complete, started_at
  FROM int.mirror_pairs
  UNION ALL
  SELECT mirror_pair_id, block_id, competition_id,
         agent_b_id, agent_a_id,
         agent_b_pair_bb, is_complete, started_at
  FROM int.mirror_pairs;

COMMENT ON VIEW int.pair_agent IS 'Long-form of int.mirror_pairs: one row per (pair, agent) for easy per-agent aggregation of duplicate-adjusted results.';

-- ----------------------------------------------------------------------------
-- int.hand_equity — grain: one (hand, seat). The Python equity step. PRD §6.2.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS int.hand_equity (
    hand_id          text NOT NULL REFERENCES stg.hands(hand_id),
    seat_number      int  NOT NULL,
    agent_id         text NOT NULL,
    went_all_in      boolean NOT NULL,             -- hand ended all-in with cards to come (both seats by definition)
    all_in_street    text,                         -- street the betting closed on when all-in (Preflop/Flop/Turn)
    equity_at_all_in numeric,                      -- exact enumeration vs the ACTUAL opponent hand on the board-so-far
    ev_result_bb     numeric,                      -- equity*pot - committed when all-in with cards to come; else = result_bb
    PRIMARY KEY (hand_id, seat_number)
);

CREATE INDEX IF NOT EXISTS ix_int_hand_equity_agent ON int.hand_equity (agent_id);

COMMENT ON TABLE int.hand_equity IS
  'All-in-EV adjustment: when betting closed all-in before the river, the realized result is replaced by equity x final pot - committed (in bb). Equity is exact by enumeration vs the actual opponent hand (both hole cards are always face-up in this dataset). No all-in with cards to come -> ev_result_bb = result_bb.';

-- ----------------------------------------------------------------------------
-- int.action_equity — grain: one action (replayer per-decision equity). PRD §6.2.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS int.action_equity (
    action_id        text PRIMARY KEY REFERENCES stg.actions(action_id),
    equity_vs_actual numeric,   -- acting agent''s equity vs opponent''s ACTUAL hand given board-so-far (omniscient)
    is_exact         boolean    -- true = exact enumeration (flop+); false = seeded Monte Carlo (preflop)
);

COMMENT ON TABLE int.action_equity IS
  'Omniscient per-decision equity for the replayer (uses the opponent''s real cards, which the bot could not see): a fair post-hoc "how strong was this actually" readout, NOT a decision-quality/GTO score. Flop/turn/river are exact by enumeration; preflop uses deterministic-seed Monte Carlo (documented deviation, ANALYTICS.md).';

-- ----------------------------------------------------------------------------
-- int.board_texture — grain: one hand (flop-based classification). PRD §6.3.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS int.board_texture (
    hand_id            text PRIMARY KEY REFERENCES stg.hands(hand_id),
    is_paired          boolean,
    is_monotone        boolean,   -- 3 same suit on the flop
    is_two_tone        boolean,
    is_rainbow         boolean,
    is_connected       boolean,   -- straighty flop (max gap structure)
    high_card_rank     int,       -- 2..14
    flop_texture_class text       -- 'dry' | 'semi_wet' | 'wet'
);

COMMENT ON TABLE int.board_texture IS 'Flop texture (the street where texture matters most, v1). Only populated for hands that saw a flop (board_len >= 3).';

-- ----------------------------------------------------------------------------
-- int.hand_features — grain: one (hand, seat). The stat feeder. PRD §6.4.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS int.hand_features (
    hand_id               text NOT NULL REFERENCES stg.hands(hand_id),
    seat_number           int  NOT NULL,
    agent_id              text NOT NULL,
    is_button             boolean NOT NULL,
    -- preflop (rate stats carry their _opp opportunity flags: honest denominators)
    vpip                  boolean,   -- voluntarily put money in (BB checking its option is NOT voluntary)
    pfr                   boolean,
    three_bet             boolean,   -- first preflop reraise (BB forced = 1bet, open = 2bet)
    three_bet_opp         boolean,   -- had a chance to 3bet (acted facing an open)
    faced_three_bet       boolean,
    folded_to_three_bet   boolean,
    was_preflop_aggressor boolean,   -- made the last preflop raise
    -- postflop
    saw_flop              boolean,
    cbet_flop             boolean,   -- preflop aggressor bets flop
    cbet_flop_opp         boolean,   -- was aggressor and had a no-bet-facing flop decision
    faced_cbet_flop       boolean,
    folded_to_cbet_flop   boolean,
    cbet_turn             boolean,   -- double barrel (cbet flop AND bet turn)
    cbet_turn_opp         boolean,
    cbet_river            boolean,   -- triple barrel
    cbet_river_opp        boolean,
    check_raised          boolean,   -- checked then raised on any street
    check_raise_opp       boolean,   -- checked and then faced a bet on that street
    -- outcomes
    wtsd                  boolean,   -- went to showdown
    wwsf                  boolean,   -- won when saw flop
    won_hand              boolean,
    won_at_showdown       boolean,
    -- aggression components
    bets_count            int,
    raises_count          int,
    calls_count           int,
    checks_count          int,
    folds_count           int,
    PRIMARY KEY (hand_id, seat_number)
);

CREATE INDEX IF NOT EXISTS ix_int_hand_features_agent ON int.hand_features (agent_id);

COMMENT ON TABLE int.hand_features IS 'Boolean/counter flags per (hand, seat), computed by the Python walker in street order. mart.agent_stats and mart.agent_leaks aggregate these.';

-- ----------------------------------------------------------------------------
-- int.hand_street_lines — grain: one (hand, seat, street) line label.
-- Extension beyond the PRD table list: feeds mart.agent_leaks (spot buckets)
-- and the mirror-divergence attribution (first street where the two playings
-- of the same deck-side differ).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS int.hand_street_lines (
    hand_id      text NOT NULL REFERENCES stg.hands(hand_id),
    seat_number  int  NOT NULL,
    agent_id     text NOT NULL,
    street       text NOT NULL,
    street_no    smallint NOT NULL,     -- 0..3
    position     text NOT NULL,         -- IP / OOP (HU: IP = button)
    line         text NOT NULL,         -- compact line label, see ANALYTICS.md taxonomy
    PRIMARY KEY (hand_id, seat_number, street_no)
);

CREATE INDEX IF NOT EXISTS ix_int_lines_agent ON int.hand_street_lines (agent_id, street_no, line);

COMMENT ON TABLE int.hand_street_lines IS
  'One line label per (hand, seat, street) from the walker (e.g. open, 3bet, cbet, double_barrel, check_raise, fold_vs_cbet). Used to bucket mart.agent_leaks and to find the first divergence street between the two playings of a deck-side inside a completed mirror pair.';

-- ----------------------------------------------------------------------------
-- int.equity_cache — persistent cache for expensive preflop equity runs.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS int.equity_cache (
    cache_key   text PRIMARY KEY,       -- suit-isomorphism-canonical 'hero|villain|board' form
    equity      numeric NOT NULL,       -- hero equity (win + tie/2 share)
    is_exact    boolean NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE int.equity_cache IS
  'Preflop equities are expensive (C(48,5)=1.7M boards exact / 10k-sample MC): cached under a suit-canonical key so repeats (mirror partners, common matchups) are free. Exact results overwrite MC results, never the reverse.';

-- ============================================================================
-- Tier 3 — Marts (View 0..4)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- View 0 — Overview hub. PRD §7.1.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mart.leaderboard (
    competition_id      text NOT NULL,
    agent_id            text NOT NULL,
    agent_name          text,
    agent_handle        text,
    rank                int,          -- ladder position = row_number() over total_score DESC (matches the order arena.dev.fun shows). NOT the API's own `rank` field, which is a global dev.fun platform rank across all arenas.
    trueskill_mu        numeric,      -- payload.totalScore (the ladder exposes one TrueSkill-style number; no sigma). This is "the score" shown on arena.dev.fun and the sort key behind `rank`.
    trueskill_sigma     numeric,      -- NULL today: not exposed by the API
    hands_played        int,
    blocks_played       int,
    completed_pairs     int,
    distinct_opponents  int,
    raw_bb_per_100      numeric,
    dup_adj_bb_per_100  numeric,      -- from completed mirror pairs only (luck-cancelled)
    ev_adj_bb_per_100   numeric,      -- all-in-EV-adjusted
    net_chips           bigint,
    rank_delta_7d       int,          -- ladder position 7 days ago - now (positive = climbed)
    mu_delta_7d         numeric,      -- totalScore now - 7 days ago
    last_updated        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (competition_id, agent_id)
);

COMMENT ON TABLE mart.leaderboard IS
  'View 0 hub: one row per agent seen in hands, joined to the latest server standings. raw/dup_adj/ev_adj bb/100 side by side — dup_adj (completed mirror pairs) is the honest skill number. 7d deltas need raw.leaderboard_history coverage (accrues only while the loader polls).';

CREATE TABLE IF NOT EXISTS mart.season_summary (
    competition_id     text PRIMARY KEY,
    competition_name   text,
    competition_status text,
    total_agents       int,
    total_hands        bigint,
    total_blocks       int,
    completed_pairs    int,
    first_hand_at      timestamptz,
    last_hand_at       timestamptz,
    last_updated       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mart.hands_over_time (
    competition_id   text NOT NULL,
    bucket_ts        timestamptz NOT NULL,      -- hourly bucket
    hands_in_bucket  int NOT NULL,
    hands_cumulative bigint NOT NULL,
    active_agents    int NOT NULL,
    PRIMARY KEY (competition_id, bucket_ts)
);

-- Per-snapshot ladder-position history, feeding the Overview "click a rank ->
-- see its trajectory" drill-down. At each captured_at we reconstruct the full
-- ladder (carry-forward each agent's last-known total_score) and rank by
-- total_score DESC, so `rank` here means the same thing as mart.leaderboard.rank
-- (arena.dev.fun's ordering) but through time. Forward-looking only: depth grows
-- with loader uptime (raw.leaderboard_history starts when polling started).
-- Rebuilt in full each run; cheap at current depth, windowable later for a long season.
CREATE TABLE IF NOT EXISTS mart.rank_history (
    competition_id text NOT NULL,
    agent_id       text NOT NULL,
    captured_at    timestamptz NOT NULL,
    total_score    numeric,
    rank           int,                          -- score-position at captured_at (1 = top total_score)
    field_size     int,                          -- agents on the ladder at that snapshot (rank denominator)
    PRIMARY KEY (competition_id, agent_id, captured_at)
);

COMMENT ON TABLE mart.rank_history IS
  'View 0 drill-down: per-agent ladder-position over time. rank = row_number() over total_score DESC within each captured_at snapshot (matches arena.dev.fun). History accrues only while the loader polls (no past standings from the API).';

-- ----------------------------------------------------------------------------
-- View 1 — Agent dashboard. PRD §7.2.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mart.agent_stats (
    competition_id        text NOT NULL,
    agent_id              text NOT NULL,
    position              text NOT NULL,        -- IP / OOP / ALL
    sample_n              int  NOT NULL,        -- hands in this split
    vpip_pct              numeric,
    pfr_pct               numeric,
    three_bet_pct         numeric,
    fold_to_three_bet_pct numeric,
    cbet_flop_pct         numeric,
    fold_to_cbet_flop_pct numeric,
    cbet_turn_pct         numeric,              -- double-barrel %
    cbet_river_pct        numeric,              -- triple-barrel %
    check_raise_pct       numeric,
    wtsd_pct              numeric,              -- of hands that saw flop
    wsd_pct               numeric,              -- won $ at showdown
    wwsf_pct              numeric,
    aggression_factor     numeric,              -- (bets+raises)/calls, postflop
    aggression_freq_pct   numeric,              -- (bets+raises)/(bets+raises+calls+folds), postflop
    avg_bet_pot_fraction  numeric,
    sizing_histogram      jsonb,                -- {"0-33":n,"33-66":n,"66-100":n,"100+":n} %-of-pot buckets
    bb_per_100            numeric,
    opportunities         jsonb,                -- per-stat denominators for honest UI greying
    PRIMARY KEY (competition_id, agent_id, position)
);

COMMENT ON TABLE mart.agent_stats IS
  'View 1: classic HU stat block per (agent, position-split). ALL is the headline; IP/OOP expose the positional split that matters most in HU. Every rate''s true denominator is in opportunities — the UI must grey out thin splits.';

-- ----------------------------------------------------------------------------
-- View 2 — Leak / EV attribution (the money map). PRD §7.3.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mart.agent_leaks (
    competition_id     text NOT NULL,
    agent_id           text NOT NULL,
    position           text NOT NULL,           -- IP / OOP
    street             text NOT NULL,           -- Preflop/Flop/Turn/River
    board_texture      text NOT NULL DEFAULT 'na',  -- dry/semi_wet/wet; 'na' = preflop or no flop seen
    line               text NOT NULL,
    sample_n           int NOT NULL,            -- hands where the agent took this line in this spot
    bb_per_100_spot    numeric,                 -- realized whole-hand result over those hands
    ev_bb_per_100_spot numeric,                 -- all-in-EV-adjusted version
    mirror_n           int NOT NULL DEFAULT 0,  -- deck-sides (in completed pairs) whose first line divergence was this spot
    mirror_delta_bb    numeric,                 -- HEADLINE: avg (own result - counterpart result on the identical deck) * 100
    PRIMARY KEY (competition_id, agent_id, position, street, board_texture, line)
);

COMMENT ON TABLE mart.agent_leaks IS
  'View 2: per-spot results. mirror_delta_bb holds the deck constant (duplicate difference vs the agent who played the IDENTICAL cards) — a persistently negative bucket is a real leak, not variance. Attribution: a completed pair''s per-deck-side delta is attributed to the spot where the two playings'' lines FIRST diverge (directional decomposition; pair-level skill_delta_bb is the exact quantity). Always read next to sample_n/mirror_n.';

-- ----------------------------------------------------------------------------
-- View 3 — Hand replayer with reasoning (the debugger). PRD §7.4.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mart.hand_header (
    hand_id          text PRIMARY KEY,
    mirror_hand_id   text,                      -- partner hand (identical deck) for side-by-side diffing
    block_id         text,
    pair_index       int,
    orientation      smallint,
    competition_id   text,
    agent1_id        text, agent1_name text, agent1_hole text[], agent1_result_bb numeric, agent1_is_button boolean,
    agent2_id        text, agent2_name text, agent2_hole text[], agent2_result_bb numeric,
    board_cards      text[],
    final_pot_chips  int,
    winner_agent_id  text,                      -- NULL on a chopped pot
    street_reached   text,
    started_at       timestamptz
);

CREATE INDEX IF NOT EXISTS ix_mart_hand_header_agents ON mart.hand_header (agent1_id, started_at);
CREATE INDEX IF NOT EXISTS ix_mart_hand_header_agent2 ON mart.hand_header (agent2_id, started_at);
CREATE INDEX IF NOT EXISTS ix_mart_hand_header_block  ON mart.hand_header (block_id, pair_index);

COMMENT ON TABLE mart.hand_header IS
  'View 3 header. agent1 = seat 1, agent2 = seat 2. mirror_hand_id is the payoff: render two bots playing the identical cards side by side and diff their lines and reasoning.';

CREATE TABLE IF NOT EXISTS mart.hand_step (
    hand_id            text NOT NULL REFERENCES mart.hand_header(hand_id),
    sequence           int  NOT NULL,
    street             text,
    actor_agent_id     text,
    actor_name         text,
    is_button          boolean,
    action             text,
    size_bb            numeric,
    size_pot_fraction  numeric,
    pot_before         int,
    pot_after          int,
    stack_before       int,
    board_so_far       text[],
    equity_at_decision numeric,                  -- omniscient (opponent''s actual cards); see int.action_equity
    reasoning_text     text,
    PRIMARY KEY (hand_id, sequence)
);

COMMENT ON TABLE mart.hand_step IS 'View 3 timeline: UI-ready, one row per decision. Pot/stack/board come from event snapshots — no re-simulation.';

-- ----------------------------------------------------------------------------
-- View 4 — Head-to-head breakdown. PRD §7.5.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mart.matchups (
    competition_id       text NOT NULL,
    agent_a_id           text NOT NULL,          -- perspective agent (both directions materialized)
    agent_b_id           text NOT NULL,
    blocks               int,
    completed_pairs      int,
    hands                int,
    a_raw_bb_per_100     numeric,
    a_dup_adj_bb_per_100 numeric,                -- A''s luck-cancelled win-rate vs B (completed pairs)
    a_ev_adj_bb_per_100  numeric,
    a_win_rate           numeric,                -- share of hands A won chips in
    spot_deltas          jsonb,                  -- top +/- mirror-delta spots vs THIS opponent
    last_updated         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (competition_id, agent_a_id, agent_b_id)
);

COMMENT ON TABLE mart.matchups IS
  'View 4: the block IS the matchup (one fixed A-vs-B head-to-head session). Materialized in both directions so the UI reads one row. spot_deltas = agent_leaks logic scoped to this opponent: exactly which rival exploits you, and where.';

-- ----------------------------------------------------------------------------
-- App role grants. The read-only web app connects as `app_readonly` (SELECT on
-- mart.* only). That role is created out-of-band on the server and does NOT
-- exist in local dev, so grant only when present. Idempotent and re-applied on
-- every transform run (ensure_schema), so any new mart table added above is
-- covered automatically — no manual GRANT step after a deploy.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_readonly') THEN
        GRANT USAGE ON SCHEMA mart TO app_readonly;
        GRANT SELECT ON ALL TABLES IN SCHEMA mart TO app_readonly;
    END IF;
END $$;
