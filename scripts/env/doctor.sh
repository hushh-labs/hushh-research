#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
source "$SCRIPT_DIR/runtime_profile_lib.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/env/doctor.sh <local|uat|prod> [--json]

Description:
  Verify that a runtime mode is coherent and runnable.
  Reports:
  - profile identity
  - backend/frontend source and active files
  - effective backend/frontend targets
  - missing tools/secrets/placeholders
  - hosted/local drift risks
USAGE
}

if [ "$#" -lt 1 ]; then
  usage
  exit 1
fi

RAW_PROFILE="${1:-}"
shift || true
JSON_OUTPUT=false
for arg in "$@"; do
  case "$arg" in
    --json)
      JSON_OUTPUT=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

if ! PROFILE="$(normalize_runtime_profile "$RAW_PROFILE")"; then
  echo "Invalid runtime mode: $RAW_PROFILE" >&2
  echo "Expected one of: $(runtime_profiles_csv)" >&2
  exit 1
fi

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

is_placeholder() {
  local value="${1:-}"
  case "$value" in
    ""|replace_with_*|__SET_*|__FIREBASE_*|*"<"*">"*|*dummy-project*|*api.example.com*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

REPORT_FILE="$(mktemp)"
trap 'rm -f "$REPORT_FILE"' EXIT

add_check() {
  local key="$1"
  local status="$2"
  local detail="$3"
  printf '%s|%s|%s\n' "$key" "$status" "$detail" >>"$REPORT_FILE"
}

EXPECTED_BACKEND_ENV="$(runtime_profile_backend_environment "$PROFILE")"
EXPECTED_FRONTEND_ENV="$(runtime_profile_frontend_environment "$PROFILE")"
EXPECTED_BACKEND_MODE="local"
EXPECTED_FRONTEND_MODE="$(runtime_profile_frontend_mode "$PROFILE")"

BACKEND_SOURCE="$REPO_ROOT/consent-protocol/.env"
FRONTEND_SOURCE="$REPO_ROOT/hushh-webapp/$(runtime_profile_frontend_source "$PROFILE")"
BACKEND_ACTIVE="$REPO_ROOT/consent-protocol/.env"
FRONTEND_ACTIVE="$REPO_ROOT/hushh-webapp/.env.local"

RUNNABLE=true

if [ -f "$BACKEND_SOURCE" ]; then
  add_check "backend_source_file" "pass" "${BACKEND_SOURCE#$REPO_ROOT/}"
else
  if [ "$PROFILE" = "local" ]; then
    add_check "backend_source_file" "fail" "Missing ${BACKEND_SOURCE#$REPO_ROOT/}"
    RUNNABLE=false
  else
    add_check "backend_source_file" "warn" "Missing ${BACKEND_SOURCE#$REPO_ROOT/}; local backend is not required for $PROFILE"
  fi
fi

if [ -f "$FRONTEND_SOURCE" ]; then
  add_check "frontend_source_file" "pass" "${FRONTEND_SOURCE#$REPO_ROOT/}"
else
  add_check "frontend_source_file" "fail" "Missing ${FRONTEND_SOURCE#$REPO_ROOT/}"
  RUNNABLE=false
fi

BACKEND_SOURCE_ENV="$(read_env_value "$BACKEND_SOURCE" "ENVIRONMENT")"
FRONTEND_SOURCE_ENV="$(read_env_value "$FRONTEND_SOURCE" "NEXT_PUBLIC_APP_ENV")"
BACKEND_SOURCE_PROFILE="$(read_env_value "$BACKEND_SOURCE" "APP_RUNTIME_MODE")"
if [ -z "$BACKEND_SOURCE_PROFILE" ]; then
  BACKEND_SOURCE_PROFILE="$(read_env_value "$BACKEND_SOURCE" "APP_RUNTIME_PROFILE")"
fi
FRONTEND_SOURCE_PROFILE="$(read_env_value "$FRONTEND_SOURCE" "APP_RUNTIME_MODE")"
if [ -z "$FRONTEND_SOURCE_PROFILE" ]; then
  FRONTEND_SOURCE_PROFILE="$(read_env_value "$FRONTEND_SOURCE" "APP_RUNTIME_PROFILE")"
fi
FRONTEND_BACKEND_TARGET="$(read_env_value "$FRONTEND_SOURCE" "NEXT_PUBLIC_BACKEND_URL")"
FRONTEND_FRONTEND_TARGET="$(read_env_value "$FRONTEND_SOURCE" "NEXT_PUBLIC_FRONTEND_URL")"
BACKEND_FRONTEND_TARGET="$(read_env_value "$BACKEND_SOURCE" "FRONTEND_URL")"
BACKEND_DB_HOST="$(read_env_value "$BACKEND_SOURCE" "DB_HOST")"
BACKEND_CLOUDSQL_INSTANCE="$(read_env_value "$BACKEND_SOURCE" "CLOUDSQL_INSTANCE_CONNECTION_NAME")"
BACKEND_FIREBASE_JSON="$(read_env_value "$BACKEND_SOURCE" "FIREBASE_SERVICE_ACCOUNT_JSON")"

if [ "$BACKEND_SOURCE_PROFILE" = "local" ]; then
  add_check "backend_source_profile" "pass" "backend local runtime mode preserved"
else
  if [ "$PROFILE" = "local" ]; then
    add_check "backend_source_profile" "fail" "Expected backend runtime mode local but found ${BACKEND_SOURCE_PROFILE:-"(unset)"}"
    RUNNABLE=false
  else
    add_check "backend_source_profile" "warn" "Backend local runtime mode is ${BACKEND_SOURCE_PROFILE:-"(unset)"}; $PROFILE only requires the frontend target"
  fi
fi

if [ "$FRONTEND_SOURCE_PROFILE" = "$PROFILE" ]; then
  add_check "frontend_source_profile" "pass" "APP_RUNTIME_PROFILE=$FRONTEND_SOURCE_PROFILE"
else
  add_check "frontend_source_profile" "fail" "Expected APP_RUNTIME_PROFILE=$PROFILE but found ${FRONTEND_SOURCE_PROFILE:-"(unset)"}"
  RUNNABLE=false
fi

EXPECTED_BACKEND_SOURCE_ENV="development"
if [ "$BACKEND_SOURCE_ENV" = "$EXPECTED_BACKEND_SOURCE_ENV" ]; then
  add_check "backend_environment" "pass" "ENVIRONMENT=$BACKEND_SOURCE_ENV"
else
  if [ "$PROFILE" = "local" ]; then
    add_check "backend_environment" "fail" "Expected ENVIRONMENT=$EXPECTED_BACKEND_SOURCE_ENV but found ${BACKEND_SOURCE_ENV:-"(unset)"}"
    RUNNABLE=false
  else
    add_check "backend_environment" "warn" "Backend local ENVIRONMENT is ${BACKEND_SOURCE_ENV:-"(unset)"}; $PROFILE only requires the frontend target"
  fi
fi

if [ "$FRONTEND_SOURCE_ENV" = "$EXPECTED_FRONTEND_ENV" ]; then
  add_check "frontend_environment" "pass" "NEXT_PUBLIC_APP_ENV=$FRONTEND_SOURCE_ENV"
else
  add_check "frontend_environment" "fail" "Expected NEXT_PUBLIC_APP_ENV=$EXPECTED_FRONTEND_ENV but found ${FRONTEND_SOURCE_ENV:-"(unset)"}"
  RUNNABLE=false
fi

ACTIVE_BACKEND_MODE="$(read_env_value "$BACKEND_ACTIVE" "APP_RUNTIME_MODE")"
if [ -z "$ACTIVE_BACKEND_MODE" ]; then
  ACTIVE_BACKEND_MODE="$(read_env_value "$BACKEND_ACTIVE" "APP_RUNTIME_PROFILE")"
fi
if [ -f "$BACKEND_ACTIVE" ] && [ "$ACTIVE_BACKEND_MODE" = "local" ]; then
  add_check "backend_active_file" "pass" "${BACKEND_ACTIVE#$REPO_ROOT/} is ready for the local backend contract"
else
  if [ "$PROFILE" = "local" ]; then
    add_check "backend_active_file" "fail" "Active backend file is not ready for local runtime. Run: bash scripts/env/bootstrap_profiles.sh"
    RUNNABLE=false
  else
    add_check "backend_active_file" "warn" "Active backend file is not configured for the local backend contract. This does not block $PROFILE frontend simulation."
  fi
fi

ACTIVE_FRONTEND_MODE="$(read_env_value "$FRONTEND_ACTIVE" "APP_RUNTIME_MODE")"
if [ -z "$ACTIVE_FRONTEND_MODE" ]; then
  ACTIVE_FRONTEND_MODE="$(read_env_value "$FRONTEND_ACTIVE" "APP_RUNTIME_PROFILE")"
fi
if [ -f "$FRONTEND_ACTIVE" ] && [ "$ACTIVE_FRONTEND_MODE" = "$PROFILE" ]; then
  add_check "frontend_active_file" "pass" "${FRONTEND_ACTIVE#$REPO_ROOT/} currently matches $PROFILE"
else
  add_check "frontend_active_file" "warn" "Active frontend file is not using $PROFILE. Run: bash scripts/env/use_profile.sh $PROFILE"
fi

if [ -n "$FRONTEND_BACKEND_TARGET" ] && ! is_placeholder "$FRONTEND_BACKEND_TARGET"; then
  add_check "effective_backend_target" "pass" "$FRONTEND_BACKEND_TARGET"
else
  add_check "effective_backend_target" "fail" "NEXT_PUBLIC_BACKEND_URL is missing or still a template placeholder"
  RUNNABLE=false
fi

if [ -n "$FRONTEND_FRONTEND_TARGET" ] && ! is_placeholder "$FRONTEND_FRONTEND_TARGET"; then
  add_check "effective_frontend_target" "pass" "$FRONTEND_FRONTEND_TARGET"
else
  add_check "effective_frontend_target" "fail" "NEXT_PUBLIC_FRONTEND_URL is missing or still a template placeholder"
  RUNNABLE=false
fi

if [ -n "$BACKEND_FRONTEND_TARGET" ] && ! is_placeholder "$BACKEND_FRONTEND_TARGET"; then
  add_check "backend_frontend_allowlist" "pass" "$BACKEND_FRONTEND_TARGET"
else
  add_check "backend_frontend_allowlist" "fail" "FRONTEND_URL is missing or still a template placeholder"
  RUNNABLE=false
fi

case "$PROFILE" in
  local)
    if [[ "$FRONTEND_BACKEND_TARGET" == http://localhost:* || "$FRONTEND_BACKEND_TARGET" == http://127.0.0.1:* ]]; then
      add_check "backend_target_shape" "pass" "local profile points at local backend"
    else
      add_check "backend_target_shape" "fail" "local must point NEXT_PUBLIC_BACKEND_URL at localhost/127.0.0.1"
      RUNNABLE=false
    fi
    if [ -n "$BACKEND_CLOUDSQL_INSTANCE" ] || [[ "$BACKEND_DB_HOST" == "127.0.0.1" || "$BACKEND_DB_HOST" == "localhost" ]]; then
      if command -v cloud-sql-proxy >/dev/null 2>&1; then
        add_check "cloudsql_proxy_binary" "pass" "cloud-sql-proxy is installed"
      else
        add_check "cloudsql_proxy_binary" "fail" "cloud-sql-proxy is required for local when DB_HOST is local"
        RUNNABLE=false
      fi

      if [ -n "$BACKEND_FIREBASE_JSON" ] && ! is_placeholder "$BACKEND_FIREBASE_JSON"; then
        add_check "cloudsql_proxy_credentials" "pass" "FIREBASE_SERVICE_ACCOUNT_JSON is present for proxy auth"
      else
        add_check "cloudsql_proxy_credentials" "fail" "FIREBASE_SERVICE_ACCOUNT_JSON is missing or still a template placeholder"
        RUNNABLE=false
      fi
    else
      add_check "cloudsql_proxy_binary" "warn" "local is not configured for local DB proxying"
    fi
    ;;
  uat)
    if [[ "$FRONTEND_BACKEND_TARGET" == http://localhost:* || "$FRONTEND_BACKEND_TARGET" == http://127.0.0.1:* ]]; then
      add_check "backend_target_shape" "fail" "uat must not point at localhost"
      RUNNABLE=false
    else
      add_check "backend_target_shape" "pass" "uat points at a remote backend"
    fi
    ;;
  prod)
    if [[ "$FRONTEND_BACKEND_TARGET" == http://localhost:* || "$FRONTEND_BACKEND_TARGET" == http://127.0.0.1:* ]]; then
      add_check "backend_target_shape" "fail" "prod must not point at localhost"
      RUNNABLE=false
    else
      add_check "backend_target_shape" "pass" "prod points at a remote backend"
    fi
    ;;
esac

LEGACY_ENV_FOUND=0
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
    LEGACY_ENV_FOUND=1
  fi
done

if [ "$LEGACY_ENV_FOUND" -eq 1 ]; then
  add_check "legacy_env_files" "warn" "Legacy runtime env files still exist locally"
else
  add_check "legacy_env_files" "pass" "Only canonical runtime-mode files are present"
fi

STATUS_TEXT="runnable"
if [ "$RUNNABLE" != "true" ]; then
  STATUS_TEXT="blocked"
fi

if [ "$JSON_OUTPUT" = "true" ]; then
  python3 - "$PROFILE" "$STATUS_TEXT" "$EXPECTED_BACKEND_MODE" "$EXPECTED_FRONTEND_MODE" "$REPORT_FILE" <<'PY'
import json
import pathlib
import sys

profile, status_text, backend_mode, frontend_mode, report_path = sys.argv[1:]
checks = []
for line in pathlib.Path(report_path).read_text(encoding="utf-8").splitlines():
    key, status, detail = line.split("|", 2)
    checks.append({"key": key, "status": status, "detail": detail})

payload = {
    "profile": profile,
    "status": status_text,
    "backend_mode": backend_mode,
    "frontend_mode": frontend_mode,
    "checks": checks,
}
print(json.dumps(payload, indent=2))
PY
  exit 0
fi

echo "Runtime mode doctor: $PROFILE"
echo "Description: $(runtime_profile_description "$PROFILE")"
echo "Backend mode: $EXPECTED_BACKEND_MODE"
echo "Frontend mode: $EXPECTED_FRONTEND_MODE"
echo "Status: $STATUS_TEXT"
echo ""

while IFS='|' read -r key status detail; do
  case "$status" in
    pass) icon="PASS" ;;
    warn) icon="WARN" ;;
    fail) icon="FAIL" ;;
    *) icon="$status" ;;
  esac
  printf '  %-28s %-5s %s\n' "$key" "$icon" "$detail"
done <"$REPORT_FILE"

if [ "$RUNNABLE" != "true" ]; then
  exit 1
fi
