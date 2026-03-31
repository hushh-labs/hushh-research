#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")/../.." rev-parse --show-toplevel)"
cd "$REPO_ROOT/hushh-webapp"
exec npm run dev -- "$@"
