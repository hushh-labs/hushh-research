#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
started=$SECONDS
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/hushh-account-deletion.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT

echo '== Account deletion: client completion, proxy outcomes and atomic SQL erasure =='
(
  cd "$REPO_ROOT/hushh-webapp"
  ./node_modules/.bin/vitest run \
    __tests__/lib/flows/delete-account.test.ts \
    __tests__/app/api/account-delete-proxy.test.ts \
    __tests__/lib/firebase/auth-context-session-invalidation.test.tsx \
    __tests__/lib/profile-action-outcomes.test.ts \
    __tests__/one-voice/account-lifecycle-step.test.ts --maxWorkers=2
)
(
  cd "$REPO_ROOT/consent-protocol"
  TESTING=true DB_OFFLINE=1 OFFLINE_DB_PATH="$test_dir/protocol.db" \
  GOOGLE_CLOUD_PROJECT=hushh-ci-test REQUIRE_ACCOUNT_DELETION_POSTGRES=1 \
  .venv/bin/python -m pytest -q \
    tests/test_account_delete_error_detail.py \
    tests/services/test_account_erasure_covers_every_user_table.py \
    tests/services/test_account_deletion_provider_cleanup.py \
    tests/test_account_erasure_lock_timeout_postgres.py
)
echo "Account deletion gate passed in $((SECONDS - started))s."
