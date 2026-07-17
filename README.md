# Arena Analytics — dev.fun heads-up poker ladder

Analytics pipeline for the dev.fun Arena **[poker] heads-up ladder** (Season 1,
`competition_id = cmr3n8tft01nilecm1u5jlny7`). It ingests every readable Arena
API surface into Postgres and transforms it into typed analytics tables for
agent developers tuning their bots: *how am I doing → where am I bleeding
chips → show me those exact hands → what was my bot thinking.*

Two plain Python scripts, one Postgres, a timer. No orchestrator.

```
dev.fun Arena API ──► arena_etl.py ──► raw ──► arena_transform.py ──► stg ─► int ─► mart ──► app (5 views)
                      (Stage 1)                (Stage 2, + holdem.py equity)
```

## The core idea: duplicate poker / mirror pairs

The ladder plays **duplicate poker** (confirmed empirically): every deck is
dealt twice within a block — hole cards stay glued to the *seat*, the two
agents swap seats, and the dealer button stays on seat 1. The replay `Joined`
events carry the pairing keys:

```
mirror_pair_id = sandboxPvpBlockId ':' ceil(sandboxPvpHandNumber / 2)
orientation    = 1 (odd hand number, first-dealt) | 2 (even, the mirror)
```

Across a completed pair each agent has played **both sides of the identical
deck**, so card and button luck cancel by construction. That makes three
win-rates possible side by side:

- **raw bb/100** — realized results (noisy),
- **EV-adjusted bb/100** — all-ins with cards to come replaced by exact
  equity × pot (removes coinflips),
- **duplicate-adjusted bb/100** — summed over completed mirror pairs: the
  honest, luck-cancelled skill number. Zero-sum per matchup.

Plus the headline leak signal: **mirror_delta_bb** — your result minus your
opponent's result *on the identical cards*, bucketed by spot
(position × street × board texture × line).

## Data sources (dev.fun Arena API)

All public/readable, no auth. tRPC `arenaId` == REST `competitionId`.

| Source | Endpoint | Lands in |
|---|---|---|
| Competition registry | REST `GET /api/arena/competition/list-all` | `raw.competitions` (upsert) |
| Standings (TrueSkill-style score/rank) | tRPC `arena.getLeaderboard` | `raw.leaderboard_history` (append-on-change time series — the API keeps no history, so it accrues only while polling runs) |
| Hands (one "table" = one hand) | tRPC `arena.getTexasTables` (cursor-paged, max 100/page) | `raw.tables` (insert-once) |
| Full replays (event stream per hand) | tRPC `arena.getTexasReplay` | `raw.replays` (insert-once, 1:1 with tables) |
| Hero submissions (own agents only) | REST `GET /api/arena/agent/submissions` | `raw.submissions` (fallback surface) |
| Hero profile stats | REST `GET /api/arena/agent/{id}/stats` | `raw.agent_stats` (upsert) |

Key payload facts the design relies on (verified live 2026-07-15):

- Both seats' **hole cards are always face-up** → exact equity is always
  computable; there is **no equity/EV field** anywhere in the API.
- Every hand is a **fresh 1000-chip buy-in at 5/10 blinds** (100bb) →
  `bb = chips/10`, no stack-depth confounder.
- The native `reasoning` field is **null platform-wide**; the bot's strategy
  text lives in `message` as an optional `Strategy note: …` suffix.
- Blocks run up to **exactly 200 hands** (100 decks); **zero rake** (winner
  takes the whole pot — QA-enforced on every run).
- Replay event `snapshot`s are the state *after* the event; the state an actor
  *faced* comes from the previous event's snapshot.

## Database structure

One Postgres database, four schemas. Full column-level docs live in
[`etl/SCHEMA.md`](etl/SCHEMA.md) (raw) and [`etl/ANALYTICS.md`](etl/ANALYTICS.md)
(analytics), and in-database via `COMMENT ON` (`\d+ mart.leaderboard` in psql
explains itself). DDL: [`etl/schema.sql`](etl/schema.sql) +
[`etl/schema_analytics.sql`](etl/schema_analytics.sql), both idempotent and
auto-applied by their script on every run.

### `raw` — verbatim landing zone (Stage 1)

Every API payload lands unmodified in a `payload jsonb` column, keyed by
natural ids; only indexing/ops columns are extracted. Insert-once tables
(`tables`, `replays`, `submissions`) never change once settled;
`competitions`/`agent_stats` are latest-wins upserts; `leaderboard_history` is
the one deliberate time series. `ingest_state` holds resumable paging cursors.

### `stg` — typed facts (Tier 1)

Flattened 1:1 from `raw.replays` by the Python walker:

| Table | Grain | Highlights |
|---|---|---|
| `stg.hands` | hand | mirror keys + generated `mirror_pair_id`, board, `street_reached`, `went_to_showdown`, pot, blind/buy-in sizes |
| `stg.hand_seats` | hand × seat (2/hand) | hole cards, button/position (HU: button = SB = in position), commitments, generated `chip_delta`/`result_bb` |
| `stg.actions` | ActionTaken event | exact `invested_chips` per action, pot/stack/facing-bet before & after, bet sizing (bb & pot-fraction), parsed `reasoning_text`, `bot_self_reported_eq`, verbatim `message_raw` |
| `stg.transform_state` | bookkeeping | walk watermark + QA results |

### `int` — enrichment (Tier 2)

| Table | Grain | What it is |
|---|---|---|
| `int.mirror_pairs` (+ `int.pair_agent` view) | mirror pair | **the spine**: both orientations linked, `is_complete`, luck-cancelled `skill_delta_bb` (zero-sum) |
| `int.hand_equity` | hand × seat | all-in EV adjustment: `ev_result_bb` = exact equity × pot − committed when betting closed before the river, else = realized |
| `int.action_equity` | action | per-decision equity vs the opponent's *actual* hand (omniscient replayer readout, not a GTO score); exact postflop, seeded Monte Carlo preflop |
| `int.board_texture` | hand | flop texture: paired/monotone/two-tone/rainbow/connected → dry / semi_wet / wet |
| `int.hand_features` | hand × seat | classic HU stat flags with honest `_opp` denominators: VPIP, PFR, 3bet, c-bet/double/triple barrel, check-raise, WTSD/W$SD/WWSF, aggression counters |
| `int.hand_street_lines` | hand × seat × street | one line label per street (`open`, `3bet`, `cbet`, `double_barrel`, `check_raise`, `fold_vs_cbet`, `probe`, `stab`, …) — feeds leak buckets and mirror-divergence attribution |
| `int.equity_cache` | canonical matchup | persistent suit-isomorphism-canonical preflop equity cache (rebuilds: 47s cold → ~4s warm) |

### `mart` — one or two tables per app view (Tier 3)

| View | Tables | Content |
|---|---|---|
| 0 Overview hub | `leaderboard`, `season_summary`, `hands_over_time`, `rank_history` | per-agent raw/dup-adj/EV-adj bb/100 side by side; ladder **`rank` = position by `total_score` DESC** (the order arena.dev.fun shows — *not* the API's own `rank` field, which is a global dev.fun rank across all arenas); `trueskill_mu` (= `totalScore`) & 7d deltas, season header, hourly sparkline; `rank_history` = per-agent position over time, feeding the Overview click-to-expand drill-down |
| 1 Agent dashboard | `agent_stats` | full HU stat block per (agent, IP/OOP/ALL), sizing histogram, per-stat denominators in `opportunities` jsonb — UI greys thin samples |
| 2 Leak map | `agent_leaks` | per-spot results + **`mirror_delta_bb`**: duplicate-differenced result vs the agent who played the identical deck, attributed to the first street where their lines diverged |
| 3 Hand replayer | `hand_header`, `hand_step` | UI-ready timeline (pot/stack/board per step from snapshots), per-decision equity, parsed reasoning, and `mirror_hand_id` for identical-deck side-by-side diffing |
| 4 Head-to-head | `matchups` | the block *is* the matchup: pair counts, luck-cancelled win-rate vs each rival, top ± mirror-delta spots vs that opponent |

## ETL

### Stage 1 — `etl/arena_etl.py` (raw ingestion)

Pages every endpoint into `raw`. Idempotent (`ON CONFLICT` on natural keys),
resumable (persisted cursors; killed runs continue mid-walk), backfill and
incremental are the same command — incremental runs early-stop after a few
all-known pages. Replays are backfilled from a stateless work-list
(`raw.tables LEFT JOIN raw.replays`). Mid-play hands are refreshed until they
settle and replays are fetched only for settled hands, so downstream only ever
sees complete event streams.

### Stage 2 — `etl/arena_transform.py` (+ `etl/holdem.py`)

Watermark-incremental over `raw.replays (fetched_at, table_id)`:

1. **Walk** (Python, batched, one commit per batch): each replay → rows for
   all `stg`/`int` tables in one pass; equity via `holdem.py`
   (phevaluator-based exact enumeration; deterministic-seed MC for preflop
   per-decision equity so re-runs are bit-identical).
2. **Tier 2/3 SQL**: rebuild `int.mirror_pairs` for touched + still-open
   blocks; upsert `hand_header`/`hand_step` incrementally; rebuild the
   aggregate marts per competition.
3. **QA gate**: zero-sum per hand, 2 seats per hand, one hand per
   orientation, action-by-action chip reconciliation, mirror deck identity,
   EV-identity for non-all-in hands. Violations → exit 1 (data stays
   committed) → systemd/cron alerts.

Everything is `ON CONFLICT DO UPDATE` on stable keys: re-runs are no-ops,
`rebuild` (truncate + re-run, cache kept) is always safe.

## Local development

```bash
# throwaway Postgres
docker run -d --name arena-etl-pg -e POSTGRES_USER=arena \
  -e POSTGRES_PASSWORD=arena -e POSTGRES_DB=arena -p 5455:5432 postgres:16

cd etl
cp .env.example .env                       # DSN, arena ids, hero agent ids

uv run arena_etl.py run --max-pages 10 --max-replays 1000   # capped sample
uv run arena_transform.py selftest                          # no DB needed
uv run arena_transform.py run
uv run arena_transform.py status
```

`uv run` reads the scripts' inline dependency blocks; alternatively
`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`.

## Deployment (server)

Postgres runs in Docker ([`db/docker-compose.yml`](db/docker-compose.yml),
bound to 127.0.0.1; password in `db/.env`, gitignored). The pipeline runs from
a plain directory + venv on an hourly systemd timer:

```bash
sudo mkdir -p /opt/arena-etl && sudo chown $USER /opt/arena-etl
rsync -av --exclude .venv --exclude .env etl/ server:/opt/arena-etl/
ssh server 'cd /opt/arena-etl && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt'
# create /opt/arena-etl/.env (real DSN), then backfill once:
ssh server 'cd /opt/arena-etl && .venv/bin/python arena_etl.py run && .venv/bin/python arena_transform.py run'

# schedule hourly (starts the leaderboard-history clock — deploy early):
sudo cp etl/deploy/arena-etl.service etl/deploy/arena-etl.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now arena-etl.timer
journalctl -u arena-etl.service -f
```

The unit runs the loader then the transform; a loader hiccup doesn't block the
transform, and the transform's exit code (QA gate) drives the unit status.
Cron alternative: [`etl/deploy/crontab.example`](etl/deploy/crontab.example).

Notes:

- The first full-history backfill takes hours (the API produces ~2–4 hands/s
  arena-wide and replays are fetched one per hand). The transform's first pass
  is dominated by warming the preflop equity cache; it converges and later
  runs take seconds to minutes.
- The app should read **only `mart.*`** (and treat `sample_n` /
  `mirror_n` / `opportunities` as first-class: thin samples must be greyed).

## Monitoring

- `arena_etl.py status` — row counts, ingest lag, replay backlog, cursors.
- `arena_transform.py status` — stg/int/mart counts, watermark vs raw, last QA.
- Alerting = the QA gate failing the systemd unit / cron mail.

## Repository layout

```
db/docker-compose.yml        server Postgres (local-only port binding)
etl/arena_etl.py             Stage 1: API -> raw (single-file loader)
etl/arena_transform.py       Stage 2: raw -> stg/int/mart (walker + SQL + QA)
etl/holdem.py                equity engine: exact enumeration, canonical cache, seeded MC
etl/schema.sql               raw DDL (idempotent, self-documenting)
etl/schema_analytics.sql     stg/int/mart DDL (idempotent, self-documenting)
etl/SCHEMA.md                raw layer documentation
etl/ANALYTICS.md             analytics layer documentation + PRD reconciliation
etl/PRD_raw.md               Stage 1 requirements
etl/PRD_analytics_etl.md     Stage 2 requirements
etl/README.md                stage-level how-to (commands, flags, deploy detail)
etl/deploy/                  systemd unit + timer, crontab example
etl/samples/                 captured API payloads (2026-07-15)
etl/.env.example             configuration template
```
