#!/usr/bin/env bash
set -euo pipefail

CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${GITHUB_ACTIONS:-false}" = "true" ]; then
  exec python3 "$CI_DIR/github_security_receipt.py"
fi
exec python3 "$CI_DIR/github_security_authority.py" --local
