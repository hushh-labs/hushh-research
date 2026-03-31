#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "${SCRIPT_DIR}/../../.." rev-parse --show-toplevel)"
WEB_DIR="${REPO_ROOT}/hushh-webapp"
PROFILE="${APP_RUNTIME_MODE:-${APP_RUNTIME_PROFILE:-uat}}"

echo "bootstrap-mobile-secrets.sh is now a compatibility shim." >&2
bash "${REPO_ROOT}/scripts/env/bootstrap_profiles.sh"
bash "${REPO_ROOT}/scripts/env/use_profile.sh" "${PROFILE}"
echo "Active frontend profile now carries the mobile Firebase values and .env.local.d is materialized." >&2
