#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
source "$REPO_ROOT/scripts/env/runtime_profile_lib.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/runtime/launch_stack.sh <local|uat|prod> [-- <next-dev args>]

Launches the canonical local runtime stack:
- local: activates mode, starts local backend, then starts frontend
- uat  : activates mode, starts frontend only
- prod : activates mode, starts frontend only
USAGE
}

if [ "$#" -lt 1 ]; then
  usage
  exit 1
fi

RAW_PROFILE="${1:-}"
shift || true
NEXT_ARGS=()
if [ "${1:-}" = "--" ]; then
  shift
  NEXT_ARGS=("$@")
fi

if ! PROFILE="$(normalize_runtime_profile "$RAW_PROFILE")"; then
  echo "Invalid runtime profile: $RAW_PROFILE" >&2
  exit 1
fi

bash "$REPO_ROOT/scripts/env/use_profile.sh" "$PROFILE"

BACKEND_PID=""
cleanup() {
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

listener_pids() {
  local port="$1"
  lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk '!seen[$0]++'
}

stop_existing_repo_frontend() {
  local pids
  pids="$(listener_pids 3000 || true)"
  if [ -z "$pids" ]; then
    return 0
  fi

  local pid
  local cmd
  local safe_to_kill=true
  for pid in $pids; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    if [[ "$cmd" == *"next dev"* ]] && [[ "$cmd" == *"hushh-research/hushh-webapp"* ]]; then
      continue
    fi
    safe_to_kill=false
    break
  done

  if [ "$safe_to_kill" != "true" ]; then
    echo "Frontend port 3000 is already in use by a non-managed process." >&2
    echo "Stop the existing process before starting the canonical Hushh frontend." >&2
    exit 1
  fi

  echo "Stopping existing managed frontend on :3000..."
  for pid in $pids; do
    kill "$pid" >/dev/null 2>&1 || true
  done
}

if [ "$(runtime_profile_backend_mode "$PROFILE")" = "local" ]; then
  bash "$REPO_ROOT/scripts/runtime/run_backend_local.sh" "$PROFILE" --skip-activate --preflight-only
  bash "$REPO_ROOT/scripts/runtime/run_backend_local.sh" "$PROFILE" --skip-activate --skip-preflight &
  BACKEND_PID=$!
  for _ in 1 2 3 4; do
    sleep 0.5
    if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
      wait "$BACKEND_PID"
      exit 1
    fi
  done
fi

echo "Starting frontend on :3000 for runtime mode ${PROFILE}..."
cd "$REPO_ROOT/hushh-webapp"
stop_existing_repo_frontend
echo "Cleaning stale .next build artifacts before starting the frontend..."
rm -rf .next
if [ "${#NEXT_ARGS[@]}" -gt 0 ]; then
  npm run dev -- "${NEXT_ARGS[@]}"
else
  npm run dev
fi
