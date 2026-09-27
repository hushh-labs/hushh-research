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

# The manifest runs in parallel, one pytest-xdist worker per CPU. This script is
# the switch: CI (protocol-check) and the local `orchestrate.sh core` stage both
# reach it through backend-check.sh, so there is no flag to forget or to turn
# off. `--dist loadfile` keeps every test of a file on one worker, in file
# order, so module-scoped fixtures and in-file ordering behave exactly as they
# do serially; isolation ACROSS files is what parallelism tests, and
# tests/conftest.py gives each worker its own offline database for that.
#
# Measured 2026-09-26 on the full manifest (see docs/reference/operations/ci.md):
# serial vs parallel, same pass count, three clean parallel runs.
#
# The *_postgres.py files are the exception and run serially afterwards. They
# share ONE real database (ONE_COMMAND_TEST_DATABASE_URL), and although each
# test gets its own schema, Postgres catalog work is database-wide: two workers
# raced on `CREATE EXTENSION pgcrypto` (UniqueViolation on
# pg_extension_name_index, first parallel CI run), and a migration reading
# pg_constraint hit "could not open relation" while another worker dropped its
# test schema. Neither is a product defect; both are shared-database artefacts,
# so those files keep the serial run they had before.
PYTEST_PARALLEL_ARGS=(-n auto --dist loadfile)

PARALLEL_TESTS=()
POSTGRES_TESTS=()
for test_file in "${TESTS[@]}"; do
  case "$test_file" in
    *_postgres.py) POSTGRES_TESTS+=("$test_file") ;;
    *) PARALLEL_TESTS+=("$test_file") ;;
  esac
done

CI_OFFLINE_DB_DIR=""
if [ -z "${OFFLINE_DB_PATH:-}" ]; then
  CI_OFFLINE_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hushh-protocol-ci.XXXXXX")"
  OFFLINE_DB_PATH="$CI_OFFLINE_DB_DIR/protocol.db"
fi

cleanup_offline_db() {
  if [ -n "$CI_OFFLINE_DB_DIR" ] && [ -d "$CI_OFFLINE_DB_DIR" ]; then
    rm -rf "$CI_OFFLINE_DB_DIR"
  fi
}
trap cleanup_offline_db EXIT

run_pytest() {
  TESTING="${TESTING:-true}" \
  GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-hushh-ci-test}" \
  DB_OFFLINE="${DB_OFFLINE:-1}" \
  OFFLINE_DB_PATH="$OFFLINE_DB_PATH" \
  APP_SIGNING_KEY="${APP_SIGNING_KEY:-test_secret_key_for_ci_only_32chars_min}" \
  VAULT_DATA_KEY="${VAULT_DATA_KEY:-0000000000000000000000000000000000000000000000000000000000000000}" \
  HUSHH_DEVELOPER_TOKEN="${HUSHH_DEVELOPER_TOKEN:-test_hushh_developer_token_for_ci}" \
  PYTHONPATH=. \
  "$PYTHON_BIN" -m pytest -q "$@"
}

if [ "${#PARALLEL_TESTS[@]}" -gt 0 ]; then
  run_pytest "${PYTEST_PARALLEL_ARGS[@]}" "${PARALLEL_TESTS[@]}"
fi
if [ "${#POSTGRES_TESTS[@]}" -gt 0 ]; then
  echo "== Shared-database tests (serial) =="
  run_pytest "${POSTGRES_TESTS[@]}"
fi

# Every test file must at least IMPORT, listed in the manifest or not.
#
# The manifest above names the files CI runs. A file outside it can rot to the
# point of not importing and nothing notices: tests/test_consent_lifecycle_chat.py
# collected ZERO tests for days after `_BackendDirectConfirmationNeeded` was
# removed by an unrelated change, silently dropping twenty functions covering the
# spoken-yes gate on every consent mutation and the fail-closed VAULT_OWNER check.
#
# Collection is cheap -- no test bodies run -- and it is the one check that cannot
# be passed by a file nobody remembered to list. Same defect class as the DCO hook
# that was correct, tracked, and had never run.
echo "== Verifying every test file still imports =="
PYTHONPATH=. "$PYTHON_BIN" -m pytest --collect-only -q tests/ >/dev/null
