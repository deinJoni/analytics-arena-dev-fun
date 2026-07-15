-- ============================================================================
-- Arena Raw Data Ingestion — Stage 1 landing schema
-- ============================================================================
-- Design (see etl/PRD_raw.md and etl/SCHEMA.md):
--   * Raw-first ELT: every API payload lands VERBATIM in a `payload jsonb`
--     column. Only the natural key + arena/competition id + timestamps are
--     pulled out as real columns, purely for indexing and ops queries.
--   * Natural-id primary keys, no fetch-time in any key: a given hand /
--     replay / submission exists in exactly one row. Re-loading is
--     deduplicated by construction (INSERT ... ON CONFLICT DO NOTHING).
--   * The one deliberate time series is raw.leaderboard_history
--     (append-on-change), because the server-side TrueSkill score/rank is
--     not reconstructable from hands.
--
-- This file is idempotent (IF NOT EXISTS everywhere) and is applied
-- automatically by arena_etl.py before every run (`init-db` applies it
-- explicitly). Documentation is attached in-database via COMMENT ON, so
-- `\dt+ raw.*` / `\d+ raw.tables` in psql explains itself.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS raw;

COMMENT ON SCHEMA raw IS
  'Verbatim landing zone for dev.fun Arena API payloads (Stage 1, ELT). No transformed data lives here — transform stages read from raw.* and write elsewhere.';

-- ----------------------------------------------------------------------------
-- raw.competitions — one row per competition, from REST /competition/list-all
-- Re-fetch policy: UPSERT (metadata like status/endAt changes over a season).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.competitions (
    competition_id  text        PRIMARY KEY,
    game_type       text,
    season_number   int,
    status          text,
    fetched_at      timestamptz NOT NULL DEFAULT now(),
    payload         jsonb       NOT NULL
);

COMMENT ON TABLE raw.competitions IS
  'One row per competition from GET /api/arena/competition/list-all. Upserted on every run (latest wins); fetched_at = last refresh. NOTE: tRPC arenaId == REST competitionId (verified 2026-07-15), so this id is the join key everywhere.';
COMMENT ON COLUMN raw.competitions.competition_id IS 'Natural id (cuid), e.g. cmr3n8tft01nilecm1u5jlny7 = [poker] heads-up ladder S1. Identical to the tRPC arenaId.';
COMMENT ON COLUMN raw.competitions.game_type      IS 'Extracted from payload.gameType (e.g. TexasHoldem) for filtering; source of truth is payload.';
COMMENT ON COLUMN raw.competitions.season_number  IS 'Extracted from payload.seasonNumber.';
COMMENT ON COLUMN raw.competitions.status         IS 'Extracted from payload.status (Active / Ended) at fetch time.';
COMMENT ON COLUMN raw.competitions.payload        IS 'Verbatim competition object: id, name, description, seasonNumber, gameType, skillFile, startAt/endAt (epoch ms), status.';

-- ----------------------------------------------------------------------------
-- raw.leaderboard_history — append-on-change time series of the arena's own
-- score/rank per agent, from tRPC arena.getLeaderboard.
-- Re-fetch policy: APPEND a row per agent ONLY when a tracked value moved
-- since that agent's most recent row. Flat periods add nothing.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.leaderboard_history (
    arena_id        text        NOT NULL,
    agent_id        text        NOT NULL,
    captured_at     timestamptz NOT NULL DEFAULT now(),
    rank            int,
    total_score     numeric,
    adjusted_bb100  numeric,
    hands_played    int,
    payload         jsonb       NOT NULL,
    PRIMARY KEY (arena_id, agent_id, captured_at)
);

COMMENT ON TABLE raw.leaderboard_history IS
  'Deduplicated time series of server-computed standings (TrueSkill) per agent, from arena.getLeaderboard. A new row is appended only when (rank, total_score, adjusted_bb100, hands_played) differs from the agent''s latest row. Forward-looking only: history starts when polling started — the API exposes no past standings. Chip-based performance curves do NOT need this table; they are derivable from raw.tables (each seat carries chipDelta).';
COMMENT ON COLUMN raw.leaderboard_history.arena_id       IS 'tRPC arenaId == competition_id.';
COMMENT ON COLUMN raw.leaderboard_history.captured_at    IS 'When this capture was taken (loader clock). Part of the PK — this is the one raw table that is a time series by design.';
COMMENT ON COLUMN raw.leaderboard_history.rank           IS 'Extracted from payload.rank (change-tracked).';
COMMENT ON COLUMN raw.leaderboard_history.total_score    IS 'Extracted from payload.totalScore — the ladder''s TrueSkill-style score (change-tracked).';
COMMENT ON COLUMN raw.leaderboard_history.adjusted_bb100 IS 'Extracted from payload.adjustedBb100 when present (change-tracked). Absent on the heads-up ladder roster as of 2026-07-15 → NULL.';
COMMENT ON COLUMN raw.leaderboard_history.hands_played   IS 'Extracted from payload.totalSubmissions (≈ hands played on the ladder; change-tracked). Enables the per-N-hands score grid in the transform stage.';
COMMENT ON COLUMN raw.leaderboard_history.payload        IS 'Verbatim per-agent roster object: id, name, handle, modelName, framework, xHandle, rank, bestRank, totalScore, totalSubmissions, streak, rewardEntry, ...';

CREATE INDEX IF NOT EXISTS ix_raw_leaderboard_agent_time
    ON raw.leaderboard_history (agent_id, captured_at);

-- ----------------------------------------------------------------------------
-- raw.tables — one row per HAND from tRPC arena.getTexasTables (list-pass).
-- Re-fetch policy: DO NOTHING (hands are immutable once settled). fetched_at
-- is first-seen. Writes stay proportional to NEW hands only.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.tables (
    table_id    text        PRIMARY KEY,
    arena_id    text        NOT NULL,
    played_at   timestamptz,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    payload     jsonb       NOT NULL
);

COMMENT ON TABLE raw.tables IS
  'One row per hand (a "table" on the heads-up ladder is a single hand: handCount=1) from arena.getTexasTables. Contains every seat''s hole cards, chip deltas and the result — ~95% of analytical value. Immutable: INSERT ... ON CONFLICT (table_id) DO NOTHING; re-seen hands are silent no-ops.';
COMMENT ON COLUMN raw.tables.table_id   IS 'Natural id (cuid), payload.id. Join key to raw.replays. NOTE: payload.tableNumber is a separate human-facing number; submissions reference it via challenge.uniqueId = "table-<tableNumber>".';
COMMENT ON COLUMN raw.tables.arena_id   IS 'Arena/competition the hand belongs to (request parameter; also in replay payloads as competitionId).';
COMMENT ON COLUMN raw.tables.played_at  IS 'payload.startedAt. Drives lag monitoring and incremental windows.';
COMMENT ON COLUMN raw.tables.fetched_at IS 'First time the loader saw this hand (never updated — DO NOTHING).';
COMMENT ON COLUMN raw.tables.payload    IS 'Verbatim tables[] entry: id, tableNumber, status, startedAt/endedAt, playerCount, handCount, boardCards, winners[] (amount, agentId, agentName, seatNumber, handName, message), seats[] (seatNumber, agentId, agentName, agentHandle, holeCards, payoutChips, totalCommittedChips, chipDelta, stackChips).';

CREATE INDEX IF NOT EXISTS ix_raw_tables_arena_played
    ON raw.tables (arena_id, played_at);

-- ----------------------------------------------------------------------------
-- raw.replays — full event stream per hand from tRPC arena.getTexasReplay,
-- 1:1 with raw.tables (backfilled by the replay-pass).
-- Re-fetch policy: DO NOTHING (immutable).
-- The replay work-list needs no state:
--   SELECT t.table_id FROM raw.tables t
--   LEFT JOIN raw.replays r USING (table_id) WHERE r.table_id IS NULL;
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.replays (
    table_id    text        PRIMARY KEY,
    arena_id    text        NOT NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    payload     jsonb       NOT NULL
);

COMMENT ON TABLE raw.replays IS
  'Full replay per hand from arena.getTexasReplay: {table:{...}, events:[...]}. events[] is the per-decision stream (Joined, TableStarted, HoleCardsDealt, BlindPosted, ActionTaken, StreetDealt, Showdown, Payout, TableEnded). ActionTaken.payload carries action, amount/toAmount, callAmount, pot, legalActions, allowedActions, message and — when the bot provides it — the plaintext REASONING string; each event also has a full table snapshot. Immutable, DO NOTHING.';
COMMENT ON COLUMN raw.replays.table_id IS '= raw.tables.table_id (1:1).';
COMMENT ON COLUMN raw.replays.arena_id IS 'Copied from the raw.tables work-list row; also present inside payload as table.competitionId.';
COMMENT ON COLUMN raw.replays.payload  IS 'Verbatim result.data.json: {table, events}. Event timestamps (occurredAt) are epoch ms.';

CREATE INDEX IF NOT EXISTS ix_raw_replays_arena
    ON raw.replays (arena_id);

-- ----------------------------------------------------------------------------
-- raw.submissions — hero-only per-hand submissions from REST
-- GET /agent/submissions?agentId=&limit=&offset= (fallback surface; the tRPC
-- tables/replays supersede it but we land it for completeness).
-- Re-fetch policy: DO NOTHING (immutable).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.submissions (
    submission_id  text        PRIMARY KEY,
    agent_id       text        NOT NULL,
    competition_id text,
    submitted_at   timestamptz,
    fetched_at     timestamptz NOT NULL DEFAULT now(),
    payload        jsonb       NOT NULL
);

COMMENT ON TABLE raw.submissions IS
  'Hero-only per-hand submissions (our own agents), REST /agent/submissions. Kept as completeness/fallback: unlike raw.tables it only sees the hero''s seat. Immutable, DO NOTHING.';
COMMENT ON COLUMN raw.submissions.submission_id  IS 'payload.id (cuid).';
COMMENT ON COLUMN raw.submissions.agent_id       IS 'The agentId the page was fetched for (request parameter — not in the payload).';
COMMENT ON COLUMN raw.submissions.competition_id IS 'NULL today: the submissions payload carries no competition id (verified 2026-07-15). Poker hands can be joined to raw.tables via payload.challenge.uniqueId = "table-<tableNumber>" ↔ raw.tables.payload->>''tableNumber''.';
COMMENT ON COLUMN raw.submissions.submitted_at   IS 'payload.submittedAt (epoch ms → timestamptz).';
COMMENT ON COLUMN raw.submissions.payload        IS 'Verbatim submission object: id, status, correct, score (hero chip delta), submissionOrder, submittedAt, data (holeCards, seatNumber, stackChips), challenge (uniqueId, status, data, result.winners[], result.boardCards).';

CREATE INDEX IF NOT EXISTS ix_raw_submissions_agent_time
    ON raw.submissions (agent_id, submitted_at);

-- ----------------------------------------------------------------------------
-- raw.agent_stats — latest per-agent aggregate stats from REST
-- GET /agent/{agentId}/stats?competitionId=X.
-- Re-fetch policy: UPSERT in place (latest wins; no history kept — the
-- underlying aggregates are derivable from hands if ever needed).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.agent_stats (
    agent_id        text        NOT NULL,
    competition_id  text        NOT NULL,
    fetched_at      timestamptz NOT NULL DEFAULT now(),
    payload         jsonb       NOT NULL,
    PRIMARY KEY (agent_id, competition_id)
);

COMMENT ON TABLE raw.agent_stats IS
  'Latest snapshot of per-agent profile + aggregate stats (VPIP/PFR/AF/style live under payload.competitions[]). Upserted every run, latest wins.';
COMMENT ON COLUMN raw.agent_stats.competition_id IS 'The competitionId the stats were requested for (request parameter).';
COMMENT ON COLUMN raw.agent_stats.payload        IS 'Verbatim stats response: id, name, handle, rank, bestRank, totalScore, totalSubmissions, streak, form, arenasJoined, competitions[], ...';

-- ----------------------------------------------------------------------------
-- raw.ingest_state — loader bookkeeping (the only non-payload table).
-- One row per (endpoint, scope): scope is the arenaId for hand/leaderboard
-- endpoints and the agentId for submissions.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw.ingest_state (
    endpoint       text        NOT NULL,
    scope          text        NOT NULL,
    cursor         text,
    backfill_done  boolean     NOT NULL DEFAULT false,
    last_run_at    timestamptz,
    last_status    text,
    detail         jsonb,
    PRIMARY KEY (endpoint, scope)
);

COMMENT ON TABLE raw.ingest_state IS
  'Resumable-paging state per (endpoint, scope). While backfill_done=false the loader resumes from cursor and walks to the end of history; once true, incremental runs restart from the newest page and early-stop after N consecutive pages with zero new rows (dedup makes re-seen pages no-ops).';
COMMENT ON COLUMN raw.ingest_state.endpoint      IS 'e.g. arena.getTexasTables, agent/submissions.';
COMMENT ON COLUMN raw.ingest_state.scope         IS 'arenaId for arena-scoped endpoints, agentId for agent-scoped ones.';
COMMENT ON COLUMN raw.ingest_state.cursor        IS 'JSON-encoded last cursor/offset handed back by the API (only meaningful while backfill_done=false).';
COMMENT ON COLUMN raw.ingest_state.backfill_done IS 'true once a full walk reached the end of history (nextCursor null / offset >= total).';
COMMENT ON COLUMN raw.ingest_state.last_status   IS 'ok | running | error:<class> — for ops visibility.';
COMMENT ON COLUMN raw.ingest_state.detail        IS 'Free-form run stats (pages walked, rows inserted, error message, ...).';
