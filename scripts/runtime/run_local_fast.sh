#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"
# Ordinary web/native verification must never replace the live fast server's files.
FAST_DIST_DIR=".next-local-fast"

usage() {
  cat <<'USAGE'
Usage:
  scripts/runtime/run_local_fast.sh [--https] [--skip-build] [--skip-preflight]

Starts the local stack in production-style fast mode:
  - activates the local runtime profile
  - starts the local Cloud SQL proxy on :6543 when one is not already running
  - starts the local backend on :8000 without Uvicorn reload
  - builds the frontend once in isolated .next-local-fast output
  - starts the optimized frontend on :3000 from its standalone build

Options:
  --https            Serve https://localhost:3000 using hushh-webapp/certificates/localhost{,-key}.pem.
                     The standalone HTTP server binds only to 127.0.0.1:3001.
  --skip-build       Reuse the existing .next-local-fast frontend build.
  --skip-preflight   Skip backend preflight checks for faster startup.
USAGE
}

SKIP_BUILD=false
SKIP_PREFLIGHT=false
HTTPS=false
WEB_PORT=3000
WEB_ORIGIN=http://localhost:3000
TLS_CERT="$WEB_DIR/certificates/localhost.pem"
TLS_KEY="$WEB_DIR/certificates/localhost-key.pem"

for arg in "$@"; do
  case "$arg" in
    --https)
      HTTPS=true
      WEB_PORT=3001
      WEB_ORIGIN=https://localhost:3000
      ;;
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

PROXY_PID=""
BACKEND_PID=""
WEB_PID=""
HTTPS_PID=""

# Keep each child in its own process group. Terminal-generated Ctrl-C is sent
# to the foreground process group, so without this boundary the proxy can be
# killed before the backend drains its in-flight database requests.
run_in_private_process_group() {
  exec python3 -c \
    'import os, sys; os.setpgrp(); os.execvpe(sys.argv[1], sys.argv[1:], os.environ)' \
    "$@"
}

cleanup() {
  if [ -n "${HTTPS_PID:-}" ] && kill -0 "$HTTPS_PID" >/dev/null 2>&1; then
    kill "$HTTPS_PID" >/dev/null 2>&1 || true
    wait "$HTTPS_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "${WEB_PID:-}" ] && kill -0 "$WEB_PID" >/dev/null 2>&1; then
    kill "$WEB_PID" >/dev/null 2>&1 || true
    wait "$WEB_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "${BACKEND_PID:-}" ] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "${PROXY_PID:-}" ] && kill -0 "$PROXY_PID" >/dev/null 2>&1; then
    kill "$PROXY_PID" >/dev/null 2>&1 || true
    wait "$PROXY_PID" >/dev/null 2>&1 || true
  fi
}
# EXIT owns child cleanup. INT and TERM must exit the foreground supervisor
# after cleanup; trapping them to `cleanup` alone resumes the polling loop and
# leaves the terminal appearing stuck after Ctrl-C.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

  until curl -fsS ${HTTPS_CA_ARGS[@]+"${HTTPS_CA_ARGS[@]}"} "$url" >/dev/null 2>&1; do
    if [ $(( $(date +%s) - start )) -ge "$timeout_seconds" ]; then
      echo "Timed out waiting for ${label}: ${url}" >&2
      return 1
    fi
    sleep 1
  done
}

for port in 3000 8000; do
  if port_is_listening 127.0.0.1 "$port"; then
    echo "Local app port $port is already in use. Stop its owning app first." >&2
    exit 1
  fi
done

HTTPS_CA_ARGS=()
if [ "$HTTPS" = true ]; then
  export NEXT_PUBLIC_APP_URL="$WEB_ORIGIN"
  export APP_FRONTEND_ORIGIN="$WEB_ORIGIN"
  if port_is_listening 127.0.0.1 "$WEB_PORT"; then
    echo "HTTPS upstream port $WEB_PORT is already in use. Stop its owning app first." >&2
    exit 1
  fi
  if [ ! -f "$TLS_CERT" ] || [ ! -f "$TLS_KEY" ]; then
    echo "Missing localhost TLS certificate/key in $WEB_DIR/certificates." >&2
    exit 1
  fi
  HTTPS_CA_ARGS=(--cacert "$TLS_CERT")
fi

echo "Activating local runtime profile..."
bash "$REPO_ROOT/scripts/env/use_profile.sh" local

if port_is_listening 127.0.0.1 6543; then
  echo "Reusing existing Cloud SQL proxy on :6543..."
else
  echo "Starting local Cloud SQL proxy on :6543..."
  (
    # A terminal-generated Ctrl-C is delivered to the foreground process
    # group, including these background children. Keep the proxy alive until
    # the supervisor has stopped the backend and drained its requests.
    export HUSHH_SUPERVISED_RUNTIME=1
    trap '' INT
    run_in_private_process_group "$REPO_ROOT/bin/hushh" proxy --mode local
  ) &
  PROXY_PID=$!
  until port_is_listening 127.0.0.1 6543; do
    if ! kill -0 "$PROXY_PID" >/dev/null 2>&1; then
      wait "$PROXY_PID"
      exit $?
    fi
    sleep 1
  done
fi

backend_args=(backend --mode local --skip-activate --no-reload)
if [ "$SKIP_PREFLIGHT" = "true" ]; then
  backend_args+=(--skip-preflight)
fi

echo "Starting local backend on :8000 without reload..."
(
  # Let the supervisor own shutdown ordering. The backend receives SIGTERM
  # from cleanup after the frontend is stopped, then closes the proxy last.
  export HUSHH_SUPERVISED_RUNTIME=1
  # Local fast startup should prove the app, not exhaust shared market-provider
  # quotas by warming a broad public-market baseline before anyone opens Kai.
  export KAI_MARKET_BACKGROUND_REFRESH=false
  trap '' INT
  run_in_private_process_group "$REPO_ROOT/bin/hushh" "${backend_args[@]}"
) &
BACKEND_PID=$!

wait_for_http "backend health" "http://127.0.0.1:8000/health" 90

if [ "$SKIP_BUILD" != "true" ]; then
  echo "Building optimized frontend in $FAST_DIST_DIR..."
  (
    cd "$WEB_DIR"
    NEXT_DIST_DIR="$FAST_DIST_DIR" npm run build
  )
else
  echo "Skipping frontend build and reusing the existing $FAST_DIST_DIR output..."
fi

echo "Starting optimized frontend on 127.0.0.1:$WEB_PORT..."
STANDALONE_SERVER=""
if [ -d "$WEB_DIR/$FAST_DIST_DIR/standalone" ]; then
  STANDALONE_SERVER="$(find "$WEB_DIR/$FAST_DIST_DIR/standalone" -maxdepth 3 -type f -name server.js -print -quit)"
fi
if [ -z "$STANDALONE_SERVER" ]; then
  echo "Standalone frontend server is missing in $FAST_DIST_DIR. Re-run without --skip-build." >&2
  exit 1
fi

STANDALONE_APP_DIR="$(dirname "$STANDALONE_SERVER")"
mkdir -p "$STANDALONE_APP_DIR/$FAST_DIST_DIR"
cp -R "$WEB_DIR/$FAST_DIST_DIR/static" "$STANDALONE_APP_DIR/$FAST_DIST_DIR/"
if [ -d "$WEB_DIR/public" ]; then
  mkdir -p "$STANDALONE_APP_DIR/public"
  cp -R "$WEB_DIR/public/." "$STANDALONE_APP_DIR/public/"
fi
(
  cd "$STANDALONE_APP_DIR"
  run_in_private_process_group env HOSTNAME=127.0.0.1 PORT="$WEB_PORT" node "$STANDALONE_SERVER"
) &
WEB_PID=$!

wait_for_http "frontend" "http://127.0.0.1:$WEB_PORT" 60

if [ "$HTTPS" = true ]; then
  run_in_private_process_group node "$SCRIPT_DIR/local_https_proxy.cjs" "$WEB_DIR" "$TLS_CERT" "$TLS_KEY" &
  HTTPS_PID=$!
  wait_for_http "HTTPS frontend" "$WEB_ORIGIN/login" 30
fi

cat <<EOF

Fast local stack is running.
Frontend: $WEB_ORIGIN
Backend:  http://localhost:8000

Press Ctrl-C to stop both processes.
EOF

while true; do
  if [ -n "$HTTPS_PID" ] && ! kill -0 "$HTTPS_PID" >/dev/null 2>&1; then
    wait "$HTTPS_PID"
    exit $?
  fi
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
