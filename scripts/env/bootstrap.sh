#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
source "$SCRIPT_DIR/runtime_profile_lib.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/env/bootstrap.sh [--mode <local|uat|prod>] [--profile <local|uat|prod>]

Description:
  Canonical contributor bootstrap for the monorepo.
  - verifies required local tools
  - installs/refreshes frontend and backend dependencies
  - hydrates the three canonical frontend runtime modes plus the local backend env
  - hydrates native secret values into the frontend profile files when available
  - activates the selected frontend profile and materializes .env.local.d
  - runs the environment doctor for the selected profile

Notes:
  - Default mode is uat so a first-time contributor can get the app
    running against deployed UAT without local backend/proxy setup.
  - If gcloud is unavailable, runtime files are created from templates and
    cached local values where possible.
  - This command does not print secrets.
USAGE
}

PROFILE="uat"
while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    --mode)
      PROFILE="${2:-}"
      shift 2
      ;;
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! PROFILE="$(normalize_runtime_profile "$PROFILE")"; then
  echo "Invalid runtime mode: ${PROFILE}" >&2
  echo "Expected one of: $(runtime_profiles_csv)" >&2
  exit 1
fi

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

check_min_version() {
  local label="$1"
  local actual="$2"
  local minimum="$3"
  python3 - "$label" "$actual" "$minimum" <<'PY'
import re
import sys

label, actual, minimum = sys.argv[1:4]

def parse(value: str) -> tuple[int, ...]:
    parts = [int(part) for part in re.findall(r"\d+", value)]
    return tuple(parts[:3]) if parts else (0,)

if parse(actual) < parse(minimum):
    print(f"{label} {actual} is too old; require >= {minimum}", file=sys.stderr)
    raise SystemExit(1)
PY
}

optional_tool_note() {
  local cmd="$1"
  local message="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "  - optional: $cmd detected"
  else
    echo "  - optional: $cmd not found (${message})"
  fi
}

warn_legacy_envs() {
  local found=0
  local path
  for path in \
    "$REPO_ROOT/consent-protocol/.env.dev.local" \
    "$REPO_ROOT/consent-protocol/.env.uat.local" \
    "$REPO_ROOT/consent-protocol/.env.prod.local" \
    "$REPO_ROOT/consent-protocol/.env.local-uatdb.local" \
    "$REPO_ROOT/consent-protocol/.env.uat-remote.local" \
    "$REPO_ROOT/consent-protocol/.env.prod-remote.local" \
    "$REPO_ROOT/hushh-webapp/.env.dev.local" \
    "$REPO_ROOT/hushh-webapp/.env.local-uatdb.local" \
    "$REPO_ROOT/hushh-webapp/.env.uat-remote.local" \
    "$REPO_ROOT/hushh-webapp/.env.prod-remote.local"
  do
    if [ -f "$path" ]; then
      if [ "$found" -eq 0 ]; then
        echo "Legacy env files detected. They are no longer part of the supported contributor path:"
        found=1
      fi
      echo "  - ${path#$REPO_ROOT/}"
    fi
  done
  if [ "$found" -eq 1 ]; then
    echo "Use only the canonical runtime modes: $(runtime_profiles_csv)"
    echo ""
  fi
}

require_cmd git
require_cmd node
require_cmd npm
require_cmd python3
require_cmd jq

NODE_VERSION="$(node -v | sed 's/^v//')"
NPM_VERSION="$(npm -v)"
PYTHON_VERSION="$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')"

check_min_version "node" "$NODE_VERSION" "20.0.0"
check_min_version "npm" "$NPM_VERSION" "10.0.0"
check_min_version "python3" "$PYTHON_VERSION" "3.13.0"

echo "== Hushh Bootstrap =="
echo "Runtime modes: $(runtime_profiles_csv)"
echo "Selected doctor mode: $PROFILE"
echo "Required prerequisites:"
echo "  - git"
echo "  - node >= 20 (found ${NODE_VERSION})"
echo "  - npm >= 10 (found ${NPM_VERSION})"
echo "  - python3 >= 3.13 (found ${PYTHON_VERSION})"
echo "  - jq"
echo "Optional but recommended:"
optional_tool_note gcloud "needed to hydrate profiles from GCP and run live parity checks"
optional_tool_note cloud-sql-proxy "needed only for local backend work"
echo ""

warn_legacy_envs

if [ -f "$REPO_ROOT/scripts/setup-hooks.sh" ]; then
  echo "Configuring monorepo hooks and consent-protocol upstream remote..."
  bash "$REPO_ROOT/scripts/setup-hooks.sh"
  echo ""
fi

echo "Installing frontend dependencies..."
(cd "$REPO_ROOT/hushh-webapp" && npm install)
echo ""

echo "Preparing backend virtual environment..."
if [ ! -d "$REPO_ROOT/consent-protocol/.venv" ]; then
  python3 -m venv "$REPO_ROOT/consent-protocol/.venv"
fi
"$REPO_ROOT/consent-protocol/.venv/bin/pip" install --disable-pip-version-check -r "$REPO_ROOT/consent-protocol/requirements.txt" -r "$REPO_ROOT/consent-protocol/requirements-dev.txt"
echo ""

echo "Hydrating canonical frontend modes and the local backend runtime..."
bash "$REPO_ROOT/scripts/env/bootstrap_profiles.sh"
echo ""

echo "Activating selected runtime mode..."
bash "$REPO_ROOT/scripts/env/use_profile.sh" "$PROFILE"
echo ""

echo "Running environment doctor..."
bash "$REPO_ROOT/scripts/env/doctor.sh" "$PROFILE"
echo ""

echo "Bootstrap complete."
echo "Next steps:"
echo "  ./bin/hushh web --mode uat"
echo "  ./bin/hushh doctor --mode local"
echo "  ./bin/hushh backend   # when you need local backend work"
