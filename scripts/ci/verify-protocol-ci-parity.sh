#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
MONO_WORKFLOW="$REPO_ROOT/.github/workflows/ci.yml"
UPSTREAM_WORKFLOW="$REPO_ROOT/consent-protocol/.github/workflows/ci.yml"
MONO_PROTOCOL_SCRIPT="$REPO_ROOT/scripts/ci/protocol-check.sh"
BACKEND_CHECK_SCRIPT="$REPO_ROOT/consent-protocol/scripts/ci/backend-check.sh"

FAILURES=0

ok() {
  echo "OK: $1"
}

error() {
  echo "ERROR: $1"
  FAILURES=$((FAILURES + 1))
}

require_file() {
  local path="$1"
  if [ -f "$path" ]; then
    ok "Found file: ${path#$REPO_ROOT/}"
  else
    error "Missing file: ${path#$REPO_ROOT/}"
  fi
}

require_contains() {
  local needle="$1"
  local haystack="$2"
  local label="$3"
  if grep -Fq "$needle" <<< "$haystack"; then
    ok "$label"
  else
    error "$label"
  fi
}

require_contains_any() {
  local haystack="$1"
  local label="$2"
  shift 2
  local found=0
  for needle in "$@"; do
    if grep -Fq "$needle" <<< "$haystack"; then
      found=1
      break
    fi
  done
  if [ "$found" -eq 1 ]; then
    ok "$label"
  else
    error "$label"
  fi
}

extract_block() {
  local file="$1"
  local start_regex="$2"
  local end_regex="$3"
  awk -v start_regex="$start_regex" -v end_regex="$end_regex" '
    $0 ~ start_regex { in_block = 1 }
    in_block { print }
    in_block && $0 ~ end_regex { exit }
  ' "$file"
}

if [[ "${1:-}" == "--self-test" ]]; then
  # grep -q may close a pipe early. Under pipefail, a large printf writer then
  # exits with SIGPIPE and turns a valid match into a false parity failure.
  printf -v padding '%262144s' ' '
  fixture=$'TESTING: true\n'"${padding}"
  require_contains 'TESTING:' "$fixture" 'large matching workflow block'
  require_contains_any "$fixture" 'large alternative matching block' 'missing:' 'TESTING:'
  [[ "$FAILURES" == 0 ]] || exit 1
  require_contains 'ABSENT:' "$fixture" 'expected missing literal rejection'
  require_contains_any "$fixture" 'expected missing alternatives rejection' 'ABSENT:' 'ALSO_ABSENT:'
  [[ "$FAILURES" == 2 ]] || exit 1
  echo 'Protocol CI parity transport regression passed.'
  exit 0
fi

require_file "$MONO_WORKFLOW"
require_file "$UPSTREAM_WORKFLOW"
require_file "$MONO_PROTOCOL_SCRIPT"
require_file "$BACKEND_CHECK_SCRIPT"

MONO_PROTOCOL_BLOCK="$(extract_block "$MONO_WORKFLOW" '^  protocol-check:' '^  integration-check:')"
UPSTREAM_BACKEND_BLOCK="$(extract_block "$UPSTREAM_WORKFLOW" '^  backend-check:' '^  ci-status:')"

require_contains "bash scripts/ci/backend-check.sh" "$(cat "$MONO_PROTOCOL_SCRIPT")" \
  "Monorepo protocol-check script delegates to consent-protocol/scripts/ci/backend-check.sh"
require_contains_any "$MONO_PROTOCOL_BLOCK" \
  "Monorepo protocol-check workflow job runs shared protocol stage script" \
  "run: bash scripts/ci/protocol-check.sh" \
  "run: bash scripts/ci/orchestrate.sh protocol"
require_contains "run: bash scripts/ci/backend-check.sh" "$UPSTREAM_BACKEND_BLOCK" \
  "Upstream backend-check workflow job runs shared backend-check script"

for env_key in TESTING APP_SIGNING_KEY VAULT_DATA_KEY HUSHH_DEVELOPER_TOKEN; do
  require_contains "${env_key}:" "$MONO_PROTOCOL_BLOCK" \
    "Monorepo protocol-check exports ${env_key}"
  require_contains "${env_key}:" "$UPSTREAM_BACKEND_BLOCK" \
    "Upstream backend-check exports ${env_key}"
done

if grep -Eq 'PROTOCOL_VERIFY_DOCKER|docker|buildx' <<< "$MONO_PROTOCOL_BLOCK"; then
  error "Monorepo protocol-check includes docker-specific checks (should be backend-check parity only)"
else
  ok "Monorepo protocol-check has no docker-specific checks"
fi

if grep -Eq 'docker|buildx' <<< "$UPSTREAM_BACKEND_BLOCK"; then
  error "Upstream backend-check includes docker-specific checks (should be backend-check parity only)"
else
  ok "Upstream backend-check has no docker-specific checks"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo "Protocol CI parity verification FAILED (${FAILURES} issue(s))."
  exit 1
fi

echo ""
echo "Protocol CI parity verification passed."
