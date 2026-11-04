#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

set -euo pipefail

if ! command -v uv >/dev/null 2>&1; then
  echo "❌ uv is required for backend checks."
  exit 1
fi

uv sync --frozen --group dev
source "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/ci/validation-results.sh"
validation_check "Runtime dependency export" bash scripts/sync_runtime_requirements.sh --check
validation_check "Capability graph" uv run python scripts/generate_capability_graph.py --check
validation_check "PLG observations" uv run python scripts/generate_plg_observation_contract.py --check
validation_check "Capability schemas" uv run python scripts/generate_capability_run_schema_contracts.py --check
validation_check "Location schemas" uv run python scripts/generate_location_onboarding_runtime_schema_contracts.py --check
validation_check "Scope commerce schemas" uv run python scripts/generate_scope_commerce_schema_contracts.py --check
validation_check "Emoji contract" uv run python scripts/generate_emoji_reactions.py --check
validation_check "Voice instruction budget" uv run python ../scripts/one_voice_instruction_budget.py --check
validation_check "Location action catalog" node ../hushh-webapp/scripts/voice/generate-one-location-workflow-card-catalog.mjs --check

validation_check "Python lint" uv run ruff check .
validation_check "Python types" uv run mypy --config-file pyproject.toml --ignore-missing-imports
validation_check "Python security" uv run bandit -r hushh_mcp/ api/ server.py mcp_server.py mcp_remote.py server_a2a.py -c pyproject.toml -ll

if [ -f scripts/run-test-ci.sh ]; then
  validation_check "Backend tests" bash scripts/run-test-ci.sh
else
  echo "❌ scripts/run-test-ci.sh not found."
  exit 1
fi
validation_finish
