#!/bin/sh
# scripts/git/check-main-sync.sh
# Ensures the current branch contains the latest origin/main before push/merge.
# Modes:
#   - block: fail when behind main
#   - warn:  emit warning output but allow the caller to continue

set -e

REMOTE="${MAIN_SYNC_REMOTE:-origin}"
BRANCH="${MAIN_SYNC_BRANCH:-main}"
MODE="${MAIN_SYNC_MODE:-block}"

CURRENT_BRANCH="${MAIN_SYNC_CURRENT_BRANCH:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-$(git branch --show-current 2>/dev/null || true)}}}"

write_summary() {
  if [ -z "${GITHUB_STEP_SUMMARY:-}" ]; then
    return 0
  fi

  {
    printf '%s\n' "$1"
    if [ $# -gt 1 ]; then
      shift
      while [ $# -gt 0 ]; do
        printf '%s\n' "$1"
        shift
      done
    fi
    printf '\n'
  } >>"$GITHUB_STEP_SUMMARY"
}

warn_or_block() {
  MESSAGE="$1"
  shift

  if [ "$MODE" = "warn" ]; then
    printf "\n\033[33m[main-sync] WARNING\033[0m %s\n" "$MESSAGE"
    while [ $# -gt 0 ]; do
      printf "         %s\n" "$1"
      shift
    done
    printf "\n"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
      printf "::warning title=Branch Freshness Advisory::%s\n" "$MESSAGE"
    fi
    return 0
  fi

  printf "\n\033[31m[main-sync] BLOCKED\033[0m %s\n" "$MESSAGE"
  while [ $# -gt 0 ]; do
    printf "         %s\n" "$1"
    shift
  done
  printf "\n"
  return 1
}

case "$MODE" in
  block|warn) ;;
  *)
    printf "\033[31m[main-sync]\033[0m Unsupported MAIN_SYNC_MODE '%s'. Use 'block' or 'warn'.\n" "$MODE"
    exit 1
    ;;
esac

if [ -z "$CURRENT_BRANCH" ]; then
  printf "\033[33m[main-sync]\033[0m Detached HEAD detected; skipping %s/%s check.\n" "$REMOTE" "$BRANCH"
  write_summary "### Branch freshness" "- Skipped because the current ref is detached and no branch name was provided."
  exit 0
fi

if [ "$CURRENT_BRANCH" = "$BRANCH" ]; then
  printf "\033[32m[main-sync]\033[0m On %s; no branch sync needed.\n" "$BRANCH"
  write_summary "### Branch freshness" "- On \`$BRANCH\`; no freshness check required."
  exit 0
fi

if ! git remote | grep -q "^${REMOTE}$"; then
  if ! warn_or_block \
    "Remote '$REMOTE' is not configured." \
    "Run: git remote add $REMOTE <repo-url>"; then
    :
  fi
  write_summary \
    "### Branch freshness" \
    "- Could not check freshness because remote \`$REMOTE\` is not configured."
  [ "$MODE" = "warn" ] && exit 0
  exit 1
fi

if ! git fetch "$REMOTE" "$BRANCH" --quiet 2>/dev/null; then
  if ! warn_or_block \
    "Could not fetch $REMOTE/$BRANCH." \
    "Run: git fetch $REMOTE $BRANCH"; then
    :
  fi
  write_summary \
    "### Branch freshness" \
    "- Could not check freshness because \`$REMOTE/$BRANCH\` could not be fetched."
  [ "$MODE" = "warn" ] && exit 0
  exit 1
fi

REMOTE_SHA=$(git rev-parse "$REMOTE/$BRANCH" 2>/dev/null || echo "")
LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

if [ -z "$REMOTE_SHA" ] || [ -z "$LOCAL_SHA" ]; then
  if ! warn_or_block "Could not resolve local or remote commit state."; then
    :
  fi
  write_summary \
    "### Branch freshness" \
    "- Could not resolve the local or remote commit state needed for freshness checks."
  [ "$MODE" = "warn" ] && exit 0
  exit 1
fi

if git merge-base --is-ancestor "$REMOTE_SHA" "$LOCAL_SHA" 2>/dev/null; then
  printf "\033[32m[main-sync]\033[0m Branch contains latest %s/%s. ✓\n" "$REMOTE" "$BRANCH"
  printf "         Local:  %s (%s)\n" "$(echo "$LOCAL_SHA" | cut -c1-8)" "$CURRENT_BRANCH"
  printf "         Remote: %s (%s/%s)\n" "$(echo "$REMOTE_SHA" | cut -c1-8)" "$REMOTE" "$BRANCH"
  write_summary \
    "### Branch freshness" \
    "- Fresh: branch \`$CURRENT_BRANCH\` already contains the latest \`$REMOTE/$BRANCH\`." \
    "- Local head: \`$(echo "$LOCAL_SHA" | cut -c1-8)\`" \
    "- Remote main: \`$(echo "$REMOTE_SHA" | cut -c1-8)\`"
  exit 0
fi

BEHIND_COUNT=$(git rev-list "$LOCAL_SHA".."$REMOTE_SHA" --count 2>/dev/null || echo "unknown")
if ! warn_or_block \
  "Branch '$CURRENT_BRANCH' is behind $REMOTE/$BRANCH by $BEHIND_COUNT commit(s)." \
  "Local:  $(echo "$LOCAL_SHA" | cut -c1-8)" \
  "Remote: $(echo "$REMOTE_SHA" | cut -c1-8)" \
  "Run one of:" \
  "  ./bin/hushh sync main" \
  "  git fetch $REMOTE $BRANCH && git merge $REMOTE/$BRANCH" \
  "  git fetch $REMOTE $BRANCH && git rebase $REMOTE/$BRANCH"; then
  :
fi
write_summary \
  "### Branch freshness" \
  "- Behind: branch \`$CURRENT_BRANCH\` is behind \`$REMOTE/$BRANCH\` by **$BEHIND_COUNT** commit(s)." \
  "- Local head: \`$(echo "$LOCAL_SHA" | cut -c1-8)\`" \
  "- Remote main: \`$(echo "$REMOTE_SHA" | cut -c1-8)\`" \
  "- Recommended: \`git fetch $REMOTE $BRANCH && git merge $REMOTE/$BRANCH\` or \`git fetch $REMOTE $BRANCH && git rebase $REMOTE/$BRANCH\`"
[ "$MODE" = "warn" ] && exit 0
exit 1
