#!/usr/bin/env bash
set -euo pipefail

# web-full = web-core (design system, docs, typecheck, lint, build) followed by
# web-full-suite (the whole Vitest suite and the contract verifiers). PR
# Validation runs the two halves as parallel lanes; this script runs them in
# sequence for `orchestrate.sh all` and any caller that wants the whole stage.

REPO_ROOT="$(git rev-parse --show-toplevel)"

"$REPO_ROOT/scripts/ci/web-core-check.sh"
# web-core just ran npm ci; npm's completion marker lets the suite skip a second one.
WEB_CI_DEPS_INSTALLED=1 "$REPO_ROOT/scripts/ci/web-full-suite-check.sh"
