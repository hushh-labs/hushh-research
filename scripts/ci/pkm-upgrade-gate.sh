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

if [ "${PKM_UPGRADE_PROTECTED_UAT:-}" = "1" ] && [ "${PKM_UPGRADE_REVIEWER_SHAPE_AUDIT:-}" != "1" ]; then
  echo "Protected UAT requires PKM_UPGRADE_REVIEWER_SHAPE_AUDIT=1." >&2
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

if [ "${PKM_UPGRADE_PROTECTED_UAT:-}" = "1" ] && [ -z "${PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL:-}" ]; then
  echo "Protected UAT requires PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL." >&2
  exit 1
fi

load_reviewer_runtime_secrets() {
  if [ -n "${REVIEWER_UID:-}" ] && [ -n "${REVIEWER_VAULT_PASSPHRASE:-}" ]; then
    return 0
  fi

  local secret_project="${PKM_UPGRADE_REVIEWER_SECRET_PROJECT:-}"
  local secret_version="${PKM_UPGRADE_REVIEWER_SECRET_VERSION:-latest}"
  if [ -z "$secret_project" ]; then
    echo "Live reviewer runtime audits require reviewer credentials or PKM_UPGRADE_REVIEWER_SECRET_PROJECT." >&2
    return 1
  fi
  if ! command -v gcloud >/dev/null 2>&1; then
    echo "Live reviewer runtime audits require gcloud for Secret Manager resolution." >&2
    return 1
  fi

  if [ -z "${REVIEWER_UID:-}" ]; then
    REVIEWER_UID="$(gcloud secrets versions access "$secret_version" \
      --secret=REVIEWER_UID \
      --project="$secret_project")"
  fi
  if [ -z "${REVIEWER_VAULT_PASSPHRASE:-}" ]; then
    REVIEWER_VAULT_PASSPHRASE="$(gcloud secrets versions access "$secret_version" \
      --secret=REVIEWER_VAULT_PASSPHRASE \
      --project="$secret_project")"
  fi
  if [ -z "$REVIEWER_UID" ] || [ -z "$REVIEWER_VAULT_PASSPHRASE" ]; then
    echo "Live reviewer runtime audits could not resolve the canonical reviewer identity." >&2
    return 1
  fi
  export REVIEWER_UID REVIEWER_VAULT_PASSPHRASE
}

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

if [ "${PKM_UPGRADE_REVIEWER_SHAPE_AUDIT:-}" = "1" ]; then
  echo "Running reviewer-backed active PKM shape audit..."
  SHAPE_AUDIT_ARGS=(--env-file "${PKM_UPGRADE_REVIEWER_ENV_FILE:-.env}")
  if [ -n "${PKM_UPGRADE_REVIEWER_SECRET_PROJECT:-}" ]; then
    SHAPE_AUDIT_ARGS+=(--gcp-secret-project "$PKM_UPGRADE_REVIEWER_SECRET_PROJECT")
  fi
  if [ -n "${PKM_UPGRADE_REVIEWER_SECRET_VERSION:-}" ]; then
    SHAPE_AUDIT_ARGS+=(--gcp-secret-version "$PKM_UPGRADE_REVIEWER_SECRET_VERSION")
  fi
  "$PYTHON_RUNNER" scripts/audit_active_pkm_shape_readonly.py "${SHAPE_AUDIT_ARGS[@]}" >/tmp/hushh-pkm-shape-audit.json
  "$PYTHON_RUNNER" -c 'import json; p=json.load(open("/tmp/hushh-pkm-shape-audit.json")); assert p["schema_version"] == "pkm_reviewer_shape_audit.v2"; assert p["pagination"]["has_more"] is False; assert p["preservation_receipt"]["complete"] is True; assert p["preservation_receipt"]["rejected"] == 0'
  echo "Reviewer-backed active PKM shape audit passed with redacted output."
fi

if [ "${PKM_UPGRADE_STRUCTURE_AGENT_EVAL:-}" = "1" ]; then
  echo "Running chained PKM structure-agent evaluation..."
  "$PYTHON_RUNNER" scripts/eval_pkm_structure_agent.py \
    --phase fresh_chain_60 \
    --enforce-gates \
    --json-out /tmp/hushh-pkm-structure-agent-eval.json
fi

if [ -n "${PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL:-}" ]; then
  echo "Running live PKM, investor, and RIA runtime audits..."
  load_reviewer_runtime_secrets
  cd "$WEB_DIR"
  for route_filter in one/pkm one/kai ria; do
    HUSHH_APP_ORIGIN="$PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL" \
    HUSHH_VIEWPORT_FILTER=phone \
    HUSHH_ROUTE_FILTER="$route_filter" \
      node ./scripts/testing/verify-signed-in-routes.mjs
  done
fi

echo "✅ PKM upgrade gate passed."
