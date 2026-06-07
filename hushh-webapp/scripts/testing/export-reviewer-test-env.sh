#!/bin/zsh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
eval "$(node "$ROOT/scripts/testing/export-reviewer-test-env.mjs")"
