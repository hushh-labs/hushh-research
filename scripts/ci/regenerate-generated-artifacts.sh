#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

# Regenerate every committed generated artifact that CI checks for staleness, or
# with --check, report every stale one in a single run. Use it before pushing
# instead of discovering each stale file in a separate PR Validation wave.
#
#   scripts/ci/regenerate-generated-artifacts.sh           # rewrite them
#   scripts/ci/regenerate-generated-artifacts.sh --check   # fail if any is stale
#
# Order matters when writing: the cache-coherence manifest reads the surface map
# that build:ui-contracts writes, and the runtime topology index reads both.

set -euo pipefail

mode=write
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python
for tool in "$PYTHON" node npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "regenerate-generated-artifacts: '$tool' is required." >&2; exit 127; }
done
if [[ ! -d hushh-webapp/node_modules ]]; then
  echo "regenerate-generated-artifacts: run npm ci in hushh-webapp first." >&2
  exit 1
fi

SCHEMA_GENERATORS=(
  consent-protocol/scripts/generate_capability_run_schema_contracts.py
  consent-protocol/scripts/generate_location_onboarding_runtime_schema_contracts.py
  consent-protocol/scripts/generate_scope_commerce_schema_contracts.py
)
# Python writes CRLF on Windows; the repository stores these files with LF.
PYTHON_OUTPUTS=(
  consent-protocol/db/contracts/*_schema.json
  contracts/architecture/runtime-topology-index.v1.json
)

stale=()
verify() {
  local label=$1 status=0
  shift
  "$@" || status=$?
  ((status == 0)) || stale+=("$label")
}

if [[ "$mode" == check ]]; then
  for generator in "${SCHEMA_GENERATORS[@]}"; do
    verify "consent-protocol/db/contracts/*_schema.json ($(basename "$generator"))" "$PYTHON" "$generator" --check
  done
  verify "hushh-webapp/contracts/ui-review receipts (back, search)" \
    bash -c 'cd hushh-webapp && node scripts/architecture/verify-ui-contracts.mjs'
  verify "hushh-webapp/cache-coherence-screen-manifest.generated.json" \
    bash -c 'cd hushh-webapp && node scripts/architecture/audit-cache-coherence.mjs --check'
  verify "contracts/architecture/runtime-topology-index.v1.json" \
    "$PYTHON" scripts/ops/generate_runtime_topology_index.py --check
  if ((${#stale[@]})); then
    echo >&2
    echo "${#stale[@]} generated artifact check(s) failed:" >&2
    printf '  %s\n' "${stale[@]}" >&2
    echo "Run scripts/ci/regenerate-generated-artifacts.sh, review the diff and commit it." >&2
    exit 1
  fi
  echo "Every checked generated artifact is current."
  exit 0
fi

for generator in "${SCHEMA_GENERATORS[@]}"; do
  "$PYTHON" "$generator"
done
(cd hushh-webapp && npm run build:ui-contracts)
(cd hushh-webapp && node scripts/architecture/audit-cache-coherence.mjs)
"$PYTHON" scripts/ops/generate_runtime_topology_index.py
"$PYTHON" - "${PYTHON_OUTPUTS[@]}" <<'PY'
import sys
from pathlib import Path

for name in sys.argv[1:]:
    path = Path(name)
    data = path.read_bytes()
    if b"\r\n" in data:
        path.write_bytes(data.replace(b"\r\n", b"\n"))
PY
echo
echo "Regenerated. Review and commit the changes:"
git status --short -- consent-protocol/db/contracts contracts/architecture hushh-webapp
