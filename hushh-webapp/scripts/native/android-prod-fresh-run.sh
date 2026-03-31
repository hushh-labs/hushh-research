#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
exec bash "$REPO_ROOT/hushh-webapp/scripts/native/run-profile.sh" --platform android --mode prod --fresh "$@"
