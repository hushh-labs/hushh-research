#!/bin/sh
# consent-protocol/ops/monorepo/pre-commit.sh
# Lint gate + subtree reminder for consent-protocol/ changes.

SUBTREE_PREFIX="${CONSENT_SUBTREE_PREFIX:-consent-protocol}"

if git diff --cached --name-only | grep -q "^${SUBTREE_PREFIX}/"; then
  printf "\n\033[33m[subtree]\033[0m ${SUBTREE_PREFIX}/ files staged.\n"
  printf "         After merge, run: \033[36m./bin/hushh protocol push\033[0m to sync upstream.\n\n"

  echo "[pre-commit] Running quick lint on ${SUBTREE_PREFIX}..."

  if [ ! -x "${SUBTREE_PREFIX}/.venv/bin/python3" ] && ! command -v python3 >/dev/null 2>&1; then
    echo "[pre-commit] ERROR: python3 not found. Please install Python 3."
    exit 1
  fi

  if [ -x "${SUBTREE_PREFIX}/.venv/bin/python3" ]; then
    LINT_PYTHON=".venv/bin/python3"
  else
    LINT_PYTHON="python3"
  fi

  (
    cd "$SUBTREE_PREFIX" &&
    "$LINT_PYTHON" -m ruff check . &&
    "$LINT_PYTHON" -m ruff format --check .
  ) || {
    echo ""
    echo "[pre-commit] Lint failed. Run: ./bin/hushh protocol fix"
    exit 1
  }
fi
