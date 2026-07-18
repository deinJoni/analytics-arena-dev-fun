# Deploy the public DB endpoint (PgBouncer) for Vercel

The Vercel app can't reach a localhost-bound Postgres. This stands up the
**pooler-as-only-public-endpoint** model from `PRD_fe` §5: Postgres stays
private, PgBouncer faces the internet on `:6432` with TLS (verify-full) + SCRAM,
and Vercel connects through it as the read-only `app_readonly` role.

```
Vercel functions ──TLS(verify-full)+SCRAM──▶ PgBouncer :6432 (public)
                                                  │ plaintext, private docker net
                                                  ▼
                                             Postgres :5432 (127.0.0.1 only)
```

Everything below runs **on the server**, from the `db/` directory, with the
`arena-db` container already running (`docker compose up -d db`) and the mart
built. Nothing here is committed: the role password, certs, and userlist are all
gitignored.

---

## 1. Create the read-only role

Pick a strong password, create the role, save the password (it goes in Vercel's
`DATABASE_URL`):

```bash
PW="$(openssl rand -hex 24)"; echo "app_readonly password: $PW"   # <-- save this
docker exec -i arena-db psql -U arena -d arena -v app_pw="$PW" \
  -f - < role_app_readonly.sql
```

`hex` = no URL-special characters, so it drops into a connection string as-is.

## 2. Generate the TLS cert

Pass the **exact host Vercel will dial** — the IP or DNS name that ends up in
`DATABASE_URL`. verify-full checks it against the cert SAN, so a mismatch = the
app can't connect.

```bash
./tls/gen-certs.sh 187.77.154.166          # or: ./tls/gen-certs.sh db.example.com
```

Produces `db/tls/{ca.pem,server.crt,server.key,ca.key}`. You'll paste
`ca.pem` into Vercel in step 6.

> If `pgbouncer` later logs `could not open server.key: Permission denied`, the
> container user can't read the key. Fix with `chmod 644 tls/server.key`
> (acceptable for a self-signed key on a single-tenant host) or chown it to the
> image's uid.

## 3. Generate the pooler userlist

Reads the SCRAM verifier straight out of Postgres — no hand-copying hashes:

```bash
./pgbouncer/gen-userlist.sh                # writes db/pgbouncer/userlist.txt
```

## 4. Bring up the pooler

```bash
docker compose up -d                       # starts/keeps db, adds pgbouncer
docker compose logs -f pgbouncer           # watch for "listening on 0.0.0.0:6432"
```

## 5. Open the firewall for 6432 (and nothing else new)

Postgres stays on 127.0.0.1; only the pooler port is public. Example (ufw):

```bash
sudo ufw allow 6432/tcp
```

If the host has a cloud security group, allow inbound TCP 6432 there too.

## 6. Smoke-test from your laptop (before touching Vercel)

Copy `db/tls/ca.pem` down, then dial the public endpoint with verify-full — this
is exactly what Vercel will do:

```bash
psql "postgresql://app_readonly:$PW@187.77.154.166:6432/arena?sslmode=verify-full&sslrootcert=./ca.pem" \
  -c 'select count(*) from mart.leaderboard;'
```

Expect a row count. Also confirm the role is properly boxed in:

```bash
# should FAIL (no access to raw):
psql "...same url..." -c 'select 1 from raw.replays limit 1;'   # -> permission denied
```

## 7. Configure Vercel

In the Vercel project (**Root Directory = `fe`**):

| Env var | Value |
|---|---|
| `DATABASE_URL` | `postgresql://app_readonly:<PW>@187.77.154.166:6432/arena` |
| `DATABASE_SSL_CA` | full contents of `db/tls/ca.pem` (paste multiline, or `\n`-escaped) |

Optional: `ARENA_COMPETITION_ID` (defaults to S1), `PGPOOL_MAX` (default 3 — fine
in front of the pooler).

Then: enable **Deployment Protection → Password** (v1 has no per-user auth), and
deploy. Do **not** set `DATABASE_SSL=require` — you have the CA, so verify-full
(`DATABASE_SSL_CA`) is the stronger choice.

---

## Pin the image

`docker-compose.yml` uses `edoburu/pgbouncer:latest` so a tag typo can't block
the first `up`. Once it's pulled, pin it:

```bash
docker compose pull pgbouncer
docker inspect --format '{{index .RepoDigests 0}}' edoburu/pgbouncer:latest
# copy the name@sha256:... into docker-compose.yml, then `docker compose up -d`
```

## Rotate the password

```bash
PW="$(openssl rand -hex 24)"; echo "$PW"
docker exec -i arena-db psql -U arena -d arena -v app_pw="$PW" -f - < role_app_readonly.sql
./pgbouncer/gen-userlist.sh
docker compose up -d pgbouncer          # reload
# then update DATABASE_URL in Vercel and redeploy
```

## Hardening checklist (PRD_fe §5.2)

- [x] TLS required + client verifies via CA (verify-full) — steps 2, 7
- [x] SCRAM-SHA-256 auth — `pgbouncer.ini`, step 3
- [x] Strong, rotatable secret — steps 1, rotate section
- [x] Only the pooler port is public; Postgres stays on 127.0.0.1 — compose
- [x] Read-only role scoped to `mart`, PUBLIC connect revoked — `role_app_readonly.sql`
- [ ] Brute-force blunting: watch `docker compose logs pgbouncer` / journald for
      auth-failure spikes; add fail2ban on the pooler log if the port sees abuse.
