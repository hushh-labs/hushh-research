#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"
PROTOCOL_DIR="$REPO_ROOT/consent-protocol"

FRONTEND_TESTS=(
  "__tests__/services/pkm-upgrade-orchestrator.test.ts"
  "__tests__/services/pkm-prepared-blob-store.test.ts"
  "__tests__/services/pkm-write-coordinator.test.ts"
  "__tests__/services/pkm-natural-language.test.ts"
  "__tests__/services/unlock-warm-orchestrator.test.ts"
  "__tests__/services/ria-onboarding-flow.test.ts"
  "__tests__/api/consent/api-service-consent.test.ts"
  "__tests__/api/consent/events-proxy.test.ts"
  "__tests__/utils/top-shell-breadcrumbs.test.ts"
)

BACKEND_TESTS=(
  "tests/test_pkm_upgrade_routes.py"
  "tests/test_pkm_upgrade_service.py"
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
if [ -x .venv/bin/pytest ]; then
  PYTEST_RUNNER=".venv/bin/pytest"
else
  PYTEST_RUNNER="python3 -m pytest"
fi
TESTING="${TESTING:-true}" \
SECRET_KEY="${SECRET_KEY:-test_secret_key_for_ci_only_32chars_min}" \
VAULT_ENCRYPTION_KEY="${VAULT_ENCRYPTION_KEY:-0000000000000000000000000000000000000000000000000000000000000000}" \
HUSHH_DEVELOPER_TOKEN="${HUSHH_DEVELOPER_TOKEN:-test_hushh_developer_token_for_ci}" \
PYTHONPATH=. \
  $PYTEST_RUNNER -q "${BACKEND_TESTS[@]}"

echo "✅ PKM upgrade gate passed."
