#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
CONSENT_DIR="$REPO_ROOT/consent-protocol"
DB_SCHEMA="$CONSENT_DIR/db/offline_schema.sql"
ENV_TEMPLATE="$CONSENT_DIR/.env.local.offline"
ENV_TARGET="$CONSENT_DIR/.env.local"

die() {
  echo "Error: $*" >&2
  exit 1
}

# ── Pre-flight checks ────────────────────────────────────────────────────────

if [ ! -f "$DB_SCHEMA" ]; then
  die "Offline schema not found: $DB_SCHEMA"
fi

if [ ! -f "$ENV_TEMPLATE" ]; then
  die "Offline env template not found: $ENV_TEMPLATE"
fi

# ── Initialize SQLite database ───────────────────────────────────────────────

echo "==> Initializing offline SQLite database..."
mkdir -p "$CONSENT_DIR/tmp"

sqlite3 "$CONSENT_DIR/tmp/hushh-offline.db" < "$DB_SCHEMA"
echo "    Schema applied to $CONSENT_DIR/tmp/hushh-offline.db"

# Verify tables
TABLE_COUNT=$(sqlite3 "$CONSENT_DIR/tmp/hushh-offline.db" "SELECT count(*) FROM sqlite_master WHERE type='table';")
echo "    Tables created: $TABLE_COUNT"

# ── Copy env template ────────────────────────────────────────────────────────

if [ -f "$ENV_TARGET" ]; then
  echo "==> Env file already exists: $ENV_TARGET"
  echo "    Skip copying. Edit it manually if needed."
else
  echo "==> Copying offline env template..."
  cp "$ENV_TEMPLATE" "$ENV_TARGET"
  echo "    Created $ENV_TARGET"
fi

# ── Verify Python dependencies ───────────────────────────────────────────────

if command -v python3 &>/dev/null; then
  if ! python3 -c "import sqlite3" 2>/dev/null; then
    echo "WARNING: sqlite3 Python module not available."
    echo "    Python 3 shipped with sqlite3; check your Python installation."
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "============================================================"
echo "  Hussh Offline Mode Ready"
echo "============================================================"
echo ""
echo "  Database:   $CONSENT_DIR/tmp/hushh-offline.db"
echo "  Env file:   $ENV_TARGET"
echo "  Schema:     $DB_SCHEMA"
echo ""
echo "  To start the backend:"
echo "    1. Set DB_OFFLINE=1 in $ENV_TARGET"
echo "    2. Run:  $REPO_ROOT/bin/hushh backend --mode offline"
echo ""
echo "  To start the frontend:"
echo "    1. Set DB_OFFLINE=1 in consent-protocol/.env"
echo "    2. Run:  $REPO_ROOT/bin/hushh web --mode offline"
echo ""
echo "  Reviewer login (bypasses Firebase):"
echo "    POST /api/app-config/review-mode/session?local=1"
echo ""
echo "============================================================"
