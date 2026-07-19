# Arena HU Ladder — frontend

Read-only diagnostic app for the dev.fun Arena heads-up poker ladder. Renders the
five views from `PRD_fe` on top of the `mart.*` schema produced by
`etl/arena_transform.py` — the app does **no poker math of its own**.

| View | Route | Job |
|---|---|---|
| 0 Overview hub | `/` | standings, season status, cumulative hands |
| 1 Agent dashboard | `/agents/[agentId]` | stat line split ALL / IP / OOP, sizing histograms |
| 2 Leak map | `/agents/[agentId]/leaks` | per-spot `mirror Δbb` (duplicate-differenced) |
| 3 Hand browser + replayer | `/hands`, `/hands/[handId]` | step through decisions, reasoning, omniscient equity, **mirror diff** |
| 4 Head-to-head | `/matchups`, `/matchups/[a]/[b]` | agent×agent dup-adj matrix, spot deltas per rival |
| 5 Compare | `/compare?agents=a,b[,c]` | 2–3 agents' full stat line, side by side (⌘K picker) |

Global agent search lives in the nav: `⌘K` / `Ctrl+K` / `/` opens a fuzzy palette
over the leaderboard. The standings table shows 24h/7d rank-movement chips and a
client-side `csv ↓` export; the hands browser has a filtered `export csv`
(server-side, capped at 5,000 rows). Agent dashboards carry a Trends card
(score / rank / dup-adj bb·100 over time).

Stack: Next.js (App Router, TypeScript), Tailwind v4, TanStack Query, Recharts,
`pg`. API = Route Handlers under `app/api/**` (Node runtime, one parameterized
query each, hard LIMITs, cuid-validated params, competition scoped server-side).

## Run locally

Needs the local ETL Postgres (`db/docker-compose.yml`, container `arena-etl-pg`
on port 5455) with the mart built:

```sh
pnpm install
pnpm dev           # reads .env.local -> postgresql://arena:arena@localhost:5455/arena
```

## Environment

See `.env.example`. Everything is server-side only — never `NEXT_PUBLIC_`.

- `DATABASE_URL` — connection string. In production point it at the transaction
  pooler (PgBouncer/Supavisor), not Postgres directly, with the `app_readonly`
  role (SELECT on `mart.*` only).
- `DATABASE_SSL_CA` — server CA PEM; when set the pool verifies the server
  (`rejectUnauthorized: true`), i.e. verify-full semantics. Use in production.
- `DATABASE_SSL=require` — TLS without CA pinning (encrypts, doesn't
  authenticate). Local docker needs neither.
- `ARENA_COMPETITION_ID` — competition scope, defaults to S1.
- `PGPOOL_MAX` — pool size per instance (default 3; keep small on serverless).

## JSON API

Every view is backed by a public route handler under `/api/**` — the same JSON
the UI fetches, usable for programmatic access. Common rules:

- **GET only.** Node runtime, one parameterized query each, results scoped to
  `ARENA_COMPETITION_ID` server-side.
- **Validation.** Path/params holding agent or hand ids must be CUIDs
  (`^c[a-z0-9]{8,40}$`), else `400 {"error": …}`. Unknown enum values are
  treated as unset (filter ignored). Missing rows → `404`; internal errors
  never leak details (`500 {"error": "internal error"}`).
- **Cache.** List endpoints send `Cache-Control: s-maxage=60, stale-while-revalidate=300`
  (`LIST_CACHE`); hand detail and the CSV export send `no-store`.
- **Response shapes** are the interfaces in `lib/types.ts` (referenced below).

| Method | Path | Params | Response | Cache |
|---|---|---|---|---|
| GET | `/api/season` | — | `SeasonResponse` | LIST |
| GET | `/api/leaderboard` | — | `LeaderboardRow[]` | LIST |
| GET | `/api/hands` | `agentId`, `opponentId` (CUID); `street` = `Preflop\|Flop\|Turn\|River\|Showdown` (min street reached); `minPotBb` (float ≥ 0); `showdownOnly`, `mirrorOnly` (`"true"`); `limit` (int, clamped 1–100, default 50); `cursor` (opaque keyset from prior response) | `HandsResponse` (`{ hands: HandListRow[], nextCursor }`) | LIST |
| GET | `/api/hands/export` | same filters as `/api/hands`; `limit`/`cursor` ignored | CSV download (`text/csv`, `Content-Disposition: attachment; filename="hands.csv"`), header row, **capped at 5,000 rows** (first N matching rows in `started_at DESC` order) | no-store |
| GET | `/api/hands/[handId]` | `handId` (CUID) | `HandDetailResponse` (header, steps, mirror) | no-store |
| GET | `/api/matchups` | — | `MatchupCell[]` | LIST |
| GET | `/api/matchups/[a]/[b]` | `a`, `b` (CUID agent ids) | `MatchupDetail` | LIST |
| GET | `/api/agents/[agentId]/stats` | `agentId` (CUID) | `AgentStatsResponse` (`{ header: LeaderboardRow, splits: AgentStatsSplit[] }`) | LIST |
| GET | `/api/agents/[agentId]/leaks` | `position` = `IP\|OOP`; `street`, `texture` = `dry\|semi_wet\|wet\|na`; `minSampleN` (int, clamped 1–100000, default 30) | `LeakRow[]` | LIST |
| GET | `/api/agents/[agentId]/range` | `agentId` (CUID) | `RangeCombo[]` | LIST |
| GET | `/api/agents/[agentId]/sizing` | `agentId` (CUID) | `SizingSplit[]` | LIST |
| GET | `/api/agents/[agentId]/rank-history` | `agentId` (CUID) | `RankHistoryResponse` (`{ agentId, points: RankHistoryPoint[] }`) | LIST |
| GET | `/api/agents/[agentId]/performance-history` | `agentId` (CUID) | `AgentPerformanceHistoryResponse` (`{ agentId, points: [{ day, handsCum, rawBb100Cum, dupAdjBb100Cum, evAdjBb100Cum }] }`) — `[]` until `mart.agent_daily_performance` is built by the ETL | LIST |

## Deploy (Vercel)

1. Set `DATABASE_URL` (+ `DATABASE_SSL_CA`) as Environment Variables.
2. DB side (PRD §5): pooler is the only public endpoint, `hostssl` + SCRAM only,
   `app_readonly` role, rate-limit auth failures.
3. Access gate: enable Vercel password protection (v1 decision — no per-user auth).
4. API routes already send `Cache-Control: s-maxage=60, stale-while-revalidate=300`
   on list endpoints; hand detail and the CSV export are `no-store`.

## Layout

```
app/            pages (all client components fetching /api via TanStack Query)
app/api/**      route handlers (runtime nodejs)
lib/db.ts       module-scoped pg.Pool (globalThis-cached), TLS config
lib/queries/    one SQL module per endpoint — the whole mart contract
lib/types.ts    response interfaces (PRD §6)
lib/validate.ts cuid / enum / number guards
components/     nav, ui states, playing cards, charts, replayer panel
```

Known v1 gaps (PRD §12): leak→hands deep links filter by agent + street only
(per-hand line isn't in the mart); "flagged" hand filter not implemented (no
mart column); matrix column labels clip slightly on long names.
