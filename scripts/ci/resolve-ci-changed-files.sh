#!/usr/bin/env bash
# Reuse the existing exact review-base resolver; never invent a second diff.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
base="${CI_IMPACT_BASE_SHA:-}"
if [ -z "$base" ]; then base="$(python3 scripts/ci/resolve-ui-contract-base.py)"; fi
head="${CI_IMPACT_HEAD_SHA:-HEAD}"
git rev-parse --verify "${base}^{commit}" >/dev/null
git rev-parse --verify "${head}^{commit}" >/dev/null
file="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hushh-ci-changed-files-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
umask 077
git diff --name-only "$base" "$head" > "$file"
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'CI_CHANGED_FILES_FILE=%s\n' "$file" >> "$GITHUB_ENV"
else
  printf '%s\n' "$file"
fi
