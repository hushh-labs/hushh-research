#!/usr/bin/env bash
# scripts/git/scan-pr-merges-for-regression.sh
#
# Automates the manual audit that caught the 2026-08-19 incident: walk every
# 2-parent merge commit a PR introduces where the branch side was NOT already
# an ancestor of the mainline side (a real "synced main in and resolved
# conflicts" merge, not a trivial fast-forward), and run
# check-merge-regression.sh on each. Intended for CI, one PR at a time.
#
# Usage:
#   scan-pr-merges-for-regression.sh [base-ref]
#     base-ref   the PR's base (default: origin/main). Merge commits are
#                looked for in <base-ref>..HEAD.
#
# Env:
#   MERGE_REGRESSION_MODE   block | warn (default warn) — governs this
#                           script's own exit code. Each individual merge is
#                           always checked in block semantics internally so a
#                           finding is never silently skipped; MODE only
#                           decides whether a finding fails the CI step.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
REGRESSION_SCRIPT="$REPO_ROOT/scripts/git/check-merge-regression.sh"
MODE="${MERGE_REGRESSION_MODE:-warn}"
BASE_REF="${1:-origin/main}"

MERGES="$(git rev-list --merges "${BASE_REF}..HEAD" 2>/dev/null || true)"

if [ -z "$MERGES" ]; then
  echo "[scan-pr-merges] No merge commits in ${BASE_REF}..HEAD; nothing to scan."
  exit 0
fi

OVERALL=0
SCANNED=0

while IFS= read -r m; do
  [ -z "$m" ] && continue

  p1="$(git rev-parse "${m}^1" 2>/dev/null || true)"
  p2="$(git rev-parse "${m}^2" 2>/dev/null || true)"
  if [ -z "$p1" ] || [ -z "$p2" ]; then
    continue
  fi

  # Branch side already fully contained in mainline side: a no-op merge for
  # this purpose (nothing was "brought in and resolved").
  if git merge-base --is-ancestor "$p2" "$p1" 2>/dev/null; then
    continue
  fi

  base="$(git merge-base "$p1" "$p2")"
  SCANNED=$((SCANNED + 1))
  echo ""
  echo "### $m — $(git log -1 --format=%s "$m") ###"
  if ! MERGE_REGRESSION_MODE=block bash "$REGRESSION_SCRIPT" "$base" "$p1" "$m"; then
    OVERALL=1
  fi
done <<< "$MERGES"

echo ""
echo "[scan-pr-merges] Checked ${SCANNED} sync-merge commit(s) in ${BASE_REF}..HEAD."

if [ "$OVERALL" -eq 1 ]; then
  echo "[scan-pr-merges] At least one merge commit above may have dropped content ${BASE_REF} already had."
  echo "[scan-pr-merges] Note: an early 'Merge origin/main into <branch>' commit can flag something"
  echo "the branch's OWN later commits already fixed. Check whether the same file is still flagged"
  echo "in this PR's FINAL merge commit before treating an earlier one as live."
  [ "$MODE" = "block" ] && exit 1
fi
exit 0
