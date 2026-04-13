#!/usr/bin/env bash
set -euo pipefail

PYTHON_BIN=""
if [ -x .venv/bin/python ]; then
  PYTHON_BIN=".venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "❌ python3 (or python) is required for backend checks."
  exit 1
fi

"$PYTHON_BIN" -m pip install --upgrade pip
"$PYTHON_BIN" -m pip install -r requirements.txt
"$PYTHON_BIN" -m pip install -r requirements-dev.txt

"$PYTHON_BIN" -m ruff check .
"$PYTHON_BIN" -m mypy --config-file pyproject.toml --ignore-missing-imports
"$PYTHON_BIN" -m bandit -r hushh_mcp/ api/ -c pyproject.toml -ll

if [ -f scripts/run-test-ci.sh ]; then
  bash scripts/run-test-ci.sh
else
  echo "❌ scripts/run-test-ci.sh not found."
  exit 1
fi
