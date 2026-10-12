#!/usr/bin/env bash
# Run the selected preservation gate independently of backend migrations.
set -euo pipefail

release_environment="${1:-}"
case "$release_environment" in
  dev) release_project=hushh-pda-dev; release_instance=hushh-pda-dev:us-central1:hushh-dev-pg ;;
  uat) release_project=hushh-pda-uat; release_instance=hushh-pda-uat:us-central1:hushh-uat-pg ;;
  *) echo "PKM release rehearsal requires dev or UAT." >&2; exit 1 ;;
esac
if [[ "${GCP_PROJECT_ID:-}" != "$release_project" ]]; then
  echo "PKM release rehearsal project mismatch." >&2; exit 1
fi
command -v psql >/dev/null || { echo "PKM release rehearsal requires psql." >&2; exit 1; }

protocol_python="${PROTOCOL_PYTHON:-python3}"
proxy_directory="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hussh-pkm-release.XXXXXX")"
proxy_pid=""
cleanup() {
  if [[ -n "$proxy_pid" ]]; then
    kill "$proxy_pid" >/dev/null 2>&1 || true
    wait "$proxy_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$proxy_directory"
}
trap cleanup EXIT

# This step owns its listener. A frontend-only release never opens the
# migration step's proxy, and an inherited listener is not trusted evidence.
proxy_port="$("$protocol_python" - <<'PYPORT'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PYPORT
)"
cloud-sql-proxy --address 127.0.0.1 --port "$proxy_port" \
  ${GOOGLE_GHA_CREDS_PATH:+--credentials-file="${GOOGLE_GHA_CREDS_PATH}"} \
  "$release_instance" >"$proxy_directory/proxy.log" 2>&1 &
proxy_pid=$!
export PKM_RELEASE_PROXY_PID="$proxy_pid" PKM_RELEASE_PROXY_PORT="$proxy_port"
"$protocol_python" - <<'PYREADY'
import os
import socket
import time
deadline = time.monotonic() + 20
while time.monotonic() < deadline:
    os.kill(int(os.environ["PKM_RELEASE_PROXY_PID"]), 0)
    with socket.socket() as sock:
        sock.settimeout(0.5)
        if sock.connect_ex(("127.0.0.1", int(os.environ["PKM_RELEASE_PROXY_PORT"]))) == 0:
            break
    time.sleep(0.25)
else:
    raise SystemExit("PKM rehearsal proxy did not become ready")
PYREADY

PGUSER="$(gcloud secrets versions access latest --secret=DB_USER --project="$release_project")"
PGPASSWORD="$(gcloud secrets versions access latest --secret=DB_PASSWORD --project="$release_project")"
echo "::add-mask::$PGUSER"
echo "::add-mask::$PGPASSWORD"
export PGUSER PGPASSWORD PGHOST=127.0.0.1 PGPORT="$proxy_port" PGDATABASE=postgres
export DB_USER="$PGUSER" DB_PASSWORD="$PGPASSWORD" DB_HOST="$PGHOST" DB_PORT="$PGPORT"
export DB_NAME="$PGDATABASE" DB_UNIX_SOCKET=""

BOOTSTRAP_FOCUS_PROFILE="$release_environment" bash scripts/env/bootstrap_profiles.sh --strict
bash scripts/env/use_profile.sh "$release_environment"
# The existing gate owns rolled-back synthetic PostgreSQL writes; this
# wrapper neither migrates schema nor reads an owner's decrypted records.
PKM_UPGRADE_PROTECTED_UAT=1 PKM_UPGRADE_RUNTIME_AUDIT_DEFERRED=1 \
  bash scripts/ci/pkm-upgrade-gate.sh
