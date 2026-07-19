#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "psycopg[binary]>=3.2",
#   "requests>=2.32",
#   "python-dotenv>=1.0",
# ]
# ///
"""Arena raw-data ingestion (Stage 1) — dev.fun Arena API -> Postgres `raw` schema.

Everything lands verbatim as JSONB, keyed by natural ids, idempotent and
resumable (see etl/PRD_raw.md and etl/schema.sql). No transformation here.

Usage:
    arena_etl.py init-db                      apply schema.sql
    arena_etl.py discover                     competitions -> raw.competitions
    arena_etl.py leaderboard                  roster -> raw.leaderboard_history (append-on-change)
    arena_etl.py tables                       hand list-pass -> raw.tables
    arena_etl.py replays                      replay-pass -> raw.replays
    arena_etl.py submissions                  hero submissions -> raw.submissions
    arena_etl.py stats                        hero stats -> raw.agent_stats
    arena_etl.py run                          all of the above, in order (cron entrypoint)
    arena_etl.py status                       row counts + lag + backlog

Config via env / .env (CLI flags override): ARENA_RAW_DB_URL, ARENA_IDS,
HERO_AGENT_IDS — see .env.example.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from threading import local as thread_local

import psycopg
import requests
from psycopg.types.json import Jsonb

log = logging.getLogger("arena_etl")

BASE_URL = "https://arena.dev.fun"
SCRIPT_DIR = Path(__file__).resolve().parent


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

class Config:
    def __init__(self, args: argparse.Namespace):
        self.db_url = args.db_url or os.environ.get("ARENA_RAW_DB_URL", "")
        self.arena_ids = args.arena_id or _split_env("ARENA_IDS")
        self.hero_agent_ids = args.agent_id or _split_env("HERO_AGENT_IDS")
        # The API silently returns an EMPTY page (nextCursor null) for limit > 100,
        # which would look like "backfill complete" — clamp, never exceed.
        self.page_size = min(args.page_size or int(os.environ.get("ARENA_PAGE_SIZE", "100")), 100)
        self.timeout = float(os.environ.get("ARENA_HTTP_TIMEOUT", "30"))
        self.retries = int(os.environ.get("ARENA_MAX_RETRIES", "5"))
        self.throttle = float(os.environ.get("ARENA_THROTTLE_SECONDS", "0.15"))
        self.replay_workers = int(os.environ.get("ARENA_REPLAY_WORKERS", "4"))
        self.early_stop_pages = int(os.environ.get("ARENA_EARLY_STOP_PAGES", "3"))
        # Test/safety caps (0 = unlimited)
        self.max_pages = args.max_pages
        self.max_replays = args.max_replays

    def require_db(self) -> str:
        if not self.db_url:
            sys.exit("ARENA_RAW_DB_URL is not set (env, .env, or --db-url).")
        return self.db_url

    def require_arenas(self) -> list[str]:
        if not self.arena_ids:
            sys.exit("No arena ids: set ARENA_IDS in env/.env or pass --arena-id.")
        return self.arena_ids


def _split_env(name: str) -> list[str]:
    return [x.strip() for x in os.environ.get(name, "").split(",") if x.strip()]


# ---------------------------------------------------------------------------
# HTTP layer (tRPC + REST), retry with backoff, thread-local sessions
# ---------------------------------------------------------------------------

class ApiError(RuntimeError):
    pass


class Api:
    RETRY_STATUS = {429, 500, 502, 503, 504}

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._tl = thread_local()

    @property
    def _session(self) -> requests.Session:
        s = getattr(self._tl, "session", None)
        if s is None:
            s = requests.Session()
            s.headers.update({
                "Content-Type": "application/json",
                "User-Agent": "arena-raw-etl/1.0",
            })
            self._tl.session = s
        return s

    def _get(self, url: str, params: dict | None = None) -> dict:
        last_err: Exception | None = None
        for attempt in range(1, self.cfg.retries + 1):
            try:
                resp = self._session.get(url, params=params, timeout=self.cfg.timeout)
                if resp.status_code in self.RETRY_STATUS:
                    raise ApiError(f"HTTP {resp.status_code} from {url}")
                resp.raise_for_status()
                if self.cfg.throttle:
                    time.sleep(self.cfg.throttle)
                return resp.json()
            except (requests.ConnectionError, requests.Timeout, ApiError,
                    json.JSONDecodeError, ValueError) as err:
                last_err = err
                if attempt == self.cfg.retries:
                    break
                sleep = min(2 ** attempt, 30) + random.uniform(0, 1)
                log.warning("retry %d/%d after %s (sleep %.1fs)",
                            attempt, self.cfg.retries, err, sleep)
                time.sleep(sleep)
        raise ApiError(f"giving up on {url}: {last_err}")

    def trpc(self, procedure: str, payload: dict) -> dict:
        """tRPC call convention: GET /api/{proc}?input=urlencode({"json": payload});
        the useful body is nested at result.data.json."""
        input_ = json.dumps({"json": payload}, separators=(",", ":"))
        body = self._get(f"{BASE_URL}/api/{procedure}", params={"input": input_})
        try:
            return body["result"]["data"]["json"]
        except (KeyError, TypeError):
            raise ApiError(f"unexpected tRPC envelope from {procedure}: "
                           f"{json.dumps(body)[:500]}")

    def rest(self, path: str, params: dict | None = None) -> dict:
        return self._get(f"{BASE_URL}/api/arena{path}", params=params)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def parse_ts(value) -> datetime | None:
    """API timestamps come as epoch-ms ints (replays, competitions, submissions)
    or ISO-8601 strings (table list). Normalise to aware UTC datetimes."""
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


# ---------------------------------------------------------------------------
# DB layer
# ---------------------------------------------------------------------------

# Single-instance guard. Once a run takes longer than the timer interval,
# systemd fires the next trigger into a still-running pipeline; without this
# two loaders would walk the same pages against the API. Session-scoped, so a
# crashed run releases it when its connection drops — no stale-lock cleanup.
# arena_transform.py holds a DIFFERENT key on purpose: loader and transform are
# safe to overlap (the transform only reads raw.*), only self-overlap is not.
ADVISORY_LOCK = (4711, 1)  # arena_transform.py uses (4711, 2)


def try_advisory_lock(conn, classid: int, objid: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s, %s)", (classid, objid))
        return cur.fetchone()[0]


class Db:
    def __init__(self, dsn: str):
        self.conn = psycopg.connect(dsn)

    def close(self):
        self.conn.close()

    def commit(self):
        self.conn.commit()

    def ensure_schema(self):
        schema_path = SCRIPT_DIR / "schema.sql"
        if not schema_path.exists():
            sys.exit(f"schema.sql not found next to the script ({schema_path}); "
                     "deploy the etl/ directory as a whole.")
        with self.conn.cursor() as cur:
            cur.execute(schema_path.read_text())
        self.commit()

    # -- ingest_state ------------------------------------------------------

    def get_state(self, endpoint: str, scope: str) -> tuple[str | None, bool]:
        with self.conn.cursor() as cur:
            cur.execute("SELECT cursor, backfill_done FROM raw.ingest_state"
                        " WHERE endpoint = %s AND scope = %s", (endpoint, scope))
            row = cur.fetchone()
        return (row[0], row[1]) if row else (None, False)

    def set_state(self, endpoint: str, scope: str, *, cursor: str | None,
                  backfill_done: bool, status: str, detail: dict):
        with self.conn.cursor() as cur:
            cur.execute("""
                INSERT INTO raw.ingest_state
                    (endpoint, scope, cursor, backfill_done, last_run_at, last_status, detail)
                VALUES (%s, %s, %s, %s, now(), %s, %s)
                ON CONFLICT (endpoint, scope) DO UPDATE SET
                    cursor = EXCLUDED.cursor,
                    backfill_done = EXCLUDED.backfill_done,
                    last_run_at = EXCLUDED.last_run_at,
                    last_status = EXCLUDED.last_status,
                    detail = EXCLUDED.detail
            """, (endpoint, scope, cursor, backfill_done, status, Jsonb(detail)))

    # -- writers (one per landing table) ------------------------------------

    def upsert_competition(self, comp: dict) -> None:
        with self.conn.cursor() as cur:
            cur.execute("""
                INSERT INTO raw.competitions
                    (competition_id, game_type, season_number, status, fetched_at, payload)
                VALUES (%s, %s, %s, %s, now(), %s)
                ON CONFLICT (competition_id) DO UPDATE SET
                    game_type = EXCLUDED.game_type,
                    season_number = EXCLUDED.season_number,
                    status = EXCLUDED.status,
                    fetched_at = EXCLUDED.fetched_at,
                    payload = EXCLUDED.payload
            """, (comp["id"], comp.get("gameType"), comp.get("seasonNumber"),
                  comp.get("status"), Jsonb(comp)))

    def append_leaderboard(self, arena_id: str, agent: dict) -> int:
        """Append-on-change: insert only if a tracked value moved vs. the
        agent's most recent row. Returns rows inserted (0 or 1)."""
        params = {
            "arena_id": arena_id,
            "agent_id": agent["id"],
            "rank": agent.get("rank"),
            "total_score": agent.get("totalScore"),
            "adjusted_bb100": agent.get("adjustedBb100"),
            "hands_played": agent.get("totalSubmissions"),
            "payload": Jsonb(agent),
        }
        with self.conn.cursor() as cur:
            cur.execute("""
                INSERT INTO raw.leaderboard_history
                    (arena_id, agent_id, captured_at, rank, total_score,
                     adjusted_bb100, hands_played, payload)
                SELECT %(arena_id)s, %(agent_id)s, now(), %(rank)s, %(total_score)s,
                       %(adjusted_bb100)s, %(hands_played)s, %(payload)s
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM (
                        SELECT rank, total_score, adjusted_bb100, hands_played
                        FROM raw.leaderboard_history
                        WHERE arena_id = %(arena_id)s AND agent_id = %(agent_id)s
                        ORDER BY captured_at DESC
                        LIMIT 1
                    ) last
                    WHERE (last.rank, last.total_score, last.adjusted_bb100, last.hands_played)
                          IS NOT DISTINCT FROM
                          (%(rank)s::int, %(total_score)s::numeric,
                           %(adjusted_bb100)s::numeric, %(hands_played)s::int)
                )
            """, params)
            return cur.rowcount

    def insert_table(self, arena_id: str, tbl: dict) -> int:
        """Insert-once, with one carve-out: a hand first seen MID-PLAY (no
        endedAt yet) is refreshed until it settles, so the replay-pass and the
        transform only ever see completed hands. Settled rows stay immutable."""
        with self.conn.cursor() as cur:
            cur.execute("""
                INSERT INTO raw.tables (table_id, arena_id, played_at, payload)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (table_id) DO UPDATE SET
                    played_at = EXCLUDED.played_at,
                    payload = EXCLUDED.payload
                WHERE raw.tables.payload ->> 'endedAt' IS NULL
            """, (tbl["id"], arena_id, parse_ts(tbl.get("startedAt")), Jsonb(tbl)))
            return cur.rowcount

    def insert_replay(self, table_id: str, arena_id: str, payload: dict) -> int:
        with self.conn.cursor() as cur:
            cur.execute("""
                INSERT INTO raw.replays (table_id, arena_id, payload)
                VALUES (%s, %s, %s)
                ON CONFLICT (table_id) DO NOTHING
            """, (table_id, arena_id, Jsonb(payload)))
            return cur.rowcount

    def replay_worklist(self, arena_id: str, limit: int, exclude: set[str]) -> list[str]:
        with self.conn.cursor() as cur:
            cur.execute("""
                SELECT t.table_id
                FROM raw.tables t
                LEFT JOIN raw.replays r USING (table_id)
                WHERE t.arena_id = %s AND r.table_id IS NULL
                  AND t.payload ->> 'endedAt' IS NOT NULL  -- replays are immutable: only fetch settled hands
                  AND NOT (t.table_id = ANY(%s))
                ORDER BY t.played_at DESC NULLS LAST
                LIMIT %s
            """, (arena_id, list(exclude), limit))
            return [row[0] for row in cur.fetchall()]

    def insert_submission(self, agent_id: str, sub: dict) -> int:
        with self.conn.cursor() as cur:
            cur.execute("""
                INSERT INTO raw.submissions
                    (submission_id, agent_id, competition_id, submitted_at, payload)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (submission_id) DO NOTHING
            """, (sub["id"], agent_id, None, parse_ts(sub.get("submittedAt")), Jsonb(sub)))
            return cur.rowcount

    def upsert_agent_stats(self, agent_id: str, competition_id: str, payload: dict):
        with self.conn.cursor() as cur:
            cur.execute("""
                INSERT INTO raw.agent_stats (agent_id, competition_id, fetched_at, payload)
                VALUES (%s, %s, now(), %s)
                ON CONFLICT (agent_id, competition_id) DO UPDATE SET
                    fetched_at = EXCLUDED.fetched_at,
                    payload = EXCLUDED.payload
            """, (agent_id, competition_id, Jsonb(payload)))


# ---------------------------------------------------------------------------
# Ingestion steps (PRD §7)
# ---------------------------------------------------------------------------

def step_discover(api: Api, db: Db) -> int:
    """/competition/list-all -> raw.competitions (upsert)."""
    body = api.rest("/competition/list-all")
    comps = body.get("data") or []
    for comp in comps:
        db.upsert_competition(comp)
    db.commit()
    log.info("discover: upserted %d competitions", len(comps))
    return len(comps)


def step_leaderboard(api: Api, db: Db, arena_id: str) -> int:
    """getLeaderboard -> raw.leaderboard_history (append-on-change)."""
    data = api.trpc("arena.getLeaderboard", {"arenaId": arena_id})
    agents = data.get("agents") or []
    if not agents:
        raise ApiError(f"getLeaderboard returned no agents for {arena_id}")
    inserted = sum(db.append_leaderboard(arena_id, a) for a in agents)
    db.set_state("arena.getLeaderboard", arena_id, cursor=None, backfill_done=True,
                 status="ok", detail={"agents": len(agents), "appended": inserted})
    db.commit()
    log.info("leaderboard[%s]: %d agents, %d rows appended (rest unchanged)",
             arena_id, len(agents), inserted)
    return inserted


def step_tables(api: Api, db: Db, cfg: Config, arena_id: str) -> int:
    """List-pass: page getTexasTables into raw.tables.

    Backfill mode (backfill_done=false): resume from the persisted cursor and
    walk until nextCursor is null, persisting the cursor after every page.
    Incremental mode: restart from the newest page; stop early after
    N consecutive pages that inserted nothing (all hands already known).
    """
    endpoint = "arena.getTexasTables"
    saved_cursor, backfill_done = db.get_state(endpoint, arena_id)
    cursor = json.loads(saved_cursor) if (saved_cursor and not backfill_done) else None

    inserted_total = seen_total = pages = all_known_streak = 0
    while True:
        payload: dict = {"arenaId": arena_id, "limit": cfg.page_size}
        if cursor is not None:
            payload["cursor"] = cursor
        data = api.trpc(endpoint, payload)
        tables = data.get("tables") or []
        next_cursor = data.get("nextCursor")

        inserted = sum(db.insert_table(arena_id, t) for t in tables)
        inserted_total += inserted
        seen_total += len(tables)
        pages += 1

        finished_backfill = next_cursor is None
        db.set_state(
            endpoint, arena_id,
            cursor=None if (backfill_done or finished_backfill) else json.dumps(next_cursor),
            backfill_done=backfill_done or finished_backfill,
            status="running", detail={"pages": pages, "inserted": inserted_total})
        db.commit()  # one transaction per page -> killed runs resume mid-walk

        if pages % 25 == 0:
            log.info("tables[%s]: %d pages walked, %d/%d new", arena_id, pages,
                     inserted_total, seen_total)
        if next_cursor is None:
            backfill_done = True
            break
        cursor = next_cursor  # advance before any break so the state row resumes correctly
        if backfill_done:
            all_known_streak = all_known_streak + 1 if inserted == 0 else 0
            if all_known_streak >= cfg.early_stop_pages:
                log.info("tables[%s]: early stop after %d all-known pages",
                         arena_id, all_known_streak)
                break
        if cfg.max_pages and pages >= cfg.max_pages:
            log.info("tables[%s]: --max-pages %d reached", arena_id, cfg.max_pages)
            break

    db.set_state(endpoint, arena_id,
                 cursor=None if backfill_done else json.dumps(cursor),
                 backfill_done=backfill_done, status="ok",
                 detail={"pages": pages, "seen": seen_total, "inserted": inserted_total})
    db.commit()
    log.info("tables[%s]: done — %d pages, %d seen, %d new (backfill_done=%s)",
             arena_id, pages, seen_total, inserted_total, backfill_done)
    return inserted_total


def step_replays(api: Api, db: Db, cfg: Config, arena_id: str) -> int:
    """Replay-pass: fetch getTexasReplay for every raw.tables row that has no
    raw.replays row yet. The LEFT JOIN work-list makes this resumable with no
    extra state; failed ids are skipped for the rest of the run and retried
    on the next one."""
    inserted_total = 0
    failed: set[str] = set()
    while True:
        batch = db.replay_worklist(arena_id, limit=200, exclude=failed)
        if not batch:
            break
        if cfg.max_replays:
            batch = batch[: max(0, cfg.max_replays - inserted_total - len(failed))]
            if not batch:
                break
        with ThreadPoolExecutor(max_workers=cfg.replay_workers) as pool:
            futures = {
                pool.submit(api.trpc, "arena.getTexasReplay", {"tableId": tid}): tid
                for tid in batch
            }
            for fut in as_completed(futures):
                tid = futures[fut]
                try:
                    payload = fut.result()
                except Exception as err:
                    failed.add(tid)
                    log.error("replay %s failed: %s", tid, err)
                    continue
                inserted_total += db.insert_replay(tid, arena_id, payload)
        db.commit()
        log.info("replays[%s]: %d landed so far (%d failed this run)",
                 arena_id, inserted_total, len(failed))
        if cfg.max_replays and inserted_total >= cfg.max_replays:
            break
    if failed and not inserted_total:
        raise ApiError(f"replay-pass made no progress; {len(failed)} failures "
                       f"(first ids: {sorted(failed)[:3]})")
    db.set_state("arena.getTexasReplay", arena_id, cursor=None, backfill_done=True,
                 status="ok" if not failed else f"ok_with_{len(failed)}_failures",
                 detail={"inserted": inserted_total, "failed": sorted(failed)[:20]})
    db.commit()
    log.info("replays[%s]: done — %d new replays, %d failures", arena_id,
             inserted_total, len(failed))
    return inserted_total


def step_submissions(api: Api, db: Db, cfg: Config, agent_id: str) -> int:
    """Hero-only submissions, offset-paged (newest first — same walk strategy
    as the table list-pass)."""
    endpoint = "agent/submissions"
    saved_cursor, backfill_done = db.get_state(endpoint, agent_id)
    offset = int(saved_cursor) if (saved_cursor and not backfill_done) else 0

    inserted_total = seen_total = pages = all_known_streak = 0
    while True:
        body = api.rest("/agent/submissions",
                        {"agentId": agent_id, "limit": cfg.page_size, "offset": offset})
        rows = body.get("data") or []
        total = body.get("total", 0)

        inserted = sum(db.insert_submission(agent_id, s) for s in rows)
        inserted_total += inserted
        seen_total += len(rows)
        pages += 1
        offset += len(rows)

        at_end = not rows or offset >= total
        db.set_state(endpoint, agent_id,
                     cursor=None if (backfill_done or at_end) else str(offset),
                     backfill_done=backfill_done or at_end,
                     status="running", detail={"offset": offset, "total": total})
        db.commit()

        if at_end:
            backfill_done = True
            break
        if backfill_done:
            all_known_streak = all_known_streak + 1 if inserted == 0 else 0
            if all_known_streak >= cfg.early_stop_pages:
                break
        if cfg.max_pages and pages >= cfg.max_pages:
            break

    db.set_state(endpoint, agent_id,
                 cursor=None if backfill_done else str(offset),
                 backfill_done=backfill_done, status="ok",
                 detail={"pages": pages, "seen": seen_total, "inserted": inserted_total})
    db.commit()
    log.info("submissions[%s]: %d pages, %d seen, %d new", agent_id, pages,
             seen_total, inserted_total)
    return inserted_total


def step_stats(api: Api, db: Db, agent_id: str, competition_id: str) -> None:
    payload = api.rest(f"/agent/{agent_id}/stats", {"competitionId": competition_id})
    db.upsert_agent_stats(agent_id, competition_id, payload)
    db.commit()
    log.info("stats[%s @ %s]: refreshed", agent_id, competition_id)


# ---------------------------------------------------------------------------
# Status / monitoring
# ---------------------------------------------------------------------------

def print_status(db: Db):
    q = """
    SELECT 'raw.competitions', count(*), NULL::timestamptz FROM raw.competitions
    UNION ALL SELECT 'raw.leaderboard_history', count(*), max(captured_at) FROM raw.leaderboard_history
    UNION ALL SELECT 'raw.tables', count(*), max(played_at) FROM raw.tables
    UNION ALL SELECT 'raw.replays', count(*), max(fetched_at) FROM raw.replays
    UNION ALL SELECT 'raw.submissions', count(*), max(submitted_at) FROM raw.submissions
    UNION ALL SELECT 'raw.agent_stats', count(*), max(fetched_at) FROM raw.agent_stats
    """
    with db.conn.cursor() as cur:
        cur.execute(q)
        print(f"{'table':<26} {'rows':>10}   latest")
        for name, count, latest in cur.fetchall():
            print(f"{name:<26} {count:>10}   {latest or '-'}")
        cur.execute("""
            SELECT t.arena_id, count(*) FROM raw.tables t
            LEFT JOIN raw.replays r USING (table_id)
            WHERE r.table_id IS NULL GROUP BY 1
        """)
        backlog = cur.fetchall()
        print("\nreplay backlog (hands without replay):",
              ", ".join(f"{a}={n}" for a, n in backlog) or "none")
        cur.execute("""
            SELECT endpoint, scope, backfill_done, last_run_at, last_status
            FROM raw.ingest_state ORDER BY endpoint, scope
        """)
        rows = cur.fetchall()
        if rows:
            print("\ningest state:")
            for endpoint, scope, done, last_run, status in rows:
                print(f"  {endpoint:<24} {scope:<28} backfill_done={done} "
                      f"last_run={last_run} status={status}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_run(api: Api, db: Db, cfg: Config) -> int:
    """Full pass (backfill and incremental are the same code path — the
    cursor state + early-stop make re-runs cheap). Stages are attempted
    independently so one failing arena/endpoint doesn't block the rest;
    any failure still exits non-zero for cron/systemd to notice."""
    failures: list[str] = []

    def attempt(label: str, fn, *args):
        try:
            return fn(*args)
        except Exception as err:
            log.error("%s FAILED: %s", label, err)
            failures.append(f"{label}: {err}")
            db.conn.rollback()
            return None

    attempt("discover", step_discover, api, db)
    for arena_id in cfg.require_arenas():
        attempt(f"leaderboard[{arena_id}]", step_leaderboard, api, db, arena_id)
        attempt(f"tables[{arena_id}]", step_tables, api, db, cfg, arena_id)
        attempt(f"replays[{arena_id}]", step_replays, api, db, cfg, arena_id)
    for agent_id in cfg.hero_agent_ids:
        attempt(f"submissions[{agent_id}]", step_submissions, api, db, cfg, agent_id)
        for arena_id in cfg.arena_ids:
            attempt(f"stats[{agent_id}@{arena_id}]", step_stats, api, db, agent_id, arena_id)

    print_status(db)
    if failures:
        log.error("run finished with %d failure(s): %s", len(failures), failures)
        return 1
    log.info("run finished cleanly")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=[
        "init-db", "discover", "leaderboard", "tables", "replays",
        "submissions", "stats", "run", "status"])
    parser.add_argument("--db-url", help="Postgres DSN (default: $ARENA_RAW_DB_URL)")
    parser.add_argument("--arena-id", action="append",
                        help="arena/competition id (repeatable; default: $ARENA_IDS)")
    parser.add_argument("--agent-id", action="append",
                        help="hero agent id (repeatable; default: $HERO_AGENT_IDS)")
    parser.add_argument("--page-size", type=int, help="rows per page (default 100)")
    parser.add_argument("--max-pages", type=int, default=0,
                        help="stop list-passes after N pages (testing)")
    parser.add_argument("--max-replays", type=int, default=0,
                        help="stop replay-pass after N replays (testing)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s", stream=sys.stdout)

    try:
        from dotenv import load_dotenv
        load_dotenv(SCRIPT_DIR / ".env")
        load_dotenv()  # also honour a .env in the cwd
    except ImportError:
        pass

    cfg = Config(args)
    api = Api(cfg)
    db = Db(cfg.require_db())
    try:
        if args.command != "status" and not try_advisory_lock(db.conn, *ADVISORY_LOCK):
            log.warning("another arena_etl.py run holds the lock — skipping this run")
            return 0
        db.ensure_schema()
        if args.command == "init-db":
            log.info("schema applied (raw.*)")
            return 0
        if args.command == "discover":
            step_discover(api, db)
            return 0
        if args.command == "leaderboard":
            for a in cfg.require_arenas():
                step_leaderboard(api, db, a)
            return 0
        if args.command == "tables":
            for a in cfg.require_arenas():
                step_tables(api, db, cfg, a)
            return 0
        if args.command == "replays":
            for a in cfg.require_arenas():
                step_replays(api, db, cfg, a)
            return 0
        if args.command == "submissions":
            for agent in cfg.hero_agent_ids:
                step_submissions(api, db, cfg, agent)
            return 0
        if args.command == "stats":
            for agent in cfg.hero_agent_ids:
                for a in cfg.require_arenas():
                    step_stats(api, db, agent, a)
            return 0
        if args.command == "status":
            print_status(db)
            return 0
        if args.command == "run":
            return cmd_run(api, db, cfg)
        return 2
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
