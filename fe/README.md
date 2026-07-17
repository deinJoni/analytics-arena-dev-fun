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

## Deploy (Vercel)

1. Set `DATABASE_URL` (+ `DATABASE_SSL_CA`) as Environment Variables.
2. DB side (PRD §5): pooler is the only public endpoint, `hostssl` + SCRAM only,
   `app_readonly` role, rate-limit auth failures.
3. Access gate: enable Vercel password protection (v1 decision — no per-user auth).
4. API routes already send `Cache-Control: s-maxage=60, stale-while-revalidate=300`
   on list endpoints; hand detail is `no-store`.

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
