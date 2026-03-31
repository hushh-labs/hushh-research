#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS signing bootstrap is only supported on macOS." >&2
  exit 1
fi

REPO_ROOT="$(git -C "${SCRIPT_DIR}/../../.." rev-parse --show-toplevel)"
PROFILE="${APP_RUNTIME_MODE:-${APP_RUNTIME_PROFILE:-uat}}"

echo "bootstrap-ios-signing.sh is now a compatibility shim." >&2
bash "${REPO_ROOT}/scripts/env/bootstrap_profiles.sh"
bash "${REPO_ROOT}/scripts/env/use_profile.sh" "${PROFILE}"
bash "${SCRIPT_DIR}/ensure-ios-signing.sh"
