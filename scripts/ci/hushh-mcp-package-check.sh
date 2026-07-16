#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
PACKAGE_DIR="$REPO_ROOT/packages/hushh-mcp"
PROTOCOL_PYTHON="$REPO_ROOT/consent-protocol/.venv/bin/python"

if [ -x "$PROTOCOL_PYTHON" ]; then
  export HUSHH_MCP_PYTHON="$PROTOCOL_PYTHON"
fi

cd "$PACKAGE_DIR"
npm ci
npm run verify:package
