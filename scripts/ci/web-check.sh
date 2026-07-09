#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
"$REPO_ROOT/scripts/ci/web-full-check.sh"
