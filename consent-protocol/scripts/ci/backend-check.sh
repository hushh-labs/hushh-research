#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

set -euo pipefail

if ! command -v uv >/dev/null 2>&1; then
  echo "❌ uv is required for backend checks."
  exit 1
fi

uv sync --frozen --group dev
bash scripts/sync_runtime_requirements.sh --check

uv run ruff check .
uv run mypy --config-file pyproject.toml --ignore-missing-imports
uv run bandit -r hushh_mcp/ api/ -c pyproject.toml -ll

if [ -f scripts/run-test-ci.sh ]; then
  bash scripts/run-test-ci.sh
else
  echo "❌ scripts/run-test-ci.sh not found."
  exit 1
fi
