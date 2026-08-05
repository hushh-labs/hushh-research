#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

usage() {
  cat <<'USAGE'
Usage:
  scripts/runtime/run_local_fast.sh [--skip-build] [--skip-preflight]

Starts the local stack in production-style fast mode:
  - activates the local runtime profile
  - starts the local backend on :8000 without Uvicorn reload
  - builds the frontend once
  - starts the optimized frontend on :3000 with next start

Options:
  --skip-build       Reuse the existing frontend build.
  --skip-preflight   Skip backend preflight checks for faster startup.
USAGE
}

SKIP_BUILD=false
SKIP_PREFLIGHT=false

for arg in "$@"; do
  case "$arg" in
    --skip-build)
      SKIP_BUILD=true
      ;;
    --skip-preflight)
      SKIP_PREFLIGHT=true
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

BACKEND_PID=""
WEB_PID=""

cleanup() {
  if [ -n "${WEB_PID:-}" ] && kill -0 "$WEB_PID" >/dev/null 2>&1; then
    kill "$WEB_PID" >/dev/null 2>&1 || true
    wait "$WEB_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "${BACKEND_PID:-}" ] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

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

wait_for_http() {
  local label="$1"
  local url="$2"
  local timeout_seconds="$3"
  local start
  start="$(date +%s)"

  until curl -fsS "$url" >/dev/null 2>&1; do
    if [ $(( "$(date +%s)" - start )) -ge "$timeout_seconds" ]; then
      echo "Timed out waiting for ${label}: ${url}" >&2
      return 1
    fi
    sleep 1
  done
}

if port_is_listening 127.0.0.1 3000; then
  echo "Frontend port 3000 is already in use." >&2
  echo "Stop the existing frontend first, then rerun this script." >&2
  echo "Useful command: lsof -ti :3000 | xargs kill" >&2
  exit 1
fi

echo "Activating local runtime profile..."
bash "$REPO_ROOT/scripts/env/use_profile.sh" local

backend_args=(backend --mode local --skip-activate --no-reload)
if [ "$SKIP_PREFLIGHT" = "true" ]; then
  backend_args+=(--skip-preflight)
fi

echo "Starting local backend on :8000 without reload..."
"$REPO_ROOT/bin/hushh" "${backend_args[@]}" &
BACKEND_PID=$!

wait_for_http "backend health" "http://127.0.0.1:8000/health" 90

if [ "$SKIP_BUILD" != "true" ]; then
  echo "Building optimized frontend..."
  (
    cd "$WEB_DIR"
    npm run build
  )
else
  echo "Skipping frontend build and reusing the existing .next output..."
fi

echo "Starting optimized frontend on :3000..."
(
  cd "$WEB_DIR"
  HOSTNAME=0.0.0.0 PORT=3000 npm run start
) &
WEB_PID=$!

wait_for_http "frontend" "http://127.0.0.1:3000" 60

cat <<'EOF'

Fast local stack is running.
Frontend: http://localhost:3000
Backend:  http://localhost:8000

Press Ctrl-C to stop both processes.
EOF

while true; do
  if [ -n "$BACKEND_PID" ] && ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    wait "$BACKEND_PID"
    exit $?
  fi
  if [ -n "$WEB_PID" ] && ! kill -0 "$WEB_PID" >/dev/null 2>&1; then
    wait "$WEB_PID"
    exit $?
  fi
  sleep 1
done
