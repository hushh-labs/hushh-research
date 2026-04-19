#!/usr/bin/env bash
set -euo pipefail

MANIFEST_PATH="${1:-scripts/test-ci.manifest.txt}"

PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  if [ -x .venv/bin/python ]; then
    PYTHON_BIN=".venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  else
    PYTHON_BIN="python"
  fi
fi

if [ ! -f "$MANIFEST_PATH" ]; then
  echo "Missing backend CI test manifest: $MANIFEST_PATH" >&2
  exit 1
fi

TESTS=()
while IFS= read -r test_file; do
  TESTS+=("$test_file")
done <<EOF
$(grep -vE '^[[:space:]]*(#|$)' "$MANIFEST_PATH")
EOF

if [ "${#TESTS[@]}" -eq 0 ]; then
  echo "Backend CI test manifest is empty: $MANIFEST_PATH" >&2
  exit 1
fi

missing=0
for test_file in "${TESTS[@]}"; do
  if [ ! -f "$test_file" ]; then
    echo "Missing backend CI test file referenced in manifest: $test_file" >&2
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  exit 1
fi

TESTING="${TESTING:-true}" \
APP_SIGNING_KEY="${APP_SIGNING_KEY:-test_secret_key_for_ci_only_32chars_min}" \
VAULT_DATA_KEY="${VAULT_DATA_KEY:-0000000000000000000000000000000000000000000000000000000000000000}" \
HUSHH_DEVELOPER_TOKEN="${HUSHH_DEVELOPER_TOKEN:-test_hushh_developer_token_for_ci}" \
PYTHONPATH=. \
"$PYTHON_BIN" -m pytest -q "${TESTS[@]}"
