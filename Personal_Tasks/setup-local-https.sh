#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  ''|--check|--trust) ;;
  *) echo "Usage: $0 [--check|--trust]" >&2; exit 2 ;;
esac
REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
CERT_DIR="$REPO_ROOT/hushh-webapp/certificates"
CERT="$CERT_DIR/localhost.pem"
KEY="$CERT_DIR/localhost-key.pem"

valid_certificate() {
  node - "$CERT" "$KEY" <<'JS'
const { readFileSync } = require('node:fs');
const { X509Certificate, createPrivateKey } = require('node:crypto');
try {
  const cert = new X509Certificate(readFileSync(process.argv[2]));
  process.exit(cert.checkHost('localhost') &&
    cert.checkPrivateKey(createPrivateKey(readFileSync(process.argv[3]))) &&
    Date.parse(cert.validFrom) <= Date.now() &&
    Date.parse(cert.validTo) > Date.now() + 86400000 ? 0 : 1);
} catch { process.exit(1); }
JS
}
if ! valid_certificate; then
  if [ "${1:-}" = --check ]; then
    echo "Missing/expired localhost certificate. Run: ./Personal_Tasks/setup-local-https.sh --trust" >&2
    exit 1
  fi
  umask 077
  mkdir -p "$CERT_DIR"
  openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 365 \
    -keyout "$KEY" -out "$CERT" -config /dev/stdin <<'CONF'
[req]
distinguished_name = dn
x509_extensions = extensions
prompt = no
[dn]
CN = localhost
[extensions]
subjectAltName = DNS:localhost,IP:127.0.0.1,IP:::1
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
CONF
  echo "Created localhost certificate (stored only in the ignored certificates directory)."
fi
if [ "${1:-}" = --trust ]; then
  security add-trusted-cert -r trustRoot -p ssl \
    -k "$HOME/Library/Keychains/login.keychain-db" "$CERT"
  echo "Trusted localhost HTTPS in your macOS login keychain."
fi
echo "Local HTTPS certificate ready."
