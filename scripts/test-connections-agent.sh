#!/usr/bin/env bash
#
# test-connections-agent.sh
# ------------------------------------------------------------------------------
# Verifies the "connections" Agent One specialist (tool-loop parity feature):
#   send / list / find / accept / reject / remove, all with confirm-before-write.
#
# The feature is BACKEND (consent-protocol, Python). This script runs the backend
# test suites that exercise it end-to-end (LLM tool-loop with a scripted fake
# model, the A2A wrapper contract, the intent classifier, and the manifest guard).
#
# Usage:
#   ./scripts/test-connections-agent.sh            # full connections feature suite
#   ./scripts/test-connections-agent.sh -k confirm # filter by keyword
#   ./scripts/test-connections-agent.sh -v         # pass extra args to pytest
# ------------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CP="${REPO_ROOT}/consent-protocol"
PY="${CP}/.venv/bin/python"

if [[ ! -x "${PY}" ]]; then
  echo "ERROR: venv python not found at ${PY}" >&2
  echo "Create/activate the consent-protocol venv first." >&2
  exit 1
fi

# Test files that cover the connections specialist feature.
TESTS=(
  "tests/services/test_connections_chat_service.py"   # tool-loop: reads, propose_* confirm prompts, disambiguation, _complete_action writes
  "tests/test_connections_a2a.py"                     # A2A wrapper: clientPrompt->directive, delegate_result->selection_result
  "tests/test_connections_classifier.py"             # intent routing: natural phrasings -> agent_connections
  "tests/services/test_connections_manifest_sync.py" # agent.yaml tool names == runtime dispatch keys
  "tests/services/test_connections_service.py"        # underlying data-layer service (create/accept/reject/remove/list)
  "tests/routes/test_connections_route.py"            # REST routes
)

echo "==> Repo:  ${REPO_ROOT}"
echo "==> Python: ${PY}"
echo "==> Running connections Agent One feature suite..."
echo

cd "${CP}"
# Pass any extra args straight through to pytest (e.g. -k, -v, -x).
"${PY}" -m pytest "${TESTS[@]}" "$@"

echo
echo "==> Confirm-before-write focused view (writes only on the confirmation turn):"
"${PY}" -m pytest tests/services/test_connections_chat_service.py \
  -k "propose or complete_action or roundtrip or person_choice" -v
