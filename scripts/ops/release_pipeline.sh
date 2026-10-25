#!/usr/bin/env bash
# Compatibility alias. Verification, mutation, recovery and acceptance have one
# authority: the existing main-owned GitHub deployment workflow.
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
exec bash "$REPO_ROOT/scripts/ops/cloudbuild_release.sh" "$@"
