#!/usr/bin/env bash
set -euo pipefail

CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${GITHUB_ACTIONS:-false}" = "true" ]; then
  echo "Repository alert clearance is enforced by Deployment Security before release mutation."
  exit 0
fi
exec python3 "$CI_DIR/github_security_authority.py" --local
