#!/usr/bin/env bash
# Write db/pgbouncer/userlist.txt from the SCRAM verifier Postgres computed for
# app_readonly. Run this AFTER db/role_app_readonly.sql (the role must exist).
# Re-run it whenever you rotate the password.
#
#   ./db/pgbouncer/gen-userlist.sh              # defaults to container "arena-db"
#   ./db/pgbouncer/gen-userlist.sh my-container
set -euo pipefail

CONTAINER="${1:-arena-db}"
OUT="$(dirname "$0")/userlist.txt"

# Pull the exact rolpassword (a SCRAM-SHA-256 verifier) and wrap both fields in
# the double-quotes pgbouncer's auth_file expects.
docker exec -i "$CONTAINER" psql -U arena -d arena -tA <<'SQL' | sed '/^$/d' > "$OUT"
SELECT '"' || rolname || '" "' || rolpassword || '"'
FROM pg_authid
WHERE rolname = 'app_readonly' AND rolpassword LIKE 'SCRAM-SHA-256$%';
SQL

if [ ! -s "$OUT" ]; then
  echo "ERROR: no SCRAM verifier found for app_readonly." >&2
  echo "Did you run db/role_app_readonly.sql first (and is the password SCRAM)?" >&2
  rm -f "$OUT"
  exit 1
fi

chmod 640 "$OUT"
echo "wrote $OUT:"
cat "$OUT"
echo
echo "Now (re)start the pooler:  cd db && docker compose up -d pgbouncer"
