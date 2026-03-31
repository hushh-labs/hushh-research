#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: scripts/npm/native.sh <ios|android> [run-profile args...]" >&2
  exit 1
fi

PLATFORM="$1"
shift

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")/../.." rev-parse --show-toplevel)"
exec bash "$REPO_ROOT/hushh-webapp/scripts/native/run-profile.sh" --platform "$PLATFORM" "$@"
