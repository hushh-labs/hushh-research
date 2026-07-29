#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

PATTERN='RIA_FLOW_ENABLED|RIA_MCP_READ_ENABLED|NEXT_PUBLIC_RIA_FLOW_ENABLED|NEXT_PUBLIC_RIA_MCP_READ_ENABLED|_RIA_FLOW_ENABLED|_RIA_MCP_READ_ENABLED'

if grep -rE \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude=no-ria-feature-flags.sh \
  "$PATTERN" .; then
  echo "ERROR: Removed RIA feature flags were reintroduced. Use ENVIRONMENT + NEXT_PUBLIC_APP_ENV contract only."
  exit 1
fi

echo "OK: no removed RIA feature-flag keys present in repo."

