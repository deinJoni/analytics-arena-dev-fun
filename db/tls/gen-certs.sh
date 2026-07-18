#!/usr/bin/env bash
# Generate a self-signed CA + server cert for the pgbouncer public endpoint.
#
#   ./db/tls/gen-certs.sh <public-host-or-ip> [valid-days]
#   ./db/tls/gen-certs.sh 187.77.154.166
#   ./db/tls/gen-certs.sh db.example.com 825
#
# <public-host-or-ip> MUST be exactly what Vercel dials in DATABASE_URL — the
# client does verify-full, which checks this against the cert's SAN. Use the IP
# if DATABASE_URL uses the IP; use the DNS name if it uses a name.
#
# Outputs (in this dir):
#   ca.pem      -> paste its CONTENTS into Vercel env DATABASE_SSL_CA
#   server.crt  -> mounted into pgbouncer (client_tls_cert_file)
#   server.key  -> mounted into pgbouncer (client_tls_key_file)  [secret]
#   ca.key      -> keep offline; only needed to sign more certs   [secret]
set -euo pipefail

HOST="${1:?usage: gen-certs.sh <public-host-or-ip> [valid-days]}"
DAYS="${2:-825}"
cd "$(dirname "$0")"

if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SAN="IP:$HOST"
else
  SAN="DNS:$HOST"
fi

echo "→ CA"
openssl req -x509 -newkey rsa:4096 -sha256 -days "$DAYS" -nodes \
  -keyout ca.key -out ca.pem -subj "/CN=arena-db local CA"

echo "→ server key + CSR (CN/SAN = $HOST)"
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout server.key -out server.csr -subj "/CN=$HOST"

echo "→ sign server cert (SAN=$SAN)"
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days "$DAYS" -sha256 -out server.crt \
  -extfile <(printf 'subjectAltName=%s\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$SAN")

rm -f server.csr ca.srl
chmod 640 server.key ca.key
chmod 644 server.crt ca.pem

echo
echo "done. Files in db/tls/:"
ls -l ca.pem ca.key server.crt server.key
echo
echo "Vercel env DATABASE_SSL_CA  <-  contents of db/tls/ca.pem"
echo "Reminder: DATABASE_URL host MUST be exactly '$HOST' (verify-full checks the SAN)."
