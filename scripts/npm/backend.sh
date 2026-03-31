#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")/../.." rev-parse --show-toplevel)"
exec bash "$REPO_ROOT/scripts/runtime/run_backend_local.sh" local "$@"
