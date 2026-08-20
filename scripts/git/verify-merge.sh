#!/usr/bin/env bash
# scripts/git/verify-merge.sh
# Companion to sync-main.sh: run this after resolving a merge conflict left
# by `./bin/hushh sync main` and committing the resolution. Checks that the
# resolution didn't silently drop content the merge was supposed to bring in.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_DIR="$(git rev-parse --git-dir)"
STATE_FILE="$GIT_DIR/HUSHH_SYNC_BASE"
REGRESSION_SCRIPT="$REPO_ROOT/scripts/git/check-merge-regression.sh"
MERGE_REGRESSION_MODE="${MERGE_REGRESSION_MODE:-warn}"

if [ ! -f "$STATE_FILE" ]; then
  echo "[verify-merge] No in-progress sync found (no $STATE_FILE)." >&2
  echo "Run ./bin/hushh sync main first; this only applies after it stops on conflicts." >&2
  exit 1
fi

if git status --porcelain | grep -qE '^(UU|AA|DD)'; then
  echo "[verify-merge] Unresolved conflict markers remain. Resolve and 'git add' every file first." >&2
  exit 1
fi

read -r BASE UPSTREAM_SHA < "$STATE_FILE"

echo "Checking that the resolved merge didn't silently drop anything ${UPSTREAM_SHA:0:8} already had..."
MERGE_REGRESSION_MODE="$MERGE_REGRESSION_MODE" \
  bash "$REGRESSION_SCRIPT" "$BASE" "$UPSTREAM_SHA" HEAD

rm -f "$STATE_FILE"
echo "[verify-merge] Clear to push."
