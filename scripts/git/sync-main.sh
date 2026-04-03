#!/usr/bin/env bash
set -euo pipefail

REMOTE="${MAIN_SYNC_REMOTE:-origin}"
BRANCH="${MAIN_SYNC_BRANCH:-main}"
CURRENT_BRANCH="$(git branch --show-current)"

if [ -z "$CURRENT_BRANCH" ]; then
  echo "Detached HEAD detected; switch to a branch first." >&2
  exit 1
fi

if [ "$CURRENT_BRANCH" = "$BRANCH" ]; then
  echo "Already on ${BRANCH}; nothing to sync."
  exit 0
fi

echo "Fetching ${REMOTE}/${BRANCH}..."
git fetch "$REMOTE" "$BRANCH" --quiet
echo "Merging ${REMOTE}/${BRANCH} into ${CURRENT_BRANCH}..."
git merge "${REMOTE}/${BRANCH}"
