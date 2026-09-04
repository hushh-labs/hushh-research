#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"

bash "$REPO_ROOT/scripts/ci/no-ria-feature-flags.sh"
bash "$REPO_ROOT/scripts/ci/runtime-contract-check.sh"
cd "$WEB_DIR"

npm --version

# The integration lane only owns cross-surface checks.
# Frontend typecheck/test/build stay in the dedicated Web job.
if [ ! -d node_modules/vitest ] || [ ! -x node_modules/.bin/vitest ]; then
  npm ci --prefer-offline --no-audit --progress=false
fi

cd "$REPO_ROOT"

# Expensive zero-loss rehearsal belongs only to PKM upgrade compatibility
# changes. GitHub workflows resolve this through the canonical changed-SHA
# selector before invoking this script. A local caller without a proven plan
# fails closed to the full gate rather than silently skipping it.
run_pkm_upgrade_gate="${CI_RUN_PKM_UPGRADE_GATE:-}"
plan_reason="${CI_VERIFICATION_PLAN_REASON:-}"
if [ -z "$run_pkm_upgrade_gate" ]; then
  plan_file="${CI_VERIFICATION_PLAN_FILE:-/tmp/hushh-ci-verification-plan.json}"
  python3 "$REPO_ROOT/scripts/ci/resolve-uat-verification-plan.py" \
    --target-sha "${CI_IMPACT_TARGET_SHA:-HEAD}" \
    --base-sha "${CI_IMPACT_BASE_SHA:-}" \
    --json-output "$plan_file" >/dev/null
  read -r run_pkm_upgrade_gate plan_reason < <(
    python3 - "$plan_file" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
print(str(bool(payload["run_pkm_upgrade_gate"])).lower(), payload["reason"])
PY
  )
fi

if [ "$run_pkm_upgrade_gate" = "true" ]; then
  echo "Running PKM upgrade gate (${plan_reason:-required})."
  bash "$REPO_ROOT/scripts/ci/pkm-upgrade-gate.sh"
else
  echo "Skipping PKM upgrade gate (${plan_reason:-no_pkm_upgrade_contract_changed})."
fi
