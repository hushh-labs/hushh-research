#!/bin/sh
# consent-protocol/ops/monorepo/pre-push.sh
# Subtree sync guard + lint gate for consent-protocol subtree changes.

CHECK_ONLY=0
if [ "${1:-}" = "--check-only" ]; then
  CHECK_ONLY=1
  shift
fi

REMOTE="${1:-}"
URL="${2:-}"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

UPSTREAM_REMOTE="${CONSENT_UPSTREAM_REMOTE:-consent-upstream}"
UPSTREAM_BRANCH="${CONSENT_UPSTREAM_BRANCH:-main}"
SUBTREE_PREFIX="${CONSENT_SUBTREE_PREFIX:-consent-protocol}"
SYNC_REF="${CONSENT_SYNC_REF:-refs/subtree-sync/consent-protocol}"
MAIN_SYNC_REMOTE="${MAIN_SYNC_REMOTE:-origin}"
MAIN_SYNC_BRANCH="${MAIN_SYNC_BRANCH:-main}"
MAIN_SYNC_SCRIPT="${MAIN_SYNC_SCRIPT:-scripts/git/check-main-sync.sh}"

CP_FILES=""
STRICT_MODE="$CHECK_ONLY"
CURRENT_UPSTREAM=""
BOOKMARK_SYNC=""
HISTORY_SYNC=""
EFFECTIVE_SYNC=""
EFFECTIVE_AHEAD=""
LOCAL_SPLIT=""

latest_subtree_split_from_history() {
  git log --format='%B' --grep="git-subtree-dir: ${SUBTREE_PREFIX}" -n 1 2>/dev/null \
    | sed -n 's/^git-subtree-split: //p' | head -n 1
}

compute_local_split() {
  SPLIT_HASH=$(git subtree split --prefix="$SUBTREE_PREFIX" HEAD 2>/dev/null || true)
  if [ -z "$SPLIT_HASH" ]; then
    # Fallback for histories where old subtree joins reference unavailable split hashes.
    SPLIT_HASH=$(git subtree split --ignore-joins --prefix="$SUBTREE_PREFIX" HEAD 2>/dev/null || true)
  fi
  printf "%s" "$SPLIT_HASH" | tail -n 1
}

choose_effective_sync_anchor() {
  CURRENT="$1"
  EFFECTIVE_SYNC=""
  EFFECTIVE_AHEAD=""

  for CANDIDATE in "$BOOKMARK_SYNC" "$HISTORY_SYNC"; do
    [ -z "$CANDIDATE" ] && continue

    if ! git cat-file -e "$CANDIDATE^{commit}" 2>/dev/null; then
      continue
    fi

    if ! git merge-base --is-ancestor "$CANDIDATE" "$CURRENT" 2>/dev/null; then
      continue
    fi

    AHEAD_COUNT=$(git rev-list "$CANDIDATE".."$CURRENT" --count 2>/dev/null || echo "")
    [ -z "$AHEAD_COUNT" ] && continue

    if [ -z "$EFFECTIVE_SYNC" ] || [ "$AHEAD_COUNT" -lt "$EFFECTIVE_AHEAD" ]; then
      EFFECTIVE_SYNC="$CANDIDATE"
      EFFECTIVE_AHEAD="$AHEAD_COUNT"
    fi
  done
}

trees_match_upstream() {
  UPSTREAM_TREE=$(git rev-parse "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH^{tree}" 2>/dev/null || echo "")
  LOCAL_TREE=$(git rev-parse "HEAD:${SUBTREE_PREFIX}" 2>/dev/null || echo "")

  [ -n "$UPSTREAM_TREE" ] && [ -n "$LOCAL_TREE" ] && [ "$UPSTREAM_TREE" = "$LOCAL_TREE" ]
}

run_sync_gate() {
  if ! git remote | grep -q "^${UPSTREAM_REMOTE}$"; then
    printf "\033[33m[pre-push]\033[0m WARNING: %s remote not configured.\n" "$UPSTREAM_REMOTE"
    printf "         Run \033[36mmake setup\033[0m to configure monorepo sync.\n\n"
    [ "$STRICT_MODE" -eq 1 ] && return 1
    return 0
  fi

  if ! git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" --quiet 2>/dev/null; then
    printf "\033[33m[pre-push]\033[0m WARNING: Could not fetch %s/%s.\n" "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
    printf "         Run \033[36mmake sync-protocol\033[0m manually after push.\n\n"
    [ "$STRICT_MODE" -eq 1 ] && return 1
    return 0
  fi

  CURRENT_UPSTREAM=$(git rev-parse "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" 2>/dev/null || echo "")
  if [ -z "$CURRENT_UPSTREAM" ]; then
    printf "\033[31m[pre-push]\033[0m Could not resolve %s/%s.\n" "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
    [ "$STRICT_MODE" -eq 1 ] && return 1
    return 0
  fi

  LOCAL_SPLIT=$(compute_local_split)
  if [ -n "$LOCAL_SPLIT" ]; then
    if [ "$LOCAL_SPLIT" = "$CURRENT_UPSTREAM" ]; then
      :
    elif git merge-base --is-ancestor "$CURRENT_UPSTREAM" "$LOCAL_SPLIT" 2>/dev/null; then
      :
    elif git merge-base --is-ancestor "$LOCAL_SPLIT" "$CURRENT_UPSTREAM" 2>/dev/null; then
      BEHIND_COUNT=$(git rev-list "$LOCAL_SPLIT".."$CURRENT_UPSTREAM" --count 2>/dev/null || echo "unknown")
      printf "\n\033[31m[pre-push] BLOCKED\033[0m Local subtree split is behind upstream by %s commit(s).\n" "$BEHIND_COUNT"
      printf "         Local split:     %s\n" "$(echo "$LOCAL_SPLIT" | cut -c1-8)"
      printf "         Current upstream:%s\n\n" " $(echo "$CURRENT_UPSTREAM" | cut -c1-8)"
      printf "  Run:\n"
      printf "    \033[36mmake sync-protocol\033[0m    # pull upstream + refresh bookmark\n"
      printf "    \033[36mgit push\033[0m              # try again\n\n"
      return 1
    elif trees_match_upstream; then
      printf "\033[32m[pre-push]\033[0m Subtree trees match upstream (history diverged, content equivalent). ✓\n"
      if git update-ref "$SYNC_REF" "$CURRENT_UPSTREAM" 2>/dev/null; then
        printf "         Bookmark healed to %s.\n\n" "$(echo "$CURRENT_UPSTREAM" | cut -c1-8)"
      fi
      return 0
    else
      printf "\n\033[31m[pre-push] BLOCKED\033[0m Local subtree split diverged from upstream.\n"
      printf "         Local split:     %s\n" "$(echo "$LOCAL_SPLIT" | cut -c1-8)"
      printf "         Current upstream:%s\n\n" " $(echo "$CURRENT_UPSTREAM" | cut -c1-8)"
      printf "  Run:\n"
      printf "    \033[36mmake sync-protocol\033[0m    # reconcile subtree history\n"
      printf "    \033[36m# resolve conflicts if any\033[0m\n"
      printf "    \033[36mgit push\033[0m              # try again\n\n"
      return 1
    fi
  fi

  if git show-ref --verify --quiet "$SYNC_REF" 2>/dev/null; then
    BOOKMARK_SYNC=$(git rev-parse "$SYNC_REF" 2>/dev/null || echo "")
  fi
  HISTORY_SYNC=$(latest_subtree_split_from_history)

  choose_effective_sync_anchor "$CURRENT_UPSTREAM"

  if [ -z "$EFFECTIVE_SYNC" ]; then
    if trees_match_upstream; then
      printf "\033[32m[pre-push]\033[0m Tree-level sync detected (bookmark metadata missing). ✓\n"
      if git update-ref "$SYNC_REF" "$CURRENT_UPSTREAM" 2>/dev/null; then
        printf "         Bookmark healed to %s.\n\n" "$(echo "$CURRENT_UPSTREAM" | cut -c1-8)"
      fi
      return 0
    fi

    printf "\033[31m[pre-push]\033[0m No valid subtree sync baseline found.\n"
    printf "         Bookmark ref: %s\n" "${BOOKMARK_SYNC:-<missing>}"
    printf "         History split: %s\n" "${HISTORY_SYNC:-<missing>}"
    printf "         Run: \033[36mmake sync-protocol\033[0m\n\n"
    [ "$STRICT_MODE" -eq 1 ] && return 1
    return 0
  fi

  if [ "$EFFECTIVE_AHEAD" -gt 0 ]; then
    # Branch-safe recovery: if content is already synced but local metadata is stale.
    if trees_match_upstream; then
      printf "\033[32m[pre-push]\033[0m Subtree content already matches upstream (metadata was stale). ✓\n"
      if git update-ref "$SYNC_REF" "$CURRENT_UPSTREAM" 2>/dev/null; then
        printf "         Bookmark healed to %s.\n\n" "$(echo "$CURRENT_UPSTREAM" | cut -c1-8)"
      fi
      return 0
    fi

    printf "\n\033[31m[pre-push] BLOCKED\033[0m %s/%s is %s commit(s) ahead of your sync point.\n" \
      "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" "$EFFECTIVE_AHEAD"
    printf "         Sync baseline:   %s\n" "$(echo "$EFFECTIVE_SYNC" | cut -c1-8)"
    printf "         Current upstream:%s\n\n" " $(echo "$CURRENT_UPSTREAM" | cut -c1-8)"
    printf "  Run:\n"
    printf "    \033[36mmake sync-protocol\033[0m    # pull upstream + refresh bookmark\n"
    printf "    \033[36m# resolve conflicts if any\033[0m\n"
    printf "    \033[36mgit push\033[0m              # try again\n\n"
    return 1
  fi

  printf "\033[32m[pre-push]\033[0m Upstream is in sync. ✓\n"
  printf "         Sync baseline:   %s\n" "$(echo "$EFFECTIVE_SYNC" | cut -c1-8)"
  printf "         Current upstream:%s\n" " $(echo "$CURRENT_UPSTREAM" | cut -c1-8)"

  # Heal stale local bookmark when branch history proves we're already synced.
  if [ "$BOOKMARK_SYNC" != "$CURRENT_UPSTREAM" ]; then
    if git update-ref "$SYNC_REF" "$CURRENT_UPSTREAM" 2>/dev/null; then
      printf "         Bookmark updated to %s.\n" "$(echo "$CURRENT_UPSTREAM" | cut -c1-8)"
    fi
  fi

  printf "         Remember to run \033[36mmake push-protocol\033[0m after PR merge.\n\n"
  return 0
}

should_check_subtree=0
should_check_main=0

if [ "$CHECK_ONLY" -eq 1 ]; then
  should_check_subtree=1
  should_check_main=1
else
  case "$URL" in
    *hushh-research*)
      should_check_main=1
      while read local_ref local_sha remote_ref remote_sha; do
        [ -z "$local_sha" ] && continue

        if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
          RANGE="$local_sha"
        else
          RANGE="$remote_sha..$local_sha"
        fi

        CHANGED=$(git diff --name-only "$RANGE" 2>/dev/null | grep "^${SUBTREE_PREFIX}/" || true)
        if [ -n "$CHANGED" ]; then
          should_check_subtree=1
          CP_FILES="$CP_FILES
$CHANGED"
        fi
      done
      ;;
  esac
fi

if [ "$should_check_main" -eq 1 ] && [ -f "$REPO_ROOT/$MAIN_SYNC_SCRIPT" ]; then
  CURRENT_BRANCH_NAME=$(git branch --show-current 2>/dev/null || true)
  MAIN_SYNC_MODE="warn"
  case "$CURRENT_BRANCH_NAME" in
    "$MAIN_SYNC_BRANCH"|deploy|deploy_uat)
      MAIN_SYNC_MODE="block"
      ;;
  esac
  printf "\n\033[33m[pre-push]\033[0m Checking branch freshness against %s/%s...\n" "$MAIN_SYNC_REMOTE" "$MAIN_SYNC_BRANCH"
  if ! MAIN_SYNC_REMOTE="$MAIN_SYNC_REMOTE" \
    MAIN_SYNC_BRANCH="$MAIN_SYNC_BRANCH" \
    MAIN_SYNC_MODE="$MAIN_SYNC_MODE" \
    MAIN_SYNC_CURRENT_BRANCH="$CURRENT_BRANCH_NAME" \
    sh "$REPO_ROOT/$MAIN_SYNC_SCRIPT"; then
    exit 1
  fi
fi

if [ "$should_check_subtree" -eq 1 ]; then
  printf "\n\033[33m[pre-push]\033[0m Checking %s sync status...\n" "$SUBTREE_PREFIX"
  if ! run_sync_gate; then
    exit 1
  fi
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  exit 0
fi

if [ -n "$CP_FILES" ]; then
  echo "[pre-push] Running quick lint on ${SUBTREE_PREFIX}..."

  if [ -x "${SUBTREE_PREFIX}/.venv/bin/python3" ]; then
    LINT_PYTHON=".venv/bin/python3"
  elif command -v python3 >/dev/null 2>&1; then
    LINT_PYTHON="python3"
  else
    LINT_PYTHON=""
  fi

  if [ -n "$LINT_PYTHON" ]; then
    (
      cd "$SUBTREE_PREFIX" &&
      "$LINT_PYTHON" -m ruff check . &&
      "$LINT_PYTHON" -m ruff format --check .
    ) || {
      echo ""
      echo "[pre-push] Lint failed. Run: cd ${SUBTREE_PREFIX} && make fix"
      exit 1
    }
  else
    echo "[pre-push] WARNING: python3 not found, skipping lint."
  fi
fi
