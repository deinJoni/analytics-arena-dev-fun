# Arena ETL — raw ingestion (Stage 1) + analytics transform (Stage 2)

Two scripts, no orchestrator, both idempotent and resumable:

1. **`arena_etl.py`** pulls every readable dev.fun Arena endpoint and lands the
   responses verbatim (JSONB) in the Postgres `raw` schema.
2. **`arena_transform.py`** turns `raw` into typed analytics tables
   (`stg` → `int` → `mart`) built around the ladder's **duplicate-poker mirror
   pairs** — luck-cancelled skill metrics, all-in EV adjustment, leak buckets,
   and a replayer feed for the app's five views. Card math lives in
   [`holdem.py`](holdem.py).

- Stage 1 requirements/decisions: [`PRD_raw.md`](PRD_raw.md) · DB docs:
  [`SCHEMA.md`](SCHEMA.md) + [`schema.sql`](schema.sql)
- Stage 2 requirements/decisions: [`PRD_analytics_etl.md`](PRD_analytics_etl.md)
  · DB docs: [`ANALYTICS.md`](ANALYTICS.md) + [`schema_analytics.sql`](schema_analytics.sql)
- Sample API payloads (captured 2026-07-15): [`samples/`](samples/)

## Discovery results (2026-07-15)

| Open question (PRD §10) | Answer |
|---|---|
| `arenaId` ↔ `competitionId` | **Same string** — the tRPC calls accept the REST competition id |
| Heads-up ladder id | `cmr3n8tft01nilecm1u5jlny7` — "[poker] heads-up ladder S1", Active |
| Ladder exposes tRPC replays? | **Yes** — `getTexasTables` + `getTexasReplay` both return full data |
| Hero agent | "dein Joni" (@pokaH01) = `cmqvg49so537et6mn1cbrl1vm` |
| Paging | tables: numeric `nextCursor` (offset-like), newest first. submissions: `offset`/`total`, newest first |

## Setup

```bash
cd etl
cp .env.example .env          # fill in ARENA_RAW_DB_URL
# either: uv (reads the inline dependency block)
uv run arena_etl.py status
# or: plain venv
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python arena_etl.py status
```

Config lives in `.env` next to the script (or real env vars on the server):
`ARENA_RAW_DB_URL`, `ARENA_IDS`, `HERO_AGENT_IDS` — see `.env.example`.

## Local test (throwaway Postgres in Docker)

```bash
docker run -d --name arena-etl-pg -e POSTGRES_USER=arena \
  -e POSTGRES_PASSWORD=arena -e POSTGRES_DB=arena -p 5455:5432 postgres:16

uv run arena_etl.py init-db
uv run arena_etl.py run --max-pages 3 --max-replays 10   # capped smoke test
uv run arena_etl.py status

uv run arena_transform.py selftest                        # no DB needed
uv run arena_transform.py run --limit 10                  # capped transform
uv run arena_transform.py status
```

`--max-pages` / `--max-replays` / `--limit` cap the walks for testing; without
them `run` does the real thing.

## Commands

| Command | What it does |
|---|---|
| `init-db` | apply `schema.sql` (idempotent; also auto-applied on every run) |
| `run` | full pass: discover → leaderboard → tables → replays → submissions → stats, then a status report. Exit code 1 if any stage failed. |
| `discover` / `leaderboard` / `tables` / `replays` / `submissions` / `stats` | run a single stage |
| `status` | row counts, freshest `played_at` (lag), replay backlog, ingest state |

Backfill and incremental are the same command: the first `run` walks all of
history (resumable — a killed run continues from the persisted cursor); later
runs stop after a few pages of already-known hands and only backfill missing
replays (`raw.tables LEFT JOIN raw.replays`).

## Commands — `arena_transform.py` (Stage 2)

| Command | What it does |
|---|---|
| `init-db` | apply `schema_analytics.sql` (idempotent; also auto-applied on every run) |
| `run` | watermark-incremental transform: walk new replays → mirror pairs → marts → QA gate. Exit code 1 on QA violations (data stays committed). |
| `rebuild` | truncate `stg`/`int`/`mart` (keeps the equity cache) and re-run everything |
| `status` | row counts per tier, watermark vs raw, last QA result |
| `selftest` | walker + equity engine checks against `samples/` — no DB needed |

**The hourly pipeline is `arena_etl.py run` followed by `arena_transform.py
run`** (that is what the systemd unit / crontab example execute). Full details
of what gets built and why: [`ANALYTICS.md`](ANALYTICS.md).

## Deploy on the server

The DB runs in Docker on the server; the loader connects via the DSN — start
Postgres with `-p 127.0.0.1:5432:5432` (or put the loader in the same compose
network) and point `ARENA_RAW_DB_URL` at it.

```bash
# on the server
sudo mkdir -p /opt/arena-etl && sudo chown $USER /opt/arena-etl
rsync -av --exclude .venv --exclude .env etl/ server:/opt/arena-etl/
ssh server 'cd /opt/arena-etl && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt'
# create /opt/arena-etl/.env with the real DSN, then backfill once (loader can
# take hours on a full history walk; the transform then processes what landed —
# its first pass is dominated by warming the preflop equity cache):
ssh server 'cd /opt/arena-etl && .venv/bin/python arena_etl.py run && .venv/bin/python arena_transform.py run'
```

**Shipping new code = rsync + the next `run`; nothing else touches the DB.**
`arena_transform.py` re-applies `schema_analytics.sql` on every command
(`ensure_schema`), so new/changed mart tables are `CREATE …IF NOT EXISTS`-ed and
the read-only web role is (re)granted automatically — the schema ends with a
guarded `GRANT SELECT ON ALL TABLES IN SCHEMA mart TO app_readonly` that no-ops
when the role is absent (local dev) and covers any table added since the last
deploy when it is present (server). So after `rsync`-ing updated `etl/`, a plain
`arena_transform.py run` (or just waiting for the hourly timer) creates,
populates, and grants everything — no manual `CREATE`/`GRANT` step. Aggregate
marts are rebuilt in full each run, so a schema change is picked up on the very
next run with no backfill.

Then schedule hourly (PRD §9) with **one** of:

- systemd (recommended — start the timer early; leaderboard history only
  accrues while polling runs):
  ```bash
  sudo cp deploy/arena-etl.service deploy/arena-etl.timer /etc/systemd/system/
  # edit User= and paths in arena-etl.service if they differ
  sudo systemctl daemon-reload && sudo systemctl enable --now arena-etl.timer
  journalctl -u arena-etl.service -f     # logs
  ```
- cron: see `deploy/crontab.example`.

## Monitoring

`arena_etl.py status` (also printed at the end of every `run`) shows row
counts per table, the freshest hand timestamp vs. now (ingest lag), the
replay backlog, and per-endpoint ingest state. Every stage logs
`seen / inserted` counts, so a healthy incremental run reads like:
`tables[…]: done — 4 pages, 400 seen, 37 new`.

`arena_transform.py status` shows the analytics side: rows per stg/int/mart
table, the walk watermark vs. raw, and the last QA result. A QA violation
(zero-sum break, mirror deck mismatch, …) makes the transform exit 1, which
fails the systemd unit / cron mail — that is the alert channel.
