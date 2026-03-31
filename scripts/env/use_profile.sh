#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
source "$SCRIPT_DIR/runtime_profile_lib.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/env/use_profile.sh <local-uatdb|uat-remote|prod-remote> [--dry-run]

Description:
  Activates local runtime profile files by copying:
    consent-protocol/.env.<runtime-profile>.local  -> consent-protocol/.env
    hushh-webapp/.env.<runtime-profile>.local      -> hushh-webapp/.env.local

Notes:
  - Active runtime files remain `consent-protocol/.env` and `hushh-webapp/.env.local`.
  - This command prints the exact runtime topology after activation.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "$#" -lt 1 ]; then
  usage
  exit 0
fi

RAW_PROFILE="${1:-}"
shift || true

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    *)
      echo "Unknown option: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

if ! PROFILE="$(normalize_runtime_profile "$RAW_PROFILE")"; then
  echo "Invalid profile: $RAW_PROFILE" >&2
  echo "Expected one of: local-uatdb, uat-remote, prod-remote" >&2
  exit 1
fi

BACKEND_SOURCE="$REPO_ROOT/consent-protocol/$(runtime_profile_backend_source "$PROFILE")"
FRONTEND_SOURCE="$REPO_ROOT/hushh-webapp/$(runtime_profile_frontend_source "$PROFILE")"
BACKEND_TARGET="$REPO_ROOT/consent-protocol/.env"
FRONTEND_TARGET="$REPO_ROOT/hushh-webapp/.env.local"

if [ ! -f "$BACKEND_SOURCE" ]; then
  echo "Missing backend profile file: $BACKEND_SOURCE" >&2
  echo "Create it from: ${BACKEND_SOURCE}.example or run scripts/env/bootstrap_profiles.sh" >&2
  exit 1
fi

if [ ! -f "$FRONTEND_SOURCE" ]; then
  echo "Missing frontend profile file: $FRONTEND_SOURCE" >&2
  echo "Create it from: ${FRONTEND_SOURCE}.example or run scripts/env/bootstrap_profiles.sh" >&2
  exit 1
fi

upsert_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  VALUE="$value" python3 - "$file" "$key" <<'PY'
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
value = os.environ.get("VALUE", "")
needle = f"{key}="
lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []

for index, line in enumerate(lines):
    if line.startswith(needle):
        lines[index] = f"{key}={value}"
        break
else:
    if lines and lines[-1].strip():
        lines.append("")
    lines.append(f"{key}={value}")

path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

read_env_value() {
  local file="$1"
  local key="$2"
  python3 - "$file" "$key" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
needle = f"{key}="

if not path.exists():
    print("")
    raise SystemExit(0)

for line in path.read_text(encoding="utf-8").splitlines():
    if line.startswith(needle):
        print(line.split("=", 1)[1])
        break
else:
    print("")
PY
}

normalize_env_json_values() {
  local file="$1"
  [ -f "$file" ] || return 0
  python3 - "$file" <<'PY'
import json
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
lines = path.read_text(encoding="utf-8").splitlines()
keys = {
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON",
}
assign_re = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
decoder = json.JSONDecoder()

out = []
i = 0
while i < len(lines):
    line = lines[i]
    matched = next((key for key in keys if line.startswith(f"{key}=")), None)
    if not matched:
        out.append(line)
        i += 1
        continue

    prefix = f"{matched}="
    buf = line[len(prefix):]
    j = i
    normalized = None

    while True:
        try:
            parsed, end = decoder.raw_decode(buf)
            if isinstance(parsed, dict):
                normalized = json.dumps(parsed, separators=(",", ":"))
            break
        except json.JSONDecodeError:
            j += 1
            if j >= len(lines):
                break
            buf += "\n" + lines[j]

    if normalized is None:
        out.append(line)
        i += 1
        continue

    out.append(prefix + normalized)
    i = j + 1
    while i < len(lines):
        nxt = lines[i]
        if assign_re.match(nxt) or nxt.startswith("#") or not nxt.strip():
            break
        i += 1

path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
}

SUMMARY_BACKEND_FILE="$BACKEND_SOURCE"
SUMMARY_FRONTEND_FILE="$FRONTEND_SOURCE"

if [ "$DRY_RUN" != "true" ]; then
  cp "$BACKEND_SOURCE" "$BACKEND_TARGET"
  cp "$FRONTEND_SOURCE" "$FRONTEND_TARGET"
  upsert_env_value "$BACKEND_TARGET" "APP_RUNTIME_PROFILE" "$PROFILE"
  upsert_env_value "$FRONTEND_TARGET" "APP_RUNTIME_PROFILE" "$PROFILE"
  normalize_env_json_values "$BACKEND_TARGET"
  normalize_env_json_values "$FRONTEND_TARGET"
  SUMMARY_BACKEND_FILE="$BACKEND_TARGET"
  SUMMARY_FRONTEND_FILE="$FRONTEND_TARGET"
fi

BACKEND_ENVIRONMENT="$(runtime_profile_backend_environment "$PROFILE")"
FRONTEND_ENVIRONMENT="$(runtime_profile_frontend_environment "$PROFILE")"
BACKEND_MODE="$(runtime_profile_backend_mode "$PROFILE")"
FRONTEND_MODE="$(runtime_profile_frontend_mode "$PROFILE")"
RESOURCE_TARGET="$(runtime_profile_resource_target "$PROFILE")"

SUMMARY_BACKEND_URL="$(read_env_value "${SUMMARY_BACKEND_FILE}" "FRONTEND_URL")"
SUMMARY_FRONTEND_BACKEND_URL="$(read_env_value "${SUMMARY_FRONTEND_FILE}" "NEXT_PUBLIC_BACKEND_URL")"
SUMMARY_FRONTEND_URL="$(read_env_value "${SUMMARY_FRONTEND_FILE}" "NEXT_PUBLIC_FRONTEND_URL")"

echo "Activated runtime profile: $PROFILE"
echo "Description: $(runtime_profile_description "$PROFILE")"
echo "Frontend runtime: ${FRONTEND_MODE}"
echo "Backend runtime: ${BACKEND_MODE}"
echo "Frontend backend target: ${SUMMARY_FRONTEND_BACKEND_URL:-"(unset)"}"
echo "Frontend URL: ${SUMMARY_FRONTEND_URL:-"(unset)"}"
echo "Backend allowed frontend URL: ${SUMMARY_BACKEND_URL:-"(unset)"}"
echo "Backend ENVIRONMENT: ${BACKEND_ENVIRONMENT}"
echo "Frontend NEXT_PUBLIC_APP_ENV: ${FRONTEND_ENVIRONMENT}"
echo "Resource target: ${RESOURCE_TARGET}"
echo "Backend source: $BACKEND_SOURCE"
echo "Frontend source: $FRONTEND_SOURCE"
if [ "$PROFILE" = "prod-remote" ]; then
  echo "WARNING: prod-remote points the local frontend at production services."
fi
if [ "$DRY_RUN" = "true" ]; then
  echo "Dry run: no files were copied."
fi
