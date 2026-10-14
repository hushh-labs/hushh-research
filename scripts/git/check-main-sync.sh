#!/bin/sh
# scripts/git/check-main-sync.sh
# Checks that the current branch contains the latest $MAIN_SYNC_REMOTE/$MAIN_SYNC_BRANCH
# (origin/main by default) before push/merge. A branch that already contains the
# base tip is fresh and passes in every mode. MAIN_SYNC_MODE decides what being
# behind means:
#   - block (default): fail. The merge queue (.github/workflows/queue-validation.yml),
#     PRs into integration/pr-train and scripts/ci/local-release-gate.sh use it.
#   - warn: print the advisory and exit 0 (pre-push on feature branches).
#   - bounded: fail only when being behind can hide something the PR's own checks
#     did not test; otherwise pass with a ::warning:: and a step summary. PR
#     Validation uses it for PRs into main. It blocks when either
#       a) the merge-base with the base tip was committed more than
#          MAIN_SYNC_MAX_AGE_HOURS ago (default 24), or
#       b) a file the base changed after the TESTED base is also changed by this
#          branch since the merge-base (up to 20 such paths are printed).
#     The tested base is MAIN_SYNC_TESTED_BASE_SHA, the first parent of the
#     refs/pull/N/merge commit the PR lanes ran on, when it is set and resolves
#     to a commit on the base. Otherwise it is the merge-base, which counts every
#     base change the branch lacks. A missing remote, failed fetch or unresolvable
#     commit blocks, exactly as in block mode.

set -e

REMOTE="${MAIN_SYNC_REMOTE:-origin}"
BRANCH="${MAIN_SYNC_BRANCH:-main}"
MODE="${MAIN_SYNC_MODE:-block}"
MAX_AGE_HOURS="${MAIN_SYNC_MAX_AGE_HOURS:-24}"
TESTED_BASE_INPUT="${MAIN_SYNC_TESTED_BASE_SHA:-}"

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

short_sha() {
  printf '%s' "$1" | cut -c1-8
}

# bounded mode, once the branch is known to be behind its base. Always exits.
bounded_check() {
  MERGE_BASE=$(git merge-base "$LOCAL_SHA" "$REMOTE_SHA" 2>/dev/null || echo "")
  MERGE_BASE_TIME=""
  if [ -n "$MERGE_BASE" ]; then
    MERGE_BASE_TIME=$(git show -s --no-show-signature --format=%ct "$MERGE_BASE" 2>/dev/null || echo "")
  fi
  NOW=$(date +%s)
  case "$MERGE_BASE_TIME:$NOW" in
    :*|*:|*[!0-9:]*)
      if ! warn_or_block \
        "Could not resolve when '$CURRENT_BRANCH' last shared history with $REMOTE/$BRANCH, so its staleness cannot be bounded." \
        "Run: git fetch $REMOTE $BRANCH && git merge $REMOTE/$BRANCH"; then
        :
      fi
      write_summary \
        "### Branch freshness" \
        "- Blocked: could not resolve the merge-base of \`$CURRENT_BRANCH\` and \`$REMOTE/$BRANCH\`, so its staleness cannot be bounded."
      exit 1
      ;;
  esac

  AGE_SECONDS=$((NOW - MERGE_BASE_TIME))
  if [ "$AGE_SECONDS" -lt 0 ]; then
    AGE_SECONDS=0
  fi
  AGE_LABEL="$((AGE_SECONDS / 3600))h $((AGE_SECONDS % 3600 / 60))m"

  # Only a commit on the base can be the tested base. Anything else falls back
  # to the merge-base, which counts every base change the branch lacks.
  TESTED_BASE=""
  TESTED_BASE_SOURCE="the merge-base; no tested base was supplied"
  if [ -n "$TESTED_BASE_INPUT" ]; then
    CANDIDATE=""
    case "$TESTED_BASE_INPUT" in
      *[!0-9a-fA-F]*) ;;
      *) CANDIDATE=$(git rev-parse --verify --quiet "$TESTED_BASE_INPUT^{commit}" 2>/dev/null || echo "") ;;
    esac
    if [ -n "$CANDIDATE" ] && git merge-base --is-ancestor "$CANDIDATE" "$REMOTE_SHA" 2>/dev/null; then
      TESTED_BASE="$CANDIDATE"
      TESTED_BASE_SOURCE="the base the PR checks tested"
    else
      TESTED_BASE_SOURCE="the merge-base; MAIN_SYNC_TESTED_BASE_SHA is not a commit on $REMOTE/$BRANCH"
    fi
  fi
  if [ -z "$TESTED_BASE" ]; then
    TESTED_BASE="$MERGE_BASE"
  fi

  # --no-renames: a file the base renamed must still match the old name the
  # branch edits. --no-relative: whole-repo paths even from a subdirectory.
  DIFF_OK=1
  BASE_CHANGED=$(git diff --name-only --no-renames --no-relative "$TESTED_BASE" "$REMOTE_SHA" 2>/dev/null) || DIFF_OK=0
  BRANCH_CHANGED=$(git diff --name-only --no-renames --no-relative "$MERGE_BASE" "$LOCAL_SHA" 2>/dev/null) || DIFF_OK=0
  if [ "$DIFF_OK" -ne 1 ]; then
    if ! warn_or_block \
      "Could not list the files changed on $REMOTE/$BRANCH or on '$CURRENT_BRANCH', so overlap cannot be ruled out." \
      "Run: git fetch $REMOTE $BRANCH && git merge $REMOTE/$BRANCH"; then
      :
    fi
    write_summary \
      "### Branch freshness" \
      "- Blocked: could not list changed files, so overlap with \`$REMOTE/$BRANCH\` cannot be ruled out."
    exit 1
  fi

  BASE_CHANGED_COUNT=0
  if [ -n "$BASE_CHANGED" ]; then
    BASE_CHANGED_COUNT=$(printf '%s\n' "$BASE_CHANGED" | wc -l | tr -d ' ')
  fi
  OVERLAP=$(
    {
      printf '%s\n' "$BASE_CHANGED" | sed 's/^/B /'
      printf '%s\n' "$BRANCH_CHANGED" | sed 's/^/H /'
    } | awk '
      substr($0, 1, 2) == "B " { base[substr($0, 3)] = 1; next }
      substr($0, 1, 2) == "H " {
        path = substr($0, 3)
        if (path != "" && (path in base) && !(path in seen)) { seen[path] = 1; print path }
      }
    '
  )

  STALE=0
  if [ "$AGE_SECONDS" -gt $((MAX_AGE_HOURS * 3600)) ]; then
    STALE=1
  fi

  if [ "$STALE" -eq 0 ] && [ -z "$OVERLAP" ]; then
    printf "\n\033[33m[main-sync] WARNING\033[0m Branch '%s' is behind %s/%s by %s commit(s); within bounds, not blocking.\n" \
      "$CURRENT_BRANCH" "$REMOTE" "$BRANCH" "$BEHIND_COUNT"
    printf "         %s\n" \
      "Tested base: $(short_sha "$TESTED_BASE") ($TESTED_BASE_SOURCE)" \
      "Merge-base:  $(short_sha "$MERGE_BASE"), committed $AGE_LABEL ago (limit ${MAX_AGE_HOURS}h)" \
      "No overlapping changes since the tested base: $REMOTE/$BRANCH changed $BASE_CHANGED_COUNT file(s) after it, none of which this branch changes." \
      "Remote:      $(short_sha "$REMOTE_SHA") ($REMOTE/$BRANCH)"
    printf "\n"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
      printf "::warning title=Branch Freshness Advisory::Branch '%s' is behind %s/%s by %s commit(s); no overlapping changes since the tested base and a %s old merge-base, so it does not block.\n" \
        "$CURRENT_BRANCH" "$REMOTE" "$BRANCH" "$BEHIND_COUNT" "$AGE_LABEL"
    fi
    write_summary \
      "### Branch freshness" \
      "- Behind, within bounds: branch \`$CURRENT_BRANCH\` is behind \`$REMOTE/$BRANCH\` by **$BEHIND_COUNT** commit(s). Not blocking." \
      "- Tested base: \`$(short_sha "$TESTED_BASE")\` ($TESTED_BASE_SOURCE)" \
      "- Merge-base age: $AGE_LABEL (limit ${MAX_AGE_HOURS}h), merge-base \`$(short_sha "$MERGE_BASE")\`" \
      "- No overlapping changes since the tested base: \`$REMOTE/$BRANCH\` changed $BASE_CHANGED_COUNT file(s) after it, none of which this branch changes." \
      "- Remote main: \`$(short_sha "$REMOTE_SHA")\`"
    exit 0
  fi

  REASONS=""
  if [ "$STALE" -eq 1 ]; then
    REASONS="its merge-base $(short_sha "$MERGE_BASE") was committed $AGE_LABEL ago, past the ${MAX_AGE_HOURS}h limit"
  fi
  OVERLAP_SUMMARY=""
  if [ -n "$OVERLAP" ]; then
    OVERLAP_COUNT=$(printf '%s\n' "$OVERLAP" | wc -l | tr -d ' ')
    REASONS="${REASONS:+$REASONS; }after the tested base $(short_sha "$TESTED_BASE"), $REMOTE/$BRANCH changed $OVERLAP_COUNT file(s) this branch also changes"
    OVERLAP_SUMMARY="- Overlapping paths (first 20):
$(printf '%s\n' "$OVERLAP" | head -n 20 | sed 's/^/  - `/; s/$/`/')"
  fi

  printf "\n\033[31m[main-sync] BLOCKED\033[0m Branch '%s' is behind %s/%s by %s commit(s): %s.\n" \
    "$CURRENT_BRANCH" "$REMOTE" "$BRANCH" "$BEHIND_COUNT" "$REASONS"
  printf "         %s\n" "Tested base: $(short_sha "$TESTED_BASE") ($TESTED_BASE_SOURCE)"
  if [ -n "$OVERLAP" ]; then
    printf "         %s\n" "Overlapping paths:"
    # The "- " prefix keeps a path from ever reading as a workflow command.
    printf '%s\n' "$OVERLAP" | head -n 20 | sed 's/^/           - /'
    if [ "$OVERLAP_COUNT" -gt 20 ]; then
      printf "           ... and %s more\n" "$((OVERLAP_COUNT - 20))"
    fi
  fi
  printf "         %s\n" \
    "Sync, then push, so the PR checks run on the base this branch will land on:" \
    "  ./bin/hushh sync main" \
    "  git fetch $REMOTE $BRANCH && git merge $REMOTE/$BRANCH"
  printf "\n"
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf "::error title=Branch Freshness::Branch '%s' is behind %s/%s by %s commit(s) and must sync: %s.\n" \
      "$CURRENT_BRANCH" "$REMOTE" "$BRANCH" "$BEHIND_COUNT" "$REASONS"
  fi
  write_summary \
    "### Branch freshness" \
    "- Blocked: branch \`$CURRENT_BRANCH\` is behind \`$REMOTE/$BRANCH\` by **$BEHIND_COUNT** commit(s): $REASONS." \
    "- Tested base: \`$(short_sha "$TESTED_BASE")\` ($TESTED_BASE_SOURCE)" \
    "- Merge-base age: $AGE_LABEL (limit ${MAX_AGE_HOURS}h)" \
    ${OVERLAP_SUMMARY:+"$OVERLAP_SUMMARY"} \
    "- Recommended: \`git fetch $REMOTE $BRANCH && git merge $REMOTE/$BRANCH\`"
  exit 1
}

case "$MODE" in
  block|warn|bounded) ;;
  *)
    printf "\033[31m[main-sync]\033[0m Unsupported MAIN_SYNC_MODE '%s'. Use 'block', 'warn' or 'bounded'.\n" "$MODE"
    exit 1
    ;;
esac

if [ "$MODE" = "bounded" ]; then
  case "$MAX_AGE_HOURS" in
    ''|*[!0-9]*|0?*)
      printf "\033[31m[main-sync]\033[0m MAIN_SYNC_MAX_AGE_HOURS must be a whole number of hours without leading zeros; got '%s'.\n" "$MAX_AGE_HOURS"
      exit 1
      ;;
  esac
fi

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
if [ "$MODE" = "bounded" ]; then
  bounded_check
fi
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
