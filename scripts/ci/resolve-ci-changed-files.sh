#!/usr/bin/env bash
# Reuse the existing exact review-base resolver; never invent a second diff.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
base="${CI_IMPACT_BASE_SHA:-}"
if [ -z "$base" ]; then base="$(python3 scripts/ci/resolve-ui-contract-base.py)"; fi
head="${CI_IMPACT_HEAD_SHA:-HEAD}"
if [ -z "$base" ] && [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ]; then
  if [ "$(git rev-parse --verify "${head}^{commit}")" != "${GITHUB_SHA:-}" ] ||
     [ "$(git rev-parse HEAD)" != "${GITHUB_SHA:-}" ]; then
    echo 'Manual validation requires the exact dispatched source.' >&2
    exit 2
  fi
  # Ordinary manual validation has no UI-review inheritance. Its affected
  # checks still need the same real default-branch comparison as paths-filter.
  default_branch="$(python3 - <<'PY'
import json, os
from pathlib import Path
event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
inputs = event.get('inputs') or {}
if inputs.get('uat_candidate_sha') or inputs.get('uat_candidate_tree'):
    raise SystemExit('Isolated qualification requires an explicit serving base.')
if inputs.get('scope', 'auto') != 'auto':
    raise SystemExit('Manual scoped qualification requires uat_base_sha explicitly.')
print(event.get('repository', {}).get('default_branch', ''))
PY
)"
  if [ -z "$default_branch" ] || ! git check-ref-format "refs/heads/$default_branch" >/dev/null; then
    echo 'Manual validation cannot resolve the default branch; supply uat_base_sha explicitly.' >&2
    exit 2
  fi
  base="$(git merge-base --all "refs/remotes/origin/$default_branch" "$head")" || {
    echo 'Manual validation needs comparison history; supply uat_base_sha explicitly.' >&2
    exit 2
  }
  if ! [[ "$base" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'Manual validation needs one unambiguous comparison base; supply uat_base_sha explicitly.' >&2
    exit 2
  fi
  echo "Manual validation compares the dispatched source with $base (development scope, not serving acceptance)." >&2
fi
if [ -z "$base" ]; then
  echo 'Changed-contract validation requires an explicit comparison SHA.' >&2
  exit 2
fi
git rev-parse --verify "${base}^{commit}" >/dev/null
git rev-parse --verify "${head}^{commit}" >/dev/null
file="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hushh-ci-changed-files-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
umask 077
git diff --name-only "$base" "$head" > "$file"
if [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ] && [ ! -s "$file" ]; then
  rm -f "$file"
  echo 'No changes against the comparison base; supply uat_base_sha for the changes to validate.' >&2
  exit 2
fi
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'CI_CHANGED_FILES_FILE=%s\n' "$file" >> "$GITHUB_ENV"
else
  printf '%s\n' "$file"
fi
