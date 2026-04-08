#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

node scripts/verify-doc-runtime-parity.cjs
node scripts/verify-doc-links.cjs
node scripts/verify-doc-governance.cjs
