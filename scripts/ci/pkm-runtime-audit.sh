#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"
BASE_URL="${PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL:-}"

if [ -z "$BASE_URL" ]; then
  echo "PKM runtime audit requires PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL." >&2
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

echo "Running live PKM, investor, and RIA runtime audits..."
load_reviewer_runtime_secrets
cd "$WEB_DIR"
for route_filter in one/pkm one/kai ria; do
  HUSHH_APP_ORIGIN="$BASE_URL" \
  HUSHH_VIEWPORT_FILTER=phone \
  HUSHH_ROUTE_FILTER="$route_filter" \
    node ./scripts/testing/verify-signed-in-routes.mjs
done
