#!/usr/bin/env bash
set -euo pipefail

REMOTE="${MAIN_SYNC_REMOTE:-origin}"
BRANCH="${MAIN_SYNC_BRANCH:-main}"
CURRENT_BRANCH="$(git branch --show-current)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
# git-dir, not "$REPO_ROOT/.git" — in a linked worktree (common in this repo)
# .git is a FILE pointing elsewhere, so that path never resolves.
GIT_DIR="$(git rev-parse --git-dir)"
STATE_FILE="$GIT_DIR/HUSHH_SYNC_BASE"
REGRESSION_SCRIPT="$REPO_ROOT/scripts/git/check-merge-regression.sh"
# warn by default: the check is a text heuristic (occurrence matching), and
# testing surfaced real false positives on large files with repeated
# boilerplate (e.g. many callbacks sharing one signature line). Read the
# report either way; opt into MERGE_REGRESSION_MODE=block once you've seen it
# stay quiet on your own files and want it to stop the merge outright.
MERGE_REGRESSION_MODE="${MERGE_REGRESSION_MODE:-warn}"

if [ -z "$CURRENT_BRANCH" ]; then
  echo "Detached HEAD detected; switch to a branch first." >&2
  exit 1
fi

if [ "$CURRENT_BRANCH" = "$BRANCH" ]; then
  echo "Already on ${BRANCH}; nothing to sync."
  exit 0
fi

run_regression_check() {
  local base="$1" upstream="$2"
  if [ ! -x "$REGRESSION_SCRIPT" ] && [ ! -f "$REGRESSION_SCRIPT" ]; then
    echo "[sync-main] check-merge-regression.sh not found; skipping fidelity check." >&2
    return 0
  fi
  echo ""
  echo "Checking that the merge didn't silently drop anything ${REMOTE}/${BRANCH} already had..."
  MERGE_REGRESSION_MODE="$MERGE_REGRESSION_MODE" \
    bash "$REGRESSION_SCRIPT" "$base" "$upstream" HEAD
}

echo "Fetching ${REMOTE}/${BRANCH}..."
git fetch "$REMOTE" "$BRANCH" --quiet

BASE="$(git merge-base HEAD "${REMOTE}/${BRANCH}")"
UPSTREAM_SHA="$(git rev-parse "${REMOTE}/${BRANCH}")"
printf '%s %s\n' "$BASE" "$UPSTREAM_SHA" > "$STATE_FILE"

echo "Merging ${REMOTE}/${BRANCH} into ${CURRENT_BRANCH}..."
if git merge "${REMOTE}/${BRANCH}"; then
  run_regression_check "$BASE" "$UPSTREAM_SHA"
  rm -f "$STATE_FILE"
else
  cat >&2 <<EOF

[sync-main] Merge stopped with conflicts. Resolve them keeping BOTH sides'
intent (never just pick one side to make it merge), then either:
  git add <resolved files> && git commit --no-edit && ./bin/hushh sync verify-merge
or abort with:
  git merge --abort
EOF
  exit 1
fi
