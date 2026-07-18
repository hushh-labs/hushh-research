#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
#
# Local security scan mirror for docs/reference/operations/proposals/security-scanning.workflow.yml.
# Contributors run this before opening a workflow proposal PR.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

fail=0

echo "==> Python bandit (consent-protocol)"
(
  cd consent-protocol
  if command -v uv >/dev/null 2>&1; then
    uv run python -m pip install -q 'bandit[toml]' || true
    uv run bandit -r . -ll --exclude ./tests,./venv,./.venv -f txt || fail=1
  else
    pip install -q 'bandit[toml]'
    bandit -r . -ll --exclude ./tests,./venv,./.venv -f txt || fail=1
  fi
)

echo "==> Web npm audit (hushh-webapp)"
(
  cd hushh-webapp
  if [ -f package-lock.json ]; then
    npm audit --audit-level=moderate || fail=1
  else
    echo "skip: package-lock.json missing"
  fi
)

if [ "$fail" -ne 0 ]; then
  echo "Security scan reported issues (see output above)."
  exit 1
fi

echo "Security scan completed without blocking findings."
