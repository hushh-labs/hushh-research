#!/usr/bin/env bash
set -euo pipefail

# Standalone Cloud SQL proxy launcher for local runtime.
#
# Runs the Cloud SQL proxy in the FOREGROUND (in-session) so a coding agent or
# developer can stream its logs in a dedicated terminal, separate from the
# backend and frontend. The backend launcher (run_backend_local.sh) auto-detects
# an already-listening proxy on the configured port and reuses it, so this script
# is the canonical first terminal in the three-terminal local runtime:
#   1. ./bin/hushh proxy   --mode local   (this script)
#   2. ./bin/hushh backend --mode local --reload
#   3. ./bin/hushh web     --mode local

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
source "$REPO_ROOT/scripts/env/runtime_profile_lib.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/runtime/run_proxy_local.sh <local> [--skip-activate]

Starts the Cloud SQL proxy for the local runtime mode in the foreground.
Requires CLOUDSQL_INSTANCE_CONNECTION_NAME in the active backend env file.
USAGE
}

if [ "$#" -lt 1 ]; then
  usage
  exit 1
fi

RAW_PROFILE="${1:-}"
shift || true
SKIP_ACTIVATE=false

for arg in "$@"; do
  case "$arg" in
    --skip-activate)
      SKIP_ACTIVATE=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

if ! PROFILE="$(normalize_runtime_profile "$RAW_PROFILE")"; then
  echo "Invalid runtime mode: $RAW_PROFILE" >&2
  exit 1
fi

if [ "$(runtime_profile_backend_mode "$PROFILE")" != "local" ]; then
  echo "Runtime mode $PROFILE does not start a local Cloud SQL proxy." >&2
  echo "The proxy is only used by the local backend profile." >&2
  exit 1
fi

if [ "$SKIP_ACTIVATE" != "true" ]; then
  bash "$REPO_ROOT/scripts/env/use_profile.sh" "$PROFILE"
fi

BACKEND_ENV_FILE="$REPO_ROOT/consent-protocol/.env"
if [ ! -f "$BACKEND_ENV_FILE" ]; then
  echo "Missing active backend env file: $BACKEND_ENV_FILE" >&2
  echo "Run './bin/hushh bootstrap' to hydrate consent-protocol/.env." >&2
  exit 1
fi

read_env_value() {
  local file="$1"
  local key="$2"
  python3 - "$file" "$key" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
needle = f"{key}="
if not path.exists():
    print("")
    raise SystemExit(0)
for line in path.read_text(encoding="utf-8").splitlines():
    if line.startswith(needle):
        print(line.split("=", 1)[1])
        break
else:
    print("")
PY
}

DB_HOST="$(read_env_value "$BACKEND_ENV_FILE" 'DB_HOST')"
DB_PORT="$(read_env_value "$BACKEND_ENV_FILE" 'DB_PORT')"
DB_PORT="${DB_PORT:-5432}"
INSTANCE="$(read_env_value "$BACKEND_ENV_FILE" 'CLOUDSQL_INSTANCE_CONNECTION_NAME')"
PROXY_PORT="$(read_env_value "$BACKEND_ENV_FILE" 'CLOUDSQL_PROXY_PORT')"
PROXY_PORT="${PROXY_PORT:-$DB_PORT}"
PROXY_CREDENTIALS_FILE="$(read_env_value "$BACKEND_ENV_FILE" 'CLOUDSQL_PROXY_CREDENTIALS_FILE')"
PROXY_CREDENTIALS_JSON="$(read_env_value "$BACKEND_ENV_FILE" 'FIREBASE_ADMIN_CREDENTIALS_JSON')"
PROXY_CREDENTIALS_TEMP=""

cleanup_proxy_credentials() {
  if [ -n "${PROXY_CREDENTIALS_TEMP:-}" ] && [ -f "${PROXY_CREDENTIALS_TEMP:-}" ]; then
    rm -f "$PROXY_CREDENTIALS_TEMP"
  fi
}
trap cleanup_proxy_credentials EXIT INT TERM

if [ -z "$INSTANCE" ]; then
  echo "CLOUDSQL_INSTANCE_CONNECTION_NAME is unset in $BACKEND_ENV_FILE." >&2
  echo "The standalone proxy cannot start without it." >&2
  echo "Run './bin/hushh bootstrap' to hydrate the env, or set a reachable DB_HOST and skip the proxy." >&2
  exit 1
fi

if [[ "$DB_HOST" != "127.0.0.1" && "$DB_HOST" != "localhost" ]]; then
  echo "DB_HOST is '${DB_HOST}', not a local address; the proxy is only needed when DB_HOST is 127.0.0.1/localhost." >&2
  exit 1
fi

if python3 - "$PROXY_PORT" <<'PY'
import socket
import sys
port = int(sys.argv[1])
with socket.socket() as sock:
    sock.settimeout(0.2)
    sys.exit(0 if sock.connect_ex(("127.0.0.1", port)) == 0 else 1)
PY
then
  echo "A DB listener is already running on 127.0.0.1:${PROXY_PORT} for ${INSTANCE}."
  echo "Nothing to do — the backend will reuse this listener. Leaving it running."
  exit 0
fi

if ! command -v cloud-sql-proxy >/dev/null 2>&1; then
  echo "local requires cloud-sql-proxy to reach the Cloud SQL instance." >&2
  echo "Install it and rerun, or provide a reachable DB_HOST override in consent-protocol/.env." >&2
  exit 1
fi

proxy_cmd=(cloud-sql-proxy --address 127.0.0.1 --port "$PROXY_PORT")

if [ -z "$PROXY_CREDENTIALS_FILE" ] && [ -n "$PROXY_CREDENTIALS_JSON" ]; then
  PROXY_CREDENTIALS_TEMP="$(mktemp /tmp/hushh-cloudsql-creds.XXXXXX)"
  python3 - "$PROXY_CREDENTIALS_TEMP" "$PROXY_CREDENTIALS_JSON" <<'PY'
import json
import sys

path = sys.argv[1]
raw = sys.argv[2]
data = json.loads(raw)
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh)
PY
  chmod 600 "$PROXY_CREDENTIALS_TEMP"
  PROXY_CREDENTIALS_FILE="$PROXY_CREDENTIALS_TEMP"
fi

if [ -z "$PROXY_CREDENTIALS_FILE" ]; then
  echo "local requires Cloud SQL proxy credentials from FIREBASE_ADMIN_CREDENTIALS_JSON or CLOUDSQL_PROXY_CREDENTIALS_FILE." >&2
  echo "Refusing to fall back to local gcloud/ADC credentials." >&2
  exit 1
fi

if [ ! -f "$PROXY_CREDENTIALS_FILE" ]; then
  echo "Cloud SQL proxy credentials file not found: $PROXY_CREDENTIALS_FILE" >&2
  exit 1
fi

proxy_cmd+=(--credentials-file "$PROXY_CREDENTIALS_FILE")
proxy_cmd+=("$INSTANCE")

echo "Starting Cloud SQL proxy for ${INSTANCE} on 127.0.0.1:${PROXY_PORT} (foreground, in-session)..."
echo "Leave this terminal running. Start the backend in a second terminal:"
echo "  ./bin/hushh backend --mode local --reload"
echo "and the frontend in a third terminal:"
echo "  ./bin/hushh web --mode local"
echo

# Run in the foreground so logs stream to this terminal. Ctrl-C stops it.
exec "${proxy_cmd[@]}"
