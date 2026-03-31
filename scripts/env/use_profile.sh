#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
source "$SCRIPT_DIR/runtime_profile_lib.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/env/use_profile.sh <local|uat|prod> [--dry-run]

Description:
  Activates the selected frontend runtime mode by copying:
    hushh-webapp/<mode-source-file> -> hushh-webapp/.env.local

Notes:
  - Backend local runtime stays in `consent-protocol/.env`.
  - Frontend active runtime stays in `hushh-webapp/.env.local`.
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
  echo "Expected one of: local, uat, prod" >&2
  exit 1
fi

FRONTEND_SOURCE="$REPO_ROOT/hushh-webapp/$(runtime_profile_frontend_source "$PROFILE")"
BACKEND_TARGET="$REPO_ROOT/consent-protocol/.env"
FRONTEND_TARGET="$REPO_ROOT/hushh-webapp/.env.local"
NATIVE_MATERIALIZER="$REPO_ROOT/hushh-webapp/scripts/native/materialize-active-native-profile.sh"

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

is_placeholder_value() {
  local value="${1:-}"
  case "$value" in
    ""|replace_with_*|REPLACE_WITH_*|dummy-*|changeme|CHANGEME|*replace_with_*|*REPLACE_WITH_*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
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

gcp_project_for_profile() {
  case "$1" in
    local|uat)
      printf 'hushh-pda-uat'
      ;;
    prod)
      printf 'hushh-pda'
      ;;
    *)
      return 1
      ;;
  esac
}

legacy_frontend_sources_for_profile() {
  case "$1" in
    local)
      printf '%s\n%s\n' \
        "$REPO_ROOT/hushh-webapp/.env.local-uatdb.local" \
        "$REPO_ROOT/hushh-webapp/.env.uat.local" \
        "$REPO_ROOT/hushh-webapp/.env.dev.local"
      ;;
    uat)
      printf '%s\n%s\n' \
        "$REPO_ROOT/hushh-webapp/.env.uat-remote.local" \
        "$REPO_ROOT/hushh-webapp/.env.uat.local" \
        "$REPO_ROOT/hushh-webapp/.env.dev.local"
      ;;
    prod)
      printf '%s\n%s\n' \
        "$REPO_ROOT/hushh-webapp/.env.prod-remote.local" \
        "$REPO_ROOT/hushh-webapp/.env.prod.local"
      ;;
  esac
}

resolve_frontend_secret_value() {
  local profile="$1"
  local key="$2"
  local value=""
  local project=""
  project="$(gcp_project_for_profile "$profile" || true)"

  if command -v gcloud >/dev/null 2>&1 && [ -n "$project" ]; then
    value="$(gcloud secrets versions access latest --secret="$key" --project="$project" 2>/dev/null || true)"
    value="${value%$'\n'}"
    value="${value%$'\r'}"
    if is_placeholder_value "$value"; then
      value=""
    fi
  fi

  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  while IFS= read -r legacy_file; do
    [ -n "$legacy_file" ] || continue
    [ -f "$legacy_file" ] || continue
    value="$(read_env_value "$legacy_file" "$key")"
    if is_placeholder_value "$value"; then
      value=""
    fi
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done < <(legacy_frontend_sources_for_profile "$profile")

  return 1
}

repair_frontend_profile_if_needed() {
  local file="$1"
  local profile="$2"
  local key value needs_repair=false
  local -a keys=(
    NEXT_PUBLIC_FIREBASE_API_KEY
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
    NEXT_PUBLIC_FIREBASE_PROJECT_ID
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
    NEXT_PUBLIC_FIREBASE_APP_ID
    NEXT_PUBLIC_AUTH_FIREBASE_API_KEY
    NEXT_PUBLIC_AUTH_FIREBASE_AUTH_DOMAIN
    NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID
    NEXT_PUBLIC_AUTH_FIREBASE_APP_ID
  )

  for key in "${keys[@]}"; do
    value="$(read_env_value "$file" "$key")"
    if is_placeholder_value "$value"; then
      needs_repair=true
      break
    fi
  done

  if [ "$needs_repair" != "true" ]; then
    return 0
  fi

  echo "Repairing placeholder Firebase config in ${file#$REPO_ROOT/} for profile ${profile}..."
  for key in "${keys[@]}"; do
    if value="$(resolve_frontend_secret_value "$profile" "$key")"; then
      upsert_env_value "$file" "$key" "$value"
    fi
  done
}

require_non_placeholder_value() {
  local file="$1"
  local key="$2"
  local value
  value="$(read_env_value "$file" "$key")"
  case "$value" in
    ""|replace_with_*|REPLACE_WITH_*|dummy-*|changeme|CHANGEME|*replace_with_*|*REPLACE_WITH_*)
      echo "Invalid runtime mode value for ${key} in ${file#$REPO_ROOT/}. Run scripts/env/bootstrap_profiles.sh to hydrate real values." >&2
      exit 1
      ;;
  esac
}

SUMMARY_BACKEND_FILE="$BACKEND_TARGET"
SUMMARY_FRONTEND_FILE="$FRONTEND_SOURCE"

repair_frontend_profile_if_needed "$FRONTEND_SOURCE" "$PROFILE"

if [ "$DRY_RUN" != "true" ]; then
  cp "$FRONTEND_SOURCE" "$FRONTEND_TARGET"
  if [ ! -f "$BACKEND_TARGET" ]; then
    echo "Missing backend local runtime file: ${BACKEND_TARGET#$REPO_ROOT/}" >&2
    echo "Run scripts/env/bootstrap_profiles.sh to hydrate the local backend env." >&2
    exit 1
  fi
  upsert_env_value "$BACKEND_TARGET" "APP_RUNTIME_MODE" "local"
  upsert_env_value "$BACKEND_TARGET" "APP_RUNTIME_PROFILE" "local"
  upsert_env_value "$BACKEND_TARGET" "RESOURCE_TARGET" "uat"
  upsert_env_value "$BACKEND_TARGET" "DB_RESOURCE_TARGET" "uat"
  upsert_env_value "$FRONTEND_TARGET" "APP_RUNTIME_MODE" "$PROFILE"
  upsert_env_value "$FRONTEND_TARGET" "APP_RUNTIME_PROFILE" "$PROFILE"
  normalize_env_json_values "$FRONTEND_TARGET"
  require_non_placeholder_value "$FRONTEND_TARGET" "NEXT_PUBLIC_FIREBASE_API_KEY"
  require_non_placeholder_value "$FRONTEND_TARGET" "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"
  require_non_placeholder_value "$FRONTEND_TARGET" "NEXT_PUBLIC_AUTH_FIREBASE_API_KEY"
  require_non_placeholder_value "$FRONTEND_TARGET" "NEXT_PUBLIC_AUTH_FIREBASE_AUTH_DOMAIN"
  if [ -x "$NATIVE_MATERIALIZER" ]; then
    ACTIVE_ENV_FILE="$FRONTEND_TARGET" PROFILE_ENV_FILE="$FRONTEND_SOURCE" bash "$NATIVE_MATERIALIZER"
  fi
  SUMMARY_BACKEND_FILE="$BACKEND_TARGET"
  SUMMARY_FRONTEND_FILE="$FRONTEND_TARGET"
fi

BACKEND_ENVIRONMENT="development"
FRONTEND_ENVIRONMENT="$(runtime_profile_frontend_environment "$PROFILE")"
BACKEND_MODE="local"
FRONTEND_MODE="$(runtime_profile_frontend_mode "$PROFILE")"
RESOURCE_TARGET="$(runtime_profile_resource_target "$PROFILE")"

SUMMARY_BACKEND_URL="$(read_env_value "${SUMMARY_BACKEND_FILE}" "FRONTEND_URL")"
SUMMARY_FRONTEND_BACKEND_URL="$(read_env_value "${SUMMARY_FRONTEND_FILE}" "NEXT_PUBLIC_BACKEND_URL")"
SUMMARY_FRONTEND_URL="$(read_env_value "${SUMMARY_FRONTEND_FILE}" "NEXT_PUBLIC_FRONTEND_URL")"

echo "Activated runtime mode: $PROFILE"
echo "Description: $(runtime_profile_description "$PROFILE")"
echo "Frontend runtime: ${FRONTEND_MODE}"
echo "Backend runtime: ${BACKEND_MODE}"
echo "Frontend backend target: ${SUMMARY_FRONTEND_BACKEND_URL:-"(unset)"}"
echo "Frontend URL: ${SUMMARY_FRONTEND_URL:-"(unset)"}"
echo "Backend allowed frontend URL: ${SUMMARY_BACKEND_URL:-"(unset)"}"
echo "Backend ENVIRONMENT: ${BACKEND_ENVIRONMENT}"
echo "Frontend NEXT_PUBLIC_APP_ENV: ${FRONTEND_ENVIRONMENT}"
echo "Resource target: ${RESOURCE_TARGET}"
echo "Frontend source: $FRONTEND_SOURCE"
echo "Backend runtime file: $BACKEND_TARGET"
if [ "$PROFILE" = "prod" ]; then
  echo "WARNING: prod points the local frontend at production services."
fi
if [ "$DRY_RUN" = "true" ]; then
  echo "Dry run: no files were copied."
fi
