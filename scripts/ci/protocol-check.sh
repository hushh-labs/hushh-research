#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
PROTOCOL_DIR="$REPO_ROOT/consent-protocol"

bash "$REPO_ROOT/scripts/ci/verify-protocol-ci-parity.sh"

cd "$PROTOCOL_DIR"
bash scripts/ci/backend-check.sh

