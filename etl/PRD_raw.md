# PRD — Arena Raw Data Ingestion (Stage 1)

**Status:** Draft for review
**Scope:** Extract all readable dev.fun Arena data and load it **raw** into
remote Postgres. No transformation, no analytics — that is a later stage on the
server.
**Last updated:** 2026-07-15

---

## 1. Objective

Stand up a small, standalone ETL script in a fresh repository that pulls **every
readable endpoint** of the dev.fun Arena API and lands the responses **verbatim
(raw JSON)** in our remote Postgres. Priority target is the **Heads-up Ladder**
season, but the loader is generic across competitions.

The single goal of Stage 1 is completeness: get *all* the data — every hand,
every seat's cards, the full action log, reasoning strings, rosters, and
metadata — safely into Postgres. We have 50–100 GB of headroom, so we optimise
for "lose nothing," not for a tidy model. Transformation happens later, in the
database, against what we've landed.

**Design stance:** raw-first (ELT). Store the API payloads as JSONB, keyed by
their natural IDs, idempotent and resumable. Do **not** reshape fields on the way
in — that decouples ingestion from API shape and means schema drift never breaks
a load.

---

## 2. Scope

**In scope**
- Discover all competitions and pull their metadata + leaderboards.
- Pull every hand (all seats, all cards, results) for target arenas.
- Pull every hand's full replay (action log + per-decision reasoning).
- Pull per-agent submissions and per-agent stats.
- Land all of the above raw in Postgres; idempotent, resumable, scheduled.

**Out of scope (later stages)**
- Any transformation, normalisation, or analytics tables/marts.
- Dashboards or metrics.
- Live play, agent registration, wallet/payments, auth-gated writes.

---

## 3. Design principles

1. **Raw JSONB, verbatim.** One landing row per API object; the full payload goes
   in a `payload jsonb` column untouched. Pull out only the natural key +
   competition/arena id + timestamps as real columns for indexing.
2. **Deduplicated, insert-once — no snapshots.** Hands (and their replays) are
   immutable once settled, so each is stored **exactly once**, keyed on its
   natural id. We load incrementally and will re-see the same hands on every
   run; re-seen rows are **no-ops**, never duplicates. Concretely: `INSERT …
   ON CONFLICT (natural_key) DO NOTHING`. We do **not** keep per-fetch snapshot
   rows of a hand; `fetched_at` records first-seen. (Agent *scores* are the
   deliberate exception — see §6.1 — captured as an append-on-change time series,
   itself still deduplicated so identical repeats aren't stored.)
3. **Resumable.** Persist pagination cursors/offsets and a work-list watermark so
   a killed run continues where it stopped.
4. **Whole-field.** Pull entire arenas (no per-agent filter) to capture all bots'
   hands, not just ours.
5. **Two-pass for hands.** A cheap list-pass captures ~95% of value (cards +
   results); a slower replay-pass backfills action logs. Decoupled so either can
   run independently.
6. **Fail loud, retry soft.** Retry transient errors with backoff; surface
   persistent shape/HTTP errors rather than silently dropping rows.
7. **Small footprint.** One script/CLI, a thin HTTP layer, `psycopg`. No
   orchestrator.

---

## 4. Source endpoints

Base host: `https://arena.dev.fun`. Read endpoints need **no auth** (just
`Content-Type: application/json`). Two API surfaces.

### 4.1 tRPC API (full fidelity — primary)

The internal API the web app uses to render replays. Call convention (must be
replicated exactly):

```
# Request:  GET /api/{procedure}?input=<url-encoded JSON>
input = urlencode( json.dumps({ "json": <payload> }, separators=(",", ":")) )
url   = f"https://arena.dev.fun/api/{procedure}?input={input}"

# Response: the useful body is nested at
result.data.json
```

The `{"json": …}` request envelope and the `result.data.json` response unwrap are
the two things that are easy to get wrong.

| Procedure | Payload | Returns | Pagination |
|-----------|---------|---------|------------|
| `arena.getLeaderboard` | `{arenaId}` | roster of agents in the arena | none |
| `arena.getTexasTables` | `{arenaId, agentId?, limit, cursor, direction?}` | `{tables:[…], nextCursor}` — one entry per hand, with every seat's cards + results | **cursor**: pass `nextCursor` back as `cursor`; stop when null |
| `arena.getTexasReplay` | `{tableId}` | `{table:{…}, events:[…]}` — full per-decision event stream | none (one call per hand) |

### 4.2 REST API (metadata + hero-only fallback)

Base path `https://arena.dev.fun/api/arena`.

| Endpoint | Purpose | Pagination |
|----------|---------|------------|
| `GET /__introspection` | Live schema: endpoints, request/response shapes, enums. **Run first** to confirm shapes before a load. | — |
| `GET /competition/list-all` | Every competition, including past seasons | — |
| `GET /competition/list-active` | Currently running competitions | — |
| `GET /competition?competitionId=X` | One competition's metadata | — |
| `GET /competition/leaderboard?competitionId=X` | Ranked agents for a competition | — |
| `GET /competition/challenges?competitionId=X` | Recent challenges (prediction games; likely empty for poker) | — |
| `GET /agent/{agentId}/stats?competitionId=X` | Per-agent aggregate stats (VPIP/PFR/AF/style) | — |
| `GET /agent/submissions?agentId=X&limit=&offset=` | Hero-only per-hand submissions → `{total, data:[…]}` | **offset**: read `total`, bump `offset` by page size |

The tRPC `getTexasTables`/`getTexasReplay` supersede the REST hand endpoints
(they carry all seats, not just the hero). We still land `submissions` and
`stats` for completeness and as a fallback if a competition doesn't expose tRPC
replays.

---

## 5. Data fields to expect (what lands in the JSONB)

Documented so the later transform stage knows what's in each payload. We store
the whole object; these are the fields that matter.

**`arena.getLeaderboard` — per agent:**
`id`, `name`, `handle`, `modelName`, `framework`, `xHandle`, `rank`,
`totalScore`, `adjustedBb100`.

**`arena.getTexasTables` — per hand (`tables[]`):**
- table/hand id, `arenaId`/competition id, timestamp
- `seats[]`: `seatNumber`, `agentId` / `agentName`, `holeCards`, `stackChips`,
  `chipDelta`
- `boardCards`
- `winners[]`: `seatNumber`, `agentName`, `handName` (showdown hand, e.g.
  "Two Pair", or "Uncontested" on a fold-out)
- `nextCursor` on the envelope (for paging, not per hand)

**`arena.getTexasReplay` — per hand:**
- `table`: `seats`, `winners`, `boardCards`
- `events[]`, typed:
  - `ActionTaken`: `seatNumber`, `agentName`, `action`, `toAmount`/`amount`,
    `callAmount`, `pot`, `dealerSeatNumber`, `reasoning`, `message`
  - `BlindPosted`: small / big blind amounts
  - `Showdown`: seats + hand names
  - `TableStarted`: `dealerSeatNumber` (the button)
- `reasoning` is the notable field — each bot's strategy in plaintext.

**`GET /agent/submissions` — per submission (hero-only):**
`data.holeCards`, `data.seatNumber`, `data.stackChips`, `score` (hero chip
delta), `challenge.result.winners[]` (`seatNumber`, `agentName`, `handName`),
`challenge.result.boardCards`, `challenge.uniqueId` (a poker hand starts with
`table-`).

**`GET /agent/{agentId}/stats`:** profile + per-competition VPIP / PFR / AF /
style aggregates.

---

## 6. Postgres raw landing schema

A `raw` schema, one landing table per resource. Each: natural-key PK,
competition/arena id + timestamps as columns for indexing, everything else in
`payload jsonb`. Nothing is transformed.

Every PK below is a **natural id** (no `fetched_at` in any key), so a given
hand/table/submission can exist in exactly one row. Re-loading is dedup by
construction.

| Table | Natural key (PK) | Extra indexed columns | Holds | On re-fetch |
|-------|------------------|-----------------------|-------|-------------|
| `raw.competitions` | `competition_id` | `game_type`, `season_number`, `fetched_at` | list-all / competition metadata | upsert (metadata can change) |
| `raw.leaderboard_history` | `(arena_id, agent_id, captured_at)` | `rank`, `total_score` | agent score/rank over time (see §6.1) | **append-on-change** (dedup: new row only when a tracked value moves) |
| `raw.tables` | `table_id` | `arena_id`, `played_at`, `fetched_at` | one row per hand from `getTexasTables` | **DO NOTHING** (immutable — dedup) |
| `raw.replays` | `table_id` | `arena_id`, `fetched_at` | full event stream from `getTexasReplay` (1:1 with `raw.tables`) | **DO NOTHING** (immutable — dedup) |
| `raw.submissions` | `submission_id` | `agent_id`, `competition_id`, `fetched_at` | hero-only submissions | **DO NOTHING** (immutable — dedup) |
| `raw.agent_stats` | `(agent_id, competition_id)` | — | latest per-agent stats | upsert in place (latest wins) |

Plus one bookkeeping table:

| Table | Purpose |
|-------|---------|
| `raw.ingest_state` | Per `(endpoint, arena_id)`: last `cursor` / `offset`, `last_run_at`, status. Drives resumable paging. |

Illustrative DDL for the pattern (the rest follow the same shape):

```sql
CREATE SCHEMA IF NOT EXISTS raw;

CREATE TABLE IF NOT EXISTS raw.tables (
    table_id    text PRIMARY KEY,
    arena_id    text NOT NULL,
    played_at   timestamptz,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    payload     jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_raw_tables_arena ON raw.tables (arena_id);

CREATE TABLE IF NOT EXISTS raw.replays (
    table_id    text PRIMARY KEY,
    arena_id    text NOT NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    payload     jsonb NOT NULL
);
```

Write pattern by table type:

```sql
-- Immutable hands / replays / submissions: dedup by skipping re-seen rows.
INSERT INTO raw.tables (table_id, arena_id, played_at, payload)
VALUES (%s, %s, %s, %s)
ON CONFLICT (table_id) DO NOTHING;

-- Agent score/rank: append a new row ONLY when a tracked value has moved
-- since that agent's most recent row (a deduplicated time series).
INSERT INTO raw.leaderboard_history
       (arena_id, agent_id, captured_at, rank, total_score,
        adjusted_bb100, hands_played, payload)
SELECT %(arena_id)s, %(agent_id)s, now(), %(rank)s, %(total_score)s,
       %(adjusted_bb100)s, %(hands_played)s, %(payload)s
WHERE NOT EXISTS (
    SELECT 1 FROM raw.leaderboard_history h
    WHERE h.arena_id = %(arena_id)s AND h.agent_id = %(agent_id)s
    ORDER BY h.captured_at DESC LIMIT 1
    -- compare tracked fields; skip insert if unchanged
    AND (h.rank, h.total_score, h.adjusted_bb100)
        IS NOT DISTINCT FROM (%(rank)s, %(total_score)s, %(adjusted_bb100)s)
);
```

`DO NOTHING` (not `DO UPDATE`) is deliberate for the hand tables: since we re-see
every historical hand on each incremental run, updating in place would rewrite
millions of unchanged rows every run — dead tuples, vacuum churn, and table bloat
on a table meant to grow to tens of GB. Skipping re-seen rows keeps writes
proportional to *new* hands only, and pins `fetched_at` to first-seen.

The replay work-list is simply `raw.tables LEFT JOIN raw.replays … WHERE
r.table_id IS NULL` — hands not yet backfilled. That makes the replay-pass
resumable with no extra state.

### 6.1 Tracking agent score over time

Two different "score over time" exist, and only one needs capturing:

- **Chip performance** (cumulative `chipDelta`, bb/100) is **derivable** from the
  deduplicated hand stream — every hand already stores each agent's `chipDelta`.
  So "score after every 200 hands," or any other window, is a transform-stage
  query, computed retroactively at any granularity with **no extra rows**. This
  needs nothing beyond the hand tables.
- **The arena's own score** (`totalScore`, `rank`, `adjustedBb100` — TrueSkill on
  the ladder) is server-computed and **not** reconstructable from chip deltas.
  This is what `raw.leaderboard_history` captures.

`raw.leaderboard_history` is an **append-on-change time series**: each scheduled
run pulls `getLeaderboard {arenaId}` and appends a row per agent *only if* a
tracked value moved since that agent's last row. That gives real score/rank
history while staying deduplicated — a flat run where nothing changed adds
nothing. Capture cadence = the ingestion schedule (§9).

```sql
CREATE TABLE IF NOT EXISTS raw.leaderboard_history (
    arena_id       text        NOT NULL,
    agent_id       text        NOT NULL,
    captured_at    timestamptz NOT NULL DEFAULT now(),
    rank           int,
    total_score    numeric,
    adjusted_bb100 numeric,
    hands_played   int,
    payload        jsonb       NOT NULL,
    PRIMARY KEY (arena_id, agent_id, captured_at)
);
```

**Important — score history is forward-looking.** `getLeaderboard` returns only
*current* standings; the arena exposes no history endpoint. So the server-side
rank/`total_score` climb is captured only from the moment ingestion starts, at
the resolution of the polling cadence. There is no way to backfill the server's
rank trajectory for the period before we began polling — **start the loader early
to capture more of the climb.** (The chip-based performance curve, by contrast,
*is* reconstructable for the full season from backfilled hands; only the
TrueSkill rank/score series is limited to what we capture live, and could at best
be *approximated* retroactively by replaying ordered match results in the
transform stage.)

**On the "every 200 hands" idea:** if the roster exposes a per-agent
`hands_played` count, you can instead (or additionally) gate the append on that
count crossing a new 200-hand boundary, giving a regular hand-milestone grid
rather than a wall-clock one. Whether `hands_played` is present on the roster is a
discovery item (§10). If it isn't, on-change capture on a short schedule is the
robust default, and the exact per-200-hand series is still recoverable later by
joining score captures against cumulative hand counts from `raw.tables`.

---

## 7. Ingestion flow

1. **Discovery.** `GET /__introspection` (confirm shapes) → `GET
   /competition/list-all` → upsert `raw.competitions`. Resolve the `arenaId`(s)
   to load (Heads-up Ladder first). *Confirm whether the tRPC `arenaId` equals
   the REST `competitionId` or needs mapping — see open questions.*
2. **Leaderboard (score history).** `getLeaderboard {arenaId}` → **append-on-change**
   into `raw.leaderboard_history` (a new row per agent only when rank/score moved).
   Cheap; run every scheduled pass so score/rank history accrues without
   redundant rows. See §6.1.
3. **List-pass (hands).** Page `getTexasTables {arenaId, limit, cursor}` until
   `nextCursor` is null, inserting into `raw.tables` with `ON CONFLICT DO
   NOTHING`. Persist the cursor in `raw.ingest_state` between pages. Re-seen hands
   are silent no-ops, so re-runs never duplicate; for scheduled runs, an
   early-stop after N consecutive all-known pages avoids re-walking history at
   all.
4. **Replay-pass (hands).** For each `table_id` in the work-list, call
   `getTexasReplay {tableId}` → insert `raw.replays` with `ON CONFLICT DO
   NOTHING`. Modest concurrency; dedup by key, so interruptible.
5. **Submissions + stats.** For our hero agent id(s): page
   `/agent/submissions` by offset → `raw.submissions`; pull `/agent/{id}/stats`
   → `raw.agent_stats`.

Backfill = run 1–5 to completion once. Incremental = re-run on a schedule; steps
3–4 self-limit to new hands via cursor early-stop + the LEFT JOIN work-list.

---

## 8. Config & secrets

- **Postgres DSN** in an env var (e.g. `ARENA_RAW_DB_URL`), never committed.
- Read endpoints need no key. If we later add any auth-gated pull, the API key
  lives in env only.
- Target arena id(s) and hero agent id(s) via env / CLI flags, not hardcoded.
- `.env` for local, real env vars on the server.

---

## 9. Operations & scheduling

- Runs the same on laptop and server; only the DSN differs.
- Schedule on the server with **cron or a systemd timer** (no orchestrator).
  Cadence set by ladder hand-rate — start hourly, tune from observed volume.
- **Retry/backoff** on every request (the API rate-limits/congests): ~4–5 tries,
  increasing sleep.
- **Monitoring:** log rows upserted per table per run; a simple lag check (max
  `played_at` in `raw.tables` vs. now, and count of `raw.tables` without a
  matching `raw.replays`).

---

## 10. Open questions

1. **`arenaId` ↔ `competitionId`.** Are they the same string, or is a mapping
   needed between REST discovery and tRPC hand calls? Resolve in discovery.
2. **Heads-up Ladder arena id + season number** — the one hard input needed to
   start.
3. **Does the ladder expose tRPC replays?** It's the sandbox "submit-a-bot"
   mode; verify `getTexasTables`/`getTexasReplay` return data before committing.
   If not, `submissions` is the raw fallback.
4. **How far back to backfill** — the current ladder season only, or all
   competitions from `list-all`? (Storage allows "all.")
5. **Refresh cadence** — how fresh does raw need to be?

---

## 11. Milestones

- **M0 — Discovery:** introspection captured, competitions listed, ladder arena
  id resolved, replay availability confirmed, sample payloads saved.
- **M1 — Schema up:** `raw` schema + `ingest_state` created in Postgres.
- **M2 — Backfill:** full list-pass + replay-pass for the ladder landed raw;
  submissions + stats + leaderboard captured.
- **M3 — Scheduled:** resumable incremental run on a timer on the server, with
  basic row-count/lag logging.