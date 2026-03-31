#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
source "$REPO_ROOT/scripts/env/runtime_profile_lib.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/runtime/run_backend_local.sh <local> [--skip-activate] [--preflight-only] [--skip-preflight] [--reload|--no-reload]

Starts the local backend for a runtime mode.
For local, this will start a Cloud SQL proxy automatically when the
active backend profile includes CLOUDSQL_INSTANCE_CONNECTION_NAME.

Options:
  --reload       Start backend with uvicorn autoreload enabled (slower)
  --no-reload    Start backend without autoreload (default, faster)
USAGE
}

if [ "$#" -lt 1 ]; then
  usage
  exit 1
fi

RAW_PROFILE="${1:-}"
shift || true
SKIP_ACTIVATE=false
PREFLIGHT_ONLY=false
SKIP_PREFLIGHT=false
BACKEND_RELOAD="${BACKEND_RELOAD:-false}"

for arg in "$@"; do
  case "$arg" in
    --skip-activate)
      SKIP_ACTIVATE=true
      ;;
    --preflight-only)
      PREFLIGHT_ONLY=true
      ;;
    --skip-preflight)
      SKIP_PREFLIGHT=true
      ;;
    --reload)
      BACKEND_RELOAD=true
      ;;
    --no-reload)
      BACKEND_RELOAD=false
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
  echo "Runtime mode $PROFILE does not start a local backend." >&2
  echo "Use a remote mode with 'npm run web -- --mode=$PROFILE'." >&2
  exit 1
fi

if [ "$SKIP_ACTIVATE" != "true" ]; then
  bash "$REPO_ROOT/scripts/env/use_profile.sh" "$PROFILE"
fi

BACKEND_ENV_FILE="$REPO_ROOT/consent-protocol/.env"
if [ ! -f "$BACKEND_ENV_FILE" ]; then
  echo "Missing active backend env file: $BACKEND_ENV_FILE" >&2
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

wait_for_port() {
  local host="$1"
  local port="$2"
  python3 - "$host" "$port" <<'PY'
import socket
import sys
import time

host = sys.argv[1]
port = int(sys.argv[2])
end = time.time() + 10
while time.time() < end:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            raise SystemExit(0)
    except OSError:
        time.sleep(0.25)
raise SystemExit(1)
PY
}

port_is_listening() {
  local host="$1"
  local port="$2"
  python3 - "$host" "$port" <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
with socket.socket() as sock:
    sock.settimeout(0.2)
    raise SystemExit(0 if sock.connect_ex((host, port)) == 0 else 1)
PY
}

listener_pids() {
  local port="$1"
  lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk '!seen[$0]++'
}

stop_existing_repo_backend() {
  local pids
  pids="$(listener_pids 8000 || true)"
  if [ -z "$pids" ]; then
    return 0
  fi

  local pid
  local cmd
  local safe_to_kill=true
  for pid in $pids; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    if [[ "$cmd" == *"uvicorn server:app"* ]] || [[ "$cmd" == *"--multiprocessing-fork"* ]]; then
      continue
    fi
    safe_to_kill=false
    break
  done

  if [ "$safe_to_kill" != "true" ]; then
    echo "Backend port 8000 is already in use by a non-local-backend process." >&2
    echo "Stop the existing backend process before starting ${PROFILE}." >&2
    exit 1
  fi

  echo "Stopping existing local backend on :8000..."
  for pid in $pids; do
    kill "$pid" >/dev/null 2>&1 || true
  done

  local waited=0
  while port_is_listening 127.0.0.1 8000; do
    if [ "$waited" -ge 40 ]; then
      echo "Timed out waiting for backend port 8000 to become free." >&2
      exit 1
    fi
    sleep 0.25
    waited=$((waited + 1))
  done
}

verify_iam_readiness() {
  local profile="$1"
  if [ "$profile" != "local" ]; then
    return 0
  fi

  echo "Verifying IAM schema readiness for ${profile}..."
  (
    cd "$REPO_ROOT/consent-protocol"
    PYTHONPATH=. python3 scripts/verify_iam_schema.py
  )
}

run_preflight() {
  local profile="$1"
  verify_iam_readiness "$profile"

  if port_is_listening 127.0.0.1 8000; then
    stop_existing_repo_backend
  fi
}

PROXY_PID=""
cleanup() {
  if [ -n "$PROXY_PID" ] && kill -0 "$PROXY_PID" >/dev/null 2>&1; then
    kill "$PROXY_PID" >/dev/null 2>&1 || true
    wait "$PROXY_PID" >/dev/null 2>&1 || true
  fi
  cleanup_proxy_credentials
}
trap cleanup EXIT INT TERM

DB_HOST="$(read_env_value "$BACKEND_ENV_FILE" 'DB_HOST')"
DB_PORT="$(read_env_value "$BACKEND_ENV_FILE" 'DB_PORT')"
DB_PORT="${DB_PORT:-5432}"
INSTANCE="$(read_env_value "$BACKEND_ENV_FILE" 'CLOUDSQL_INSTANCE_CONNECTION_NAME')"
PROXY_PORT="$(read_env_value "$BACKEND_ENV_FILE" 'CLOUDSQL_PROXY_PORT')"
PROXY_PORT="${PROXY_PORT:-$DB_PORT}"
PROXY_CREDENTIALS_FILE="$(read_env_value "$BACKEND_ENV_FILE" 'CLOUDSQL_PROXY_CREDENTIALS_FILE')"
PROXY_CREDENTIALS_JSON="$(read_env_value "$BACKEND_ENV_FILE" 'FIREBASE_SERVICE_ACCOUNT_JSON')"
PROXY_CREDENTIALS_TEMP=""

cleanup_proxy_credentials() {
  if [ -n "${PROXY_CREDENTIALS_TEMP:-}" ] && [ -f "${PROXY_CREDENTIALS_TEMP:-}" ]; then
    rm -f "$PROXY_CREDENTIALS_TEMP"
  fi
}

if [ -n "$INSTANCE" ] && [[ "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "localhost" ]]; then
  if python3 - "$PROXY_PORT" <<'PY'
import socket
import sys
port = int(sys.argv[1])
with socket.socket() as sock:
    sock.settimeout(0.2)
    sys.exit(0 if sock.connect_ex(("127.0.0.1", port)) == 0 else 1)
PY
  then
    echo "Assuming an existing DB listener is already running on 127.0.0.1:${PROXY_PORT} for ${INSTANCE}."
  else
    if ! command -v cloud-sql-proxy >/dev/null 2>&1; then
      echo "local requires cloud-sql-proxy to reach the UAT Cloud SQL instance." >&2
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
      echo "local requires Cloud SQL proxy credentials from FIREBASE_SERVICE_ACCOUNT_JSON or CLOUDSQL_PROXY_CREDENTIALS_FILE." >&2
      echo "Refusing to fall back to local gcloud/ADC credentials." >&2
      exit 1
    fi
    if [ ! -f "$PROXY_CREDENTIALS_FILE" ]; then
      echo "Cloud SQL proxy credentials file not found: $PROXY_CREDENTIALS_FILE" >&2
      exit 1
    fi
    proxy_cmd+=(--credentials-file "$PROXY_CREDENTIALS_FILE")
    echo "Starting Cloud SQL proxy for ${INSTANCE} on 127.0.0.1:${PROXY_PORT} using credentials file ${PROXY_CREDENTIALS_FILE}..."
    proxy_cmd+=("$INSTANCE")
    "${proxy_cmd[@]}" >/tmp/hushh-cloud-sql-proxy.log 2>&1 &
    PROXY_PID=$!
    if ! wait_for_port 127.0.0.1 "$PROXY_PORT"; then
      echo "Cloud SQL proxy failed to bind 127.0.0.1:${PROXY_PORT}. See /tmp/hushh-cloud-sql-proxy.log" >&2
      exit 1
    fi
  fi
fi

if [ "$SKIP_PREFLIGHT" != "true" ]; then
  run_preflight "$PROFILE"
fi

if [ "$PREFLIGHT_ONLY" = "true" ]; then
  echo "Backend preflight passed for runtime mode ${PROFILE}."
  exit 0
fi

echo "Starting backend on :8000 for runtime mode ${PROFILE}..."
cd "$REPO_ROOT/consent-protocol"
uvicorn_args=(server:app --port 8000)
reload_mode="$(printf '%s' "$BACKEND_RELOAD" | tr '[:upper:]' '[:lower:]')"
case "$reload_mode" in
  1|true|yes|on)
    uvicorn_args+=(--reload)
    echo "Uvicorn autoreload enabled (dev watch mode)."
    ;;
  *)
    echo "Uvicorn autoreload disabled (faster local runtime). Use --reload to enable watch mode."
    ;;
esac
python3 -m uvicorn "${uvicorn_args[@]}"
