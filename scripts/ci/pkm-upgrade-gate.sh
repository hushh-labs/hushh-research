#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"
PROTOCOL_DIR="$REPO_ROOT/consent-protocol"

FRONTEND_TESTS=(
  "__tests__/services/pkm-upgrade-orchestrator.test.ts"
  "__tests__/services/pkm-prepared-blob-store.test.ts"
  "__tests__/services/pkm-write-coordinator.test.ts"
  "__tests__/services/pkm-upgrade-registry.test.ts"
  "__tests__/services/pkm-manifest-union.test.ts"
  "__tests__/services/pkm-historical-rehearsal.test.ts"
  "__tests__/services/financial-v7-reader-compatibility.test.ts"
  "__tests__/services/pkm-domain-resource.test.ts"
  "__tests__/services/cache-sync-mutation-cascade.test.ts"
  "__tests__/services/pkm-natural-language.test.ts"
  "__tests__/services/unlock-warm-orchestrator.test.ts"
  "__tests__/services/ria-onboarding-flow.test.ts"
  "__tests__/api/consent/api-service-consent.test.ts"
  "__tests__/api/consent/events-proxy.test.ts"
  "__tests__/scripts/reviewer-route-bootstrap-contract.test.ts"
  "__tests__/utils/top-shell-breadcrumbs.test.ts"
)

BACKEND_TESTS=(
  "tests/test_pkm_upgrade_routes.py"
  "tests/test_pkm_upgrade_service.py"
  "tests/test_pkm_v7_recovery_migration.py"
  "tests/test_pkm_event_operation_type_migration_contract.py"
  "tests/test_active_pkm_shape_audit.py"
  "tests/test_offline_db.py"
  "tests/services/test_account_service_cleanup_tables.py"
  "tests/services/test_account_service_export.py"
  "tests/services/test_pkm_service_store_domain_data.py"
  "tests/services/test_pkm_agent_lab_service.py"
  "tests/services/test_portfolio_import_relevance.py"
  "tests/test_scope_helpers_dynamic.py"
  "tests/test_consent_scope_upgrade.py"
  "tests/test_ria_iam_routes.py"
  "tests/test_ria_iam_service_architecture.py"
  "tests/test_kai_optimize_realtime_contract.py"
  "tests/test_kai_stream_context_gate.py"
  "tests/test_kai_stream_contract.py"
)

echo "== PKM Upgrade Gate =="
echo "Running frontend contract/orchestration suites..."
cd "$WEB_DIR"
npx vitest run "${FRONTEND_TESTS[@]}"

echo "Running backend compatibility and consent/RIA suites..."
cd "$PROTOCOL_DIR"
if [ -n "${PROTOCOL_PYTHON:-}" ] && [ -x "$PROTOCOL_PYTHON" ]; then
  PYTHON_RUNNER="$PROTOCOL_PYTHON"
elif [ -x .venv/bin/python ]; then
  PYTHON_RUNNER=".venv/bin/python"
else
  PYTHON_RUNNER="python3"
fi
TESTING="${TESTING:-true}" \
APP_SIGNING_KEY="${APP_SIGNING_KEY:-test_secret_key_for_ci_only_32chars_min}" \
VAULT_DATA_KEY="${VAULT_DATA_KEY:-0000000000000000000000000000000000000000000000000000000000000000}" \
HUSHH_DEVELOPER_TOKEN="${HUSHH_DEVELOPER_TOKEN:-test_hushh_developer_token_for_ci}" \
PYTHONPATH=. \
  "$PYTHON_RUNNER" -m pytest -q "${BACKEND_TESTS[@]}"

if [ -n "${PKM_UPGRADE_REVIEWER_SHAPE_AUDIT:-}" ]; then
  echo "PKM_UPGRADE_REVIEWER_SHAPE_AUDIT is prohibited in CI. Use the post-deploy browser BYOK rehearsal." >&2
  exit 1
fi

POSTGRES_REHEARSAL_TARGET="${PKM_UPGRADE_POSTGRES_REHEARSAL_URL:-}"
if [ -z "$POSTGRES_REHEARSAL_TARGET" ] \
  && [ -n "${PGHOST:-}" ] \
  && [ -n "${PGPORT:-}" ] \
  && [ -n "${PGDATABASE:-}" ] \
  && [ -n "${PGUSER:-}" ] \
  && [ -n "${PGPASSWORD:-}" ]; then
  POSTGRES_REHEARSAL_TARGET="postgresql://${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
fi

if [ "${PKM_UPGRADE_PROTECTED_UAT:-}" = "1" ] && [ -z "$POSTGRES_REHEARSAL_TARGET" ]; then
  echo "Protected UAT requires a PostgreSQL rehearsal connection." >&2
  exit 1
fi

if [ "${PKM_UPGRADE_PROTECTED_UAT:-}" = "1" ] && [ "${PKM_UPGRADE_STRUCTURE_AGENT_EVAL:-}" != "1" ]; then
  echo "Protected UAT requires PKM_UPGRADE_STRUCTURE_AGENT_EVAL=1." >&2
  exit 1
fi

if [ "${PKM_UPGRADE_PROTECTED_UAT:-}" = "1" ] \
  && [ -z "${PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL:-}" ] \
  && [ "${PKM_UPGRADE_RUNTIME_AUDIT_DEFERRED:-}" != "1" ]; then
  echo "Protected UAT requires a live runtime audit or an explicit postdeploy deferral." >&2
  exit 1
fi

if [ -n "$POSTGRES_REHEARSAL_TARGET" ]; then
  if ! command -v psql >/dev/null 2>&1; then
    echo "PostgreSQL rehearsal requested, but psql is unavailable." >&2
    exit 1
  fi
  echo "Running transaction-rolled-back PKM v7 PostgreSQL rehearsal..."
  psql "$POSTGRES_REHEARSAL_TARGET" \
    -v ON_ERROR_STOP=1 \
    -f "$PROTOCOL_DIR/db/verify/pkm_v7_zero_loss_rehearsal.sql"
fi

if [ "${PKM_UPGRADE_STRUCTURE_AGENT_EVAL:-}" = "1" ]; then
  EVAL_RUNS="${PKM_UPGRADE_STRUCTURE_AGENT_EVAL_RUNS:-1}"
  if [ "${PKM_UPGRADE_PROTECTED_UAT:-}" = "1" ]; then
    EVAL_RUNS=2
  fi
  if ! [[ "$EVAL_RUNS" =~ ^[1-9][0-9]*$ ]]; then
    echo "PKM_UPGRADE_STRUCTURE_AGENT_EVAL_RUNS must be a positive integer." >&2
    exit 1
  fi
  for eval_run in $(seq 1 "$EVAL_RUNS"); do
    echo "Running chained PKM structure-agent evaluation ${eval_run}/${EVAL_RUNS}..."
    EVAL_ARGS=(
      --phase fresh_chain_60
      --enforce-gates
      --json-out "/tmp/hushh-pkm-structure-agent-eval-${eval_run}.json"
    )
    if [ "${PKM_UPGRADE_PROTECTED_UAT:-}" = "1" ]; then
      # Synthetic-only: no reviewer data, manifests, or decrypted PKM values enter the model.
      EVAL_ARGS+=(--skip-shadow)
    fi
    "$PYTHON_RUNNER" scripts/eval_pkm_structure_agent.py "${EVAL_ARGS[@]}"
  done
fi

if [ -n "${PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL:-}" ]; then
  "$REPO_ROOT/scripts/ci/pkm-runtime-audit.sh"
fi

echo "✅ PKM upgrade gate passed."
