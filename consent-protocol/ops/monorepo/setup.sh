#!/bin/sh
# consent-protocol/ops/monorepo/setup.sh
# Installs git hooks + subtree sync prerequisites for a host monorepo.

set -e

UPSTREAM_REMOTE="${CONSENT_UPSTREAM_REMOTE:-consent-upstream}"
UPSTREAM_BRANCH="${CONSENT_UPSTREAM_BRANCH:-main}"
SUBTREE_PREFIX="${CONSENT_SUBTREE_PREFIX:-consent-protocol}"
SYNC_REF="${CONSENT_SYNC_REF:-refs/subtree-sync/consent-protocol}"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
HOOKS_DIR="$REPO_ROOT/.githooks"

if [ ! -d "$REPO_ROOT/.git" ]; then
  # CI tarball / archive mode.
  exit 0
fi

if [ ! -d "$REPO_ROOT/$SUBTREE_PREFIX" ]; then
  echo "[setup-hooks] '$SUBTREE_PREFIX/' not found under repo root."
  echo "[setup-hooks] This setup script is intended for a host monorepo checkout."
  exit 0
fi

CURRENT_HOOKS_PATH=$(cd "$REPO_ROOT" && git config core.hooksPath 2>/dev/null || true)
if [ "$CURRENT_HOOKS_PATH" = ".githooks" ]; then
  echo "[setup-hooks] Git hooks already configured. ✓"
else
  (cd "$REPO_ROOT" && git config core.hooksPath .githooks)
  echo "[setup-hooks] Git hooks path set to .githooks ✓"
fi

if [ -d "$HOOKS_DIR" ]; then
  for hook in "$HOOKS_DIR"/*; do
    if [ -f "$hook" ]; then
      chmod +x "$hook"
    fi
  done
  echo "[setup-hooks] Hook files are executable. ✓"
fi

if (cd "$REPO_ROOT" && git remote | grep -q "^${UPSTREAM_REMOTE}$"); then
  echo "[setup-hooks] Remote '$UPSTREAM_REMOTE' already configured. ✓"
else
  (
    cd "$REPO_ROOT" &&
    git remote add "$UPSTREAM_REMOTE" https://github.com/hushh-labs/consent-protocol.git 2>/dev/null
  ) && echo "[setup-hooks] Remote '$UPSTREAM_REMOTE' added. ✓" || \
    echo "[setup-hooks] Could not add $UPSTREAM_REMOTE remote (may already exist)."
fi

if git -C "$REPO_ROOT" show-ref --verify --quiet "$SYNC_REF" 2>/dev/null; then
  echo "[setup-hooks] Subtree sync bookmark already set. ✓"
else
  if (cd "$REPO_ROOT" && git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" --quiet 2>/dev/null); then
    UPSTREAM_SHA=$(cd "$REPO_ROOT" && git rev-parse "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" 2>/dev/null || echo "")
    HISTORY_SHA=$(
      cd "$REPO_ROOT" &&
      git log --format='%B' --grep="git-subtree-dir: $SUBTREE_PREFIX" -n 1 2>/dev/null \
        | sed -n 's/^git-subtree-split: //p' | head -n 1
    )

    TARGET_SHA="$UPSTREAM_SHA"
    if [ -n "$HISTORY_SHA" ] && \
       git -C "$REPO_ROOT" cat-file -e "$HISTORY_SHA^{commit}" 2>/dev/null && \
       git -C "$REPO_ROOT" merge-base --is-ancestor "$HISTORY_SHA" "$UPSTREAM_SHA" 2>/dev/null; then
      TARGET_SHA="$HISTORY_SHA"
    fi

    if [ -n "$TARGET_SHA" ]; then
      (cd "$REPO_ROOT" && git update-ref "$SYNC_REF" "$TARGET_SHA")
      echo "[setup-hooks] Sync bookmark initialized ($(echo "$TARGET_SHA" | cut -c1-8)). ✓"
    fi
  else
    echo "[setup-hooks] Could not fetch upstream -- bookmark will be set on first './bin/hushh protocol sync'."
  fi
fi

echo "[setup-hooks] Done. Hooks are active for this repo."
