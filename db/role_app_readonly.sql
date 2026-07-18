-- app_readonly — the read-only role Vercel connects as (PRD_fe §5.4).
-- SELECT on mart.* only; no access to raw/stg/int; no writes. A leaked secret
-- buys a read of already-public tournament data and nothing else.
--
-- Run on the SERVER as the arena superuser, passing a strong password:
--
--   PW="$(openssl rand -hex 24)"; echo "app_readonly password: $PW"   # save it
--   docker exec -i arena-db psql -U arena -d arena -v app_pw="$PW" \
--     -f - < db/role_app_readonly.sql
--
-- Idempotent: safe to re-run. Re-running with a new $PW ROTATES the password
-- (then regenerate the pooler userlist: db/pgbouncer/gen-userlist.sh).

\set ON_ERROR_STOP on

-- 1. Role (created once; NOSUPERUSER so it can never escalate).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_readonly') THEN
        CREATE ROLE app_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END $$;

-- 2. Password (also the rotation path — ALTER is idempotent).
ALTER ROLE app_readonly WITH PASSWORD :'app_pw';

-- 3. Least exposure: PUBLIC loses blanket CONNECT; only granted roles get in.
--    (superuser 'arena' — the ETL — bypasses this and is unaffected.)
REVOKE ALL ON DATABASE arena FROM PUBLIC;
GRANT CONNECT ON DATABASE arena TO app_readonly;

-- 4. Read-only on mart only. raw/stg/int are never granted, so they stay hidden.
GRANT USAGE ON SCHEMA mart TO app_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA mart TO app_readonly;
-- Cover mart tables added by future transform runs, automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA mart GRANT SELECT ON TABLES TO app_readonly;

-- (arena_transform.py re-applies the mart grants on every run too — this file
--  just bootstraps the role, CONNECT, and default privileges that the transform
--  does not manage.)

\echo 'app_readonly ready. Next: db/pgbouncer/gen-userlist.sh'
