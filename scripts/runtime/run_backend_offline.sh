#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
CONSENT_DIR="$REPO_ROOT/consent-protocol"
ENV_FILE="$CONSENT_DIR/.env.local"
DB_SCHEMA="$CONSENT_DIR/db/offline_schema.sql"
DB_PATH="$CONSENT_DIR/tmp/hushh-offline.db"

die() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  scripts/runtime/run_backend_offline.sh [--reload|--no-reload]

Starts the local backend in fully air-gapped offline mode.
No cloud services are used — SQLite DB, local auth bypass, mock AI/email.

Options:
  --reload       Start backend with uvicorn autoreload enabled (slower)
  --no-reload    Start backend without autoreload (default, faster)
USAGE
}

BACKEND_RELOAD="${BACKEND_RELOAD:-false}"

for arg in "$@"; do
  case "$arg" in
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

# ── Pre-flight checks ────────────────────────────────────────────────────────

if [ ! -f "$ENV_FILE" ]; then
  die "Offline env file not found: $ENV_FILE"
  echo "Run: scripts/env/bootstrap_offline.sh"
fi

if [ ! -f "$DB_SCHEMA" ]; then
  die "Offline schema not found: $DB_SCHEMA"
  echo "Run: scripts/env/bootstrap_offline.sh"
fi

if [ ! -f "$DB_PATH" ]; then
  echo "==> Offline DB not initialized. Running bootstrap..."
  bash "$REPO_ROOT/scripts/env/bootstrap_offline.sh"
fi

# Verify Python dependencies
if ! python3 -c "import sqlite3" 2>/dev/null; then
  die "Python sqlite3 module not available. Check your Python 3 installation."
fi

# Check backend virtualenv
BACKEND_VENV_PYTHON="$CONSENT_DIR/.venv/bin/python"
if [ ! -x "$BACKEND_VENV_PYTHON" ]; then
  die "Missing backend virtualenv: $BACKEND_VENV_PYTHON"
  echo "Run: cd consent-protocol && python3 -m venv .venv && pip install -r requirements.txt"
fi

# ── Stop existing backend on :8000 ───────────────────────────────────────────

port_is_listening() {
  python3 - "$1" "$2" <<'PY'
import socket, sys
with socket.socket() as s:
    s.settimeout(0.2)
    sys.exit(0 if s.connect_ex((sys.argv[1], int(sys.argv[2]))) == 0 else 1)
PY
}

if port_is_listening 127.0.0.1 8000; then
  echo "==> Port 8000 already in use. Attempting to stop existing backend..."
  PIDS=$(lsof -t -nP -iTCP:8000 -sTCP:LISTEN 2>/dev/null | awk '!seen[$0]++' || true)
  if [ -n "$PIDS" ]; then
    for pid in $PIDS; do
      kill "$pid" 2>/dev/null || true
    done
    sleep 1
  fi
fi

# ── Start backend ────────────────────────────────────────────────────────────

echo "============================================================"
echo "  Hussh Offline Mode — Backend"
echo "============================================================"
echo "  Database:   SQLite ($DB_PATH)"
echo "  Firebase:   Disabled (use ?local=1 for reviewer login)"
echo "  AI:         Mock responses (set GEMINI_API_KEY to enable)"
echo "  Email:      Mock responses (set GMAIL_API_KEY to enable)"
echo "============================================================"
echo ""

cd "$CONSENT_DIR"

reload_flag=""
reload_mode="$(printf '%s' "$BACKEND_RELOAD" | tr '[:upper:]' '[:lower:]')"
case "$reload_mode" in
  1|true|yes|on)
    reload_flag="--reload"
    echo "Uvicorn autoreload enabled (dev watch mode)."
    ;;
  *)
    echo "Uvicorn autoreload disabled (faster local runtime). Use --reload to enable watch mode."
    ;;
esac

echo ""
echo "Starting backend on :8000..."
echo ""

export DB_OFFLINE=1

if [ -n "$reload_flag" ]; then
  "$BACKEND_VENV_PYTHON" -m uvicorn server:app --port 8000 --reload
else
  "$BACKEND_VENV_PYTHON" -m uvicorn server:app --port 8000
fi
