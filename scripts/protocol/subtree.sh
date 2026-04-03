#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

UPSTREAM_REMOTE="${CONSENT_UPSTREAM_REMOTE:-consent-upstream}"
UPSTREAM_BRANCH="${CONSENT_UPSTREAM_BRANCH:-main}"
SUBTREE_PREFIX="${CONSENT_SUBTREE_PREFIX:-consent-protocol}"
SYNC_REF="${CONSENT_SYNC_REF:-refs/subtree-sync/consent-protocol}"
MONOREPO_OPS="${CONSENT_MONOREPO_OPS:-consent-protocol/ops/monorepo}"
VERIFY_UPSTREAM_CI="${CONSENT_UPSTREAM_VERIFY_CI:-1}"

usage() {
  cat <<'EOF'
Usage:
  ./bin/hushh protocol <sync|check-sync|push|push-force|verify-upstream-ci|verify-ci-parity|setup|verify-setup>
EOF
}

verify_ci_parity() {
  bash "$REPO_ROOT/scripts/ci/verify-protocol-ci-parity.sh"
}

verify_upstream_ci() {
  CONSENT_UPSTREAM_REPO=hushh-labs/consent-protocol \
    CONSENT_UPSTREAM_BRANCH="$UPSTREAM_BRANCH" \
    bash "$REPO_ROOT/scripts/ci/verify-protocol-upstream-ci.sh" "$@"
}

check_sync() {
  verify_ci_parity
  CONSENT_UPSTREAM_REMOTE="$UPSTREAM_REMOTE" \
    CONSENT_UPSTREAM_BRANCH="$UPSTREAM_BRANCH" \
    CONSENT_SUBTREE_PREFIX="$SUBTREE_PREFIX" \
    CONSENT_SYNC_REF="$SYNC_REF" \
    sh "$REPO_ROOT/$MONOREPO_OPS/pre-push.sh" --check-only
}

verify_setup() {
  echo ""
  echo "==============================================="
  echo " Hushh Research — Setup Verification"
  echo "==============================================="
  echo ""

  printf "  Git hooks path:        "
  local hooks_path=""
  hooks_path="$(git config core.hooksPath 2>/dev/null || echo "")"
  if [ "$hooks_path" = ".githooks" ]; then
    printf "\033[32m%s\033[0m\n" "✓ .githooks"
  else
    printf "\033[31m%s\033[0m\n" "✗ not set (run: ./bin/hushh protocol setup)"
  fi

  printf "  pre-commit hook:       "
  if [ -x .githooks/pre-commit ]; then
    printf "\033[32m%s\033[0m\n" "✓ installed"
  else
    printf "\033[31m%s\033[0m\n" "✗ missing or not executable"
  fi

  printf "  pre-push hook:         "
  if [ -x .githooks/pre-push ]; then
    printf "\033[32m%s\033[0m\n" "✓ installed"
  else
    printf "\033[31m%s\033[0m\n" "✗ missing or not executable"
  fi

  printf "  ${UPSTREAM_REMOTE}:      "
  if git remote | grep -q "^${UPSTREAM_REMOTE}$"; then
    printf "\033[32m%s\033[0m\n" "✓ configured"
  else
    printf "\033[31m%s\033[0m\n" "✗ not configured (run: ./bin/hushh protocol setup)"
  fi

  printf "  python3:               "
  if command -v python3 >/dev/null 2>&1; then
    printf "\033[32m%s\033[0m\n" "✓ $(python3 --version 2>&1)"
  else
    printf "\033[31m%s\033[0m\n" "✗ not found"
  fi

  printf "  ruff:                  "
  if python3 -m ruff --version >/dev/null 2>&1; then
    printf "\033[32m%s\033[0m\n" "✓ $(python3 -m ruff --version 2>&1)"
  else
    printf "\033[31m%s\033[0m\n" "✗ not found (pip3 install ruff)"
  fi

  printf "  node:                  "
  if command -v node >/dev/null 2>&1; then
    printf "\033[32m%s\033[0m\n" "✓ $(node --version 2>&1)"
  else
    printf "\033[31m%s\033[0m\n" "✗ not found"
  fi

  echo ""
}

sync_protocol() {
  verify_ci_parity
  echo "Pulling ${SUBTREE_PREFIX} from upstream..."
  git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" --quiet
  git subtree pull --prefix="$SUBTREE_PREFIX" "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" --squash
  echo "Updating sync bookmark..."
  git update-ref "$SYNC_REF" "$(git rev-parse "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"
  echo "Done. ${SUBTREE_PREFIX}/ is now in sync with upstream."
  echo "Bookmark: $(git rev-parse "$SYNC_REF" | cut -c1-8)"
}

push_protocol() {
  local force="${1:-false}"

  if [ "$force" != "true" ]; then
    check_sync
  else
    verify_ci_parity
    echo "Skipping upstream sync check (force mode)..."
  fi

  echo "Pushing ${SUBTREE_PREFIX}/ to upstream..."
  git subtree push --prefix="$SUBTREE_PREFIX" "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
  if [ "$VERIFY_UPSTREAM_CI" = "1" ]; then
    verify_upstream_ci
  else
    echo "Skipping upstream CI verification (CONSENT_UPSTREAM_VERIFY_CI=${VERIFY_UPSTREAM_CI})."
  fi
  echo "Done. Upstream consent-protocol repo is now updated."
}

setup_protocol() {
  CONSENT_UPSTREAM_REMOTE="$UPSTREAM_REMOTE" \
    CONSENT_UPSTREAM_BRANCH="$UPSTREAM_BRANCH" \
    CONSENT_SUBTREE_PREFIX="$SUBTREE_PREFIX" \
    CONSENT_SYNC_REF="$SYNC_REF" \
    sh "$REPO_ROOT/$MONOREPO_OPS/setup.sh"
  verify_setup
}

COMMAND="${1:-}"
if [ -z "$COMMAND" ]; then
  usage
  exit 1
fi
shift || true

case "$COMMAND" in
  -h|--help|help)
    usage
    ;;
  verify-ci-parity)
    [ "$#" -eq 0 ] || {
      echo "verify-ci-parity does not accept extra arguments." >&2
      exit 1
    }
    verify_ci_parity
    ;;
  verify-upstream-ci)
    verify_upstream_ci "$@"
    ;;
  check-sync)
    [ "$#" -eq 0 ] || {
      echo "check-sync does not accept extra arguments." >&2
      exit 1
    }
    check_sync
    ;;
  sync)
    [ "$#" -eq 0 ] || {
      echo "sync does not accept extra arguments." >&2
      exit 1
    }
    sync_protocol
    ;;
  push)
    [ "$#" -eq 0 ] || {
      echo "push does not accept extra arguments." >&2
      exit 1
    }
    push_protocol false
    ;;
  push-force)
    [ "$#" -eq 0 ] || {
      echo "push-force does not accept extra arguments." >&2
      exit 1
    }
    push_protocol true
    ;;
  setup)
    [ "$#" -eq 0 ] || {
      echo "setup does not accept extra arguments." >&2
      exit 1
    }
    setup_protocol
    ;;
  verify-setup)
    [ "$#" -eq 0 ] || {
      echo "verify-setup does not accept extra arguments." >&2
      exit 1
    }
    verify_setup
    ;;
  *)
    usage
    exit 1
    ;;
esac
