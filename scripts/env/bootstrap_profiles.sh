#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
source "$SCRIPT_DIR/runtime_profile_lib.sh"

usage() {
  cat <<'USAGE'
Usage:
  scripts/env/bootstrap_profiles.sh [options]

Options:
  --region <region>                  Cloud Run region (default: us-central1)
  --backend-service <name>           Backend service name (default: consent-protocol)
  --frontend-service <name>          Frontend service name (default: hushh-webapp)
  --uat-project <project-id>         UAT project id (default: hushh-pda-uat)
  --prod-project <project-id>        Prod project id (default: hushh-pda)
  --force                            Re-copy templates before hydration
  --strict                           Exit non-zero if required cloud values are missing
  -h, --help                         Show this help

Description:
  Creates and hydrates the supported local runtime files:
    consent-protocol/.env
    hushh-webapp/.env.local.local
    hushh-webapp/.env.uat.local
    hushh-webapp/.env.prod.local

  Runtime mode model:
  - local : local frontend + local backend, backed by UAT resources
  - uat   : local frontend only, pointed at deployed UAT backend
  - prod  : local frontend only, pointed at deployed production backend

  Notes:
  - No secret values are printed.
  - Generated local profiles are chmod 600.
  - local uses a localhost-compatible backend profile and, when UAT uses
    Cloud SQL sockets, writes CLOUDSQL_INSTANCE_CONNECTION_NAME + CLOUDSQL_PROXY_PORT
    so the launcher can open a local Cloud SQL proxy automatically.
USAGE
}

REGION="${REGION:-us-central1}"
BACKEND_SERVICE="${BACKEND_SERVICE:-consent-protocol}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-hushh-webapp}"
UAT_PROJECT_ID="${UAT_PROJECT_ID:-hushh-pda-uat}"
PROD_PROJECT_ID="${PROD_PROJECT_ID:-hushh-pda}"
FORCE=false
STRICT=false
LOCAL_UATDB_PROXY_PORT="${LOCAL_UATDB_PROXY_PORT:-6543}"
GCLOUD_TIMEOUT_SECONDS="${GCLOUD_TIMEOUT_SECONDS:-5}"
LEGACY_CACHE_FIRST="${LEGACY_CACHE_FIRST:-false}"

while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --backend-service)
      BACKEND_SERVICE="${2:-}"
      shift 2
      ;;
    --frontend-service)
      FRONTEND_SERVICE="${2:-}"
      shift 2
      ;;
    --uat-project)
      UAT_PROJECT_ID="${2:-}"
      shift 2
      ;;
    --prod-project)
      PROD_PROJECT_ID="${2:-}"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --strict)
      STRICT=true
      shift
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

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

require_cmd jq
require_cmd python3

declare -a SUMMARY
declare -a WARNINGS
declare -a MISSING_REQUIRED

GCLOUD_AVAILABLE=false
GCLOUD_ACCOUNT=""
if command -v gcloud >/dev/null 2>&1; then
  if gcloud config get-value account >/tmp/hushh-bootstrap-gcloud-account.txt 2>/dev/null; then
    GCLOUD_ACCOUNT="$(tr -d '\r\n' </tmp/hushh-bootstrap-gcloud-account.txt)"
    if [ -n "$GCLOUD_ACCOUNT" ] && [ "$GCLOUD_ACCOUNT" != "(unset)" ]; then
      GCLOUD_AVAILABLE=true
    else
      WARNINGS+=("gcloud is installed but no active account/project context was available; using templates and cached profile values where possible")
    fi
  else
    WARNINGS+=("gcloud is installed but no active account/project context was available; using templates and cached profile values where possible")
  fi
else
  WARNINGS+=("gcloud is not installed; using templates and cached profile values where possible")
fi

BACKEND_DIR="$REPO_ROOT/consent-protocol"
FRONTEND_DIR="$REPO_ROOT/hushh-webapp"
CACHE_DIR="$(mktemp -d)"
trap 'rm -rf "$CACHE_DIR"' EXIT

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

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  python3 - "$timeout_seconds" "$@" <<'PY'
import subprocess
import sys

timeout_seconds = float(sys.argv[1])
cmd = sys.argv[2:]

try:
    completed = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=True,
    )
except subprocess.TimeoutExpired as exc:
    if exc.stdout:
        sys.stdout.write(exc.stdout)
    if exc.stderr:
        sys.stderr.write(exc.stderr)
    raise SystemExit(124)
except subprocess.CalledProcessError as exc:
    if exc.stdout:
        sys.stdout.write(exc.stdout)
    if exc.stderr:
        sys.stderr.write(exc.stderr)
    raise SystemExit(exc.returncode)

if completed.stdout:
    sys.stdout.write(completed.stdout)
if completed.stderr:
    sys.stderr.write(completed.stderr)
PY
}

read_env_value() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    echo ""
    return 0
  fi
  python3 - "$file" "$key" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
needle = f"{key}="

for line in path.read_text(encoding="utf-8").splitlines():
    if line.startswith(needle):
        print(line.split("=", 1)[1])
        break
else:
    print("")
PY
}

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

if path.exists():
    lines = path.read_text(encoding="utf-8").splitlines()
else:
    lines = []

for idx, line in enumerate(lines):
    if line.startswith(needle):
        lines[idx] = f"{key}={value}"
        break
else:
    if lines and lines[-1].strip():
        lines.append("")
    lines.append(f"{key}={value}")

path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

delete_env_key() {
  local file="$1"
  local key="$2"
  python3 - "$file" "$key" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
needle = f"{key}="
if not path.exists():
    raise SystemExit(0)
lines = [line for line in path.read_text(encoding="utf-8").splitlines() if not line.startswith(needle)]
path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
PY
}

copy_template_if_needed() {
  local template="$1"
  local target="$2"
  if [ ! -f "$template" ]; then
    echo "Missing template: $template" >&2
    exit 1
  fi
  if [ ! -f "$target" ] || [ "$FORCE" = "true" ]; then
    cp "$template" "$target"
    SUMMARY+=("copied template -> ${target#$REPO_ROOT/}")
  fi
}

ensure_shape_from_template() {
  local template="$1"
  local target="$2"
  python3 - "$template" "$target" <<'PY'
import pathlib
import re
import sys

template_path = pathlib.Path(sys.argv[1])
target_path = pathlib.Path(sys.argv[2])
assign_re = re.compile(r"^([A-Z0-9_]+)=")

template_lines = template_path.read_text(encoding="utf-8").splitlines()
target_lines = target_path.read_text(encoding="utf-8").splitlines() if target_path.exists() else []
target_keys = {
    match.group(1)
    for line in target_lines
    if (match := assign_re.match(line))
}

missing_lines: list[str] = []
for line in template_lines:
    match = assign_re.match(line)
    if not match:
      continue
    key = match.group(1)
    if key not in target_keys:
      missing_lines.append(line)

if not missing_lines:
    raise SystemExit(0)

if target_lines and target_lines[-1].strip():
    target_lines.append("")
target_lines.extend(missing_lines)
target_path.write_text("\n".join(target_lines) + "\n", encoding="utf-8")
PY
}

get_secret_value() {
  local project="$1"
  local secret="$2"
  local value=""
  if [ "$GCLOUD_AVAILABLE" != "true" ]; then
    return 1
  fi
  if value="$(run_with_timeout "$GCLOUD_TIMEOUT_SECONDS" gcloud secrets versions access latest --secret="$secret" --project="$project" 2>/dev/null)"; then
    value="${value%$'\n'}"
    value="${value%$'\r'}"
    printf '%s' "$value"
    return 0
  fi
  return 1
}

service_json_path() {
  local project="$1"
  local service="$2"
  local out="$CACHE_DIR/${project}_${service}.json"
  if [ ! -f "$out" ]; then
    if [ "$GCLOUD_AVAILABLE" = "true" ] && \
      run_with_timeout "$GCLOUD_TIMEOUT_SECONDS" gcloud run services describe "$service" \
        --project="$project" \
        --region="$REGION" \
        --format=json >"$out" 2>/dev/null; then
      :
    else
      echo "{}" >"$out"
      if [ "$GCLOUD_AVAILABLE" = "true" ]; then
        WARNINGS+=("cloud run describe failed for ${project}/${service}; using cached profile/template values where possible")
      fi
    fi
  fi
  echo "$out"
}

run_env_value() {
  local project="$1"
  local service="$2"
  local key="$3"
  local json_file
  json_file="$(service_json_path "$project" "$service")"
  jq -r --arg key "$key" '.spec.template.spec.containers[0].env[]? | select(.name==$key) | (.value // empty)' "$json_file" | head -n1
}

run_service_url() {
  local project="$1"
  local service="$2"
  if [ "$GCLOUD_AVAILABLE" != "true" ]; then
    return 0
  fi
  run_with_timeout "$GCLOUD_TIMEOUT_SECONDS" gcloud run services describe "$service" \
    --project="$project" \
    --region="$REGION" \
    --format='value(status.url)' 2>/dev/null || true
}

run_service_annotation() {
  local project="$1"
  local service="$2"
  local key="$3"
  local json_file
  json_file="$(service_json_path "$project" "$service")"
  jq -r --arg key "$key" '.spec.template.metadata.annotations[$key] // empty' "$json_file" | head -n1
}

set_if_non_empty() {
  local file="$1"
  local key="$2"
  local value="$3"
  if [ -n "$value" ]; then
    upsert_env_value "$file" "$key" "$value"
  fi
}

is_placeholder_value() {
  local value="${1:-}"
  case "$value" in
    "" )
      return 1
      ;;
    replace_with_*|REPLACE_WITH_*|dummy-*|changeme|CHANGEME)
      return 0
      ;;
    *replace_with_*|*REPLACE_WITH_*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

set_secret_key() {
  local file="$1"
  local profile="$2"
  local project="$3"
  local key="$4"
  local required="$5"
  local value=""
  if value="$(get_secret_value "$project" "$key")"; then
    upsert_env_value "$file" "$key" "$value"
    return 0
  fi
  if [ "$required" = "true" ]; then
    MISSING_REQUIRED+=("${profile}: missing secret ${key} in ${project}")
  else
    WARNINGS+=("${profile}: optional secret ${key} missing in ${project}")
  fi
}

resolve_cloud_or_cached_env_value() {
  local project="$1"
  local service="$2"
  local key="$3"
  local cache_file="$4"
  local value=""
  if [ "$LEGACY_CACHE_FIRST" = "true" ] && [ -f "$cache_file" ]; then
    value="$(read_env_value "$cache_file" "$key")"
    if is_placeholder_value "$value"; then
      value=""
    fi
  fi
  if [ -z "$value" ]; then
    value="$(run_env_value "$project" "$service" "$key")"
    if is_placeholder_value "$value"; then
      value=""
    fi
  fi
  if [ -z "$value" ] && [ "$LEGACY_CACHE_FIRST" != "true" ] && [ -f "$cache_file" ]; then
    value="$(read_env_value "$cache_file" "$key")"
    if is_placeholder_value "$value"; then
      value=""
    fi
  fi
  printf '%s' "$value"
}

resolve_cloud_or_cached_secret_value() {
  local project="$1"
  local secret="$2"
  local cache_file="$3"
  local value=""
  if [ "$LEGACY_CACHE_FIRST" = "true" ] && [ -f "$cache_file" ]; then
    value="$(read_env_value "$cache_file" "$secret")"
    if is_placeholder_value "$value"; then
      value=""
    fi
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  fi
  if value="$(get_secret_value "$project" "$secret")"; then
    if is_placeholder_value "$value"; then
      value=""
    fi
  fi
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi
  if [ "$LEGACY_CACHE_FIRST" != "true" ] && [ -f "$cache_file" ]; then
    value="$(read_env_value "$cache_file" "$secret")"
    if is_placeholder_value "$value"; then
      value=""
    fi
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  fi
  return 1
}

set_secret_key_or_cached() {
  local file="$1"
  local profile="$2"
  local project="$3"
  local key="$4"
  local required="$5"
  local cache_file="$6"
  local value=""
  if value="$(resolve_cloud_or_cached_secret_value "$project" "$key" "$cache_file")"; then
    upsert_env_value "$file" "$key" "$value"
    return 0
  fi
  if [ "$required" = "true" ]; then
    MISSING_REQUIRED+=("${profile}: missing secret ${key} in ${project} and no cached fallback in ${cache_file#$REPO_ROOT/}")
  else
    WARNINGS+=("${profile}: optional secret ${key} missing in ${project} and no cached fallback in ${cache_file#$REPO_ROOT/}")
  fi
}

cloudsql_instance_for_backend() {
  local project="$1"
  local annotation
  annotation="$(run_service_annotation "$project" "$BACKEND_SERVICE" 'run.googleapis.com/cloudsql-instances')"
  if [ -n "$annotation" ]; then
    printf '%s' "${annotation%%,*}"
    return 0
  fi

  local socket
  socket="$(run_env_value "$project" "$BACKEND_SERVICE" 'DB_UNIX_SOCKET')"
  if [[ "$socket" == /cloudsql/* ]]; then
    printf '%s' "${socket#/cloudsql/}"
    return 0
  fi
  return 1
}

hydrate_backend_cloud_reference() {
  local file="$1"
  local profile="$2"
  local project="$3"
  local env_name="$4"
  local cache_file="$file"

  upsert_env_value "$file" "APP_RUNTIME_MODE" "$profile"
  upsert_env_value "$file" "APP_RUNTIME_PROFILE" "$profile"
  upsert_env_value "$file" "ENVIRONMENT" "$env_name"
  upsert_env_value "$file" "RESOURCE_TARGET" "$(runtime_profile_resource_target "$profile")"
  if [ "$profile" = "local" ]; then
    upsert_env_value "$file" "DB_RESOURCE_TARGET" "uat"
  fi

  local front_secret=""
  if front_secret="$(resolve_cloud_or_cached_secret_value "$project" "FRONTEND_URL" "$cache_file")"; then
    upsert_env_value "$file" "FRONTEND_URL" "$front_secret"
  else
    MISSING_REQUIRED+=("${profile}: missing secret FRONTEND_URL in ${project}")
  fi

  for key in PORT CORS_ALLOWED_ORIGINS GOOGLE_GENAI_USE_VERTEXAI OTEL_ENABLED DB_HOST DB_PORT DB_NAME DB_UNIX_SOCKET CONSENT_SSE_ENABLED SYNC_REMOTE_ENABLED DEVELOPER_API_ENABLED OBS_DATA_STALE_RATIO_THRESHOLD; do
    set_if_non_empty "$file" "$key" "$(resolve_cloud_or_cached_env_value "$project" "$BACKEND_SERVICE" "$key" "$cache_file")"
  done

  if [ -z "$(read_env_value "$file" "CORS_ALLOWED_ORIGINS")" ] && [ -n "$front_secret" ]; then
    upsert_env_value "$file" "CORS_ALLOWED_ORIGINS" "$front_secret"
  fi

  set_secret_key_or_cached "$file" "$profile" "$project" "SECRET_KEY" "true" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "VAULT_ENCRYPTION_KEY" "true" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "GOOGLE_API_KEY" "true" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "FIREBASE_SERVICE_ACCOUNT_JSON" "true" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON" "false" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "DB_USER" "true" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "DB_PASSWORD" "true" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "APP_REVIEW_MODE" "false" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "REVIEWER_UID" "false" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "HUSHH_DEVELOPER_TOKEN" "false" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "FINNHUB_API_KEY" "false" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "PMP_API_KEY" "false" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "NEWSAPI_KEY" "false" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "PLAID_CLIENT_ID" "false" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "PLAID_SECRET" "false" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "PLAID_TOKEN_ENCRYPTION_KEY" "false" "$cache_file"

  for key in PLAID_ENV PLAID_CLIENT_NAME PLAID_COUNTRY_CODES PLAID_WEBHOOK_URL PLAID_REDIRECT_PATH PLAID_REDIRECT_URI PLAID_TX_HISTORY_DAYS; do
    set_if_non_empty "$file" "$key" "$(resolve_cloud_or_cached_env_value "$project" "$BACKEND_SERVICE" "$key" "$cache_file")"
  done

  if [ -z "$(read_env_value "$file" "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON")" ]; then
    set_if_non_empty "$file" "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON" "$(read_env_value "$file" "FIREBASE_SERVICE_ACCOUNT_JSON")"
  fi
}

hydrate_backend_local_uatdb() {
  local file="$1"
  local profile="local"
  local project="$2"
  local existing_local_plaid_webhook=""

  existing_local_plaid_webhook="$(read_env_value "$file" "PLAID_WEBHOOK_URL")"

  hydrate_backend_cloud_reference "$file" "$profile" "$project" "development"
  upsert_env_value "$file" "FRONTEND_URL" "http://localhost:3000"
  upsert_env_value "$file" "CORS_ALLOWED_ORIGINS" "http://localhost:3000"
  upsert_env_value "$file" "APP_RUNTIME_MODE" "local"
  upsert_env_value "$file" "APP_RUNTIME_PROFILE" "local"
  upsert_env_value "$file" "ENVIRONMENT" "development"
  upsert_env_value "$file" "RESOURCE_TARGET" "uat"
  upsert_env_value "$file" "DB_RESOURCE_TARGET" "uat"
  upsert_env_value "$file" "PORT" "8000"
  upsert_env_value "$file" "PLAID_WEBHOOK_URL" "$existing_local_plaid_webhook"

  local runtime_db_host runtime_db_port runtime_socket instance_name
  local cache_file="$file"
  runtime_db_host="$(resolve_cloud_or_cached_env_value "$project" "$BACKEND_SERVICE" 'DB_HOST' "$cache_file")"
  runtime_db_port="$(resolve_cloud_or_cached_env_value "$project" "$BACKEND_SERVICE" 'DB_PORT' "$cache_file")"
  runtime_socket="$(resolve_cloud_or_cached_env_value "$project" "$BACKEND_SERVICE" 'DB_UNIX_SOCKET' "$cache_file")"
  instance_name="$(cloudsql_instance_for_backend "$project" || true)"

  if [[ "$runtime_db_host" == "cloudsql-socket" || "$runtime_socket" == /cloudsql/* || -n "$instance_name" ]]; then
    upsert_env_value "$file" "DB_HOST" "127.0.0.1"
    upsert_env_value "$file" "DB_PORT" "$LOCAL_UATDB_PROXY_PORT"
    delete_env_key "$file" "DB_UNIX_SOCKET"
    if [ -n "$instance_name" ]; then
      upsert_env_value "$file" "CLOUDSQL_INSTANCE_CONNECTION_NAME" "$instance_name"
      upsert_env_value "$file" "CLOUDSQL_PROXY_PORT" "$LOCAL_UATDB_PROXY_PORT"
    else
      MISSING_REQUIRED+=("${profile}: UAT backend uses Cloud SQL socket but no instance connection name could be discovered")
    fi
  else
    set_if_non_empty "$file" "DB_HOST" "$runtime_db_host"
    if [ -n "$runtime_db_port" ]; then
      upsert_env_value "$file" "DB_PORT" "$runtime_db_port"
    fi
    delete_env_key "$file" "DB_UNIX_SOCKET"
    delete_env_key "$file" "CLOUDSQL_INSTANCE_CONNECTION_NAME"
    delete_env_key "$file" "CLOUDSQL_PROXY_PORT"
  fi
}

hydrate_frontend_cloud() {
  local file="$1"
  local profile="$2"
  local project="$3"
  local env_name="$4"
  local cache_file="$file"

  upsert_env_value "$file" "APP_RUNTIME_MODE" "$profile"
  upsert_env_value "$file" "APP_RUNTIME_PROFILE" "$profile"
  upsert_env_value "$file" "NEXT_PUBLIC_APP_ENV" "$env_name"

  local backend_url=""
  local frontend_url=""
  if backend_url="$(resolve_cloud_or_cached_secret_value "$project" "BACKEND_URL" "$cache_file")"; then
    upsert_env_value "$file" "NEXT_PUBLIC_BACKEND_URL" "$backend_url"
  else
    MISSING_REQUIRED+=("${profile}: missing secret BACKEND_URL in ${project}")
  fi

  if frontend_url="$(resolve_cloud_or_cached_secret_value "$project" "FRONTEND_URL" "$cache_file")"; then
    upsert_env_value "$file" "NEXT_PUBLIC_APP_URL" "$frontend_url"
    upsert_env_value "$file" "NEXT_PUBLIC_FRONTEND_URL" "$frontend_url"
  else
    local run_url
    run_url="$(run_service_url "$project" "$FRONTEND_SERVICE")"
    if [ -n "$run_url" ]; then
      upsert_env_value "$file" "NEXT_PUBLIC_APP_URL" "$run_url"
      upsert_env_value "$file" "NEXT_PUBLIC_FRONTEND_URL" "$run_url"
      WARNINGS+=("${profile}: FRONTEND_URL secret missing in ${project}; used Cloud Run URL")
    else
      MISSING_REQUIRED+=("${profile}: missing secret FRONTEND_URL in ${project}")
    fi
  fi

  for key in \
    NEXT_PUBLIC_FIREBASE_API_KEY NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID NEXT_PUBLIC_FIREBASE_APP_ID \
    NEXT_PUBLIC_FIREBASE_VAPID_KEY \
    NEXT_PUBLIC_AUTH_FIREBASE_API_KEY NEXT_PUBLIC_AUTH_FIREBASE_AUTH_DOMAIN NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID NEXT_PUBLIC_AUTH_FIREBASE_APP_ID
  do
    set_secret_key_or_cached "$file" "$profile" "$project" "$key" "true" "$cache_file"
  done

  set_secret_key_or_cached "$file" "$profile" "$project" "FIREBASE_SERVICE_ACCOUNT_JSON" "true" "$cache_file"
  set_secret_key_or_cached "$file" "$profile" "$project" "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON" "false" "$cache_file"
  if [ -z "$(read_env_value "$file" "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON")" ]; then
    set_if_non_empty "$file" "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON" "$(read_env_value "$file" "FIREBASE_SERVICE_ACCOUNT_JSON")"
  fi

  for key in \
    NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_UAT NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_PRODUCTION \
    NEXT_PUBLIC_GTM_ID_UAT NEXT_PUBLIC_GTM_ID_STAGING NEXT_PUBLIC_GTM_ID_PRODUCTION \
    NEXT_PUBLIC_OBSERVABILITY_ENABLED NEXT_PUBLIC_OBSERVABILITY_DEBUG NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE
  do
    set_secret_key_or_cached "$file" "$profile" "$project" "$key" "false" "$cache_file"
  done

  for key in \
    IOS_GOOGLESERVICE_INFO_PLIST_B64 ANDROID_GOOGLE_SERVICES_JSON_B64 \
    APPLE_TEAM_ID IOS_DEV_CERT_P12_B64 IOS_DEV_CERT_PASSWORD IOS_DEV_PROFILE_B64 \
    IOS_DIST_CERT_P12_B64 IOS_DIST_CERT_PASSWORD IOS_APPSTORE_PROFILE_B64 \
    APPSTORE_CONNECT_API_KEY_P8_B64 APPSTORE_CONNECT_KEY_ID APPSTORE_CONNECT_ISSUER_ID \
    ANDROID_RELEASE_KEYSTORE_B64 ANDROID_RELEASE_KEYSTORE_PASSWORD ANDROID_RELEASE_KEY_ALIAS ANDROID_RELEASE_KEY_PASSWORD
  do
    set_secret_key_or_cached "$file" "$profile" "$project" "$key" "false" "$cache_file"
  done

  if [ -z "$(read_env_value "$file" "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_UAT")" ]; then
    set_if_non_empty "$file" "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_UAT" "$(read_env_value "$file" "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING")"
  fi
  if [ -z "$(read_env_value "$file" "NEXT_PUBLIC_GTM_ID_UAT")" ]; then
    set_if_non_empty "$file" "NEXT_PUBLIC_GTM_ID_UAT" "$(read_env_value "$file" "NEXT_PUBLIC_GTM_ID_STAGING")"
  fi
}

hydrate_frontend_local_uatdb() {
  local file="$1"
  local project="$2"
  local profile="local"

  hydrate_frontend_cloud "$file" "$profile" "$project" "development"
  upsert_env_value "$file" "NEXT_PUBLIC_BACKEND_URL" "http://localhost:8000"
  upsert_env_value "$file" "NEXT_PUBLIC_APP_URL" "http://localhost:3000"
  upsert_env_value "$file" "NEXT_PUBLIC_FRONTEND_URL" "http://localhost:3000"
  upsert_env_value "$file" "NEXT_PUBLIC_APP_ENV" "development"
  upsert_env_value "$file" "APP_RUNTIME_MODE" "local"
  upsert_env_value "$file" "APP_RUNTIME_PROFILE" "local"
}

validate_canonical_keys() {
  local profile="$1"
  local backend_file="$2"
  local frontend_file="$3"
  local expected_backend="$4"
  local expected_frontend="$5"

  local backend_env frontend_env
  backend_env="$(read_env_value "$backend_file" "ENVIRONMENT")"
  frontend_env="$(read_env_value "$frontend_file" "NEXT_PUBLIC_APP_ENV")"

  if [ -z "$backend_env" ]; then
    MISSING_REQUIRED+=("${profile}: missing ENVIRONMENT in ${backend_file#$REPO_ROOT/}")
  elif [ "$backend_env" != "$expected_backend" ]; then
    WARNINGS+=("${profile}: ENVIRONMENT expected ${expected_backend} but found ${backend_env}")
  fi

  if [ -z "$frontend_env" ]; then
    MISSING_REQUIRED+=("${profile}: missing NEXT_PUBLIC_APP_ENV in ${frontend_file#$REPO_ROOT/}")
  elif [ "$frontend_env" != "$expected_frontend" ]; then
    WARNINGS+=("${profile}: NEXT_PUBLIC_APP_ENV expected ${expected_frontend} but found ${frontend_env}")
  fi
}

profiles=(local uat prod)

copy_template_if_needed "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
for profile in "${profiles[@]}"; do
  copy_template_if_needed "$FRONTEND_DIR/$(runtime_profile_frontend_source "$profile").example" "$FRONTEND_DIR/$(runtime_profile_frontend_source "$profile")"
done

hydrate_backend_local_uatdb "$BACKEND_DIR/.env" "$UAT_PROJECT_ID"
hydrate_frontend_local_uatdb "$FRONTEND_DIR/.env.local.local" "$UAT_PROJECT_ID"
hydrate_frontend_cloud "$FRONTEND_DIR/.env.uat.local" "uat" "$UAT_PROJECT_ID" "uat"
hydrate_frontend_cloud "$FRONTEND_DIR/.env.prod.local" "prod" "$PROD_PROJECT_ID" "production"

ensure_shape_from_template "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
for profile in "${profiles[@]}"; do
  ensure_shape_from_template "$FRONTEND_DIR/$(runtime_profile_frontend_source "$profile").example" "$FRONTEND_DIR/$(runtime_profile_frontend_source "$profile")"
done

chmod 600 "$BACKEND_DIR/.env"
for profile in "${profiles[@]}"; do
  chmod 600 "$FRONTEND_DIR/$(runtime_profile_frontend_source "$profile")"
done

for path in \
  "$BACKEND_DIR/.env" \
  "$FRONTEND_DIR/.env.local.local" "$FRONTEND_DIR/.env.uat.local" "$FRONTEND_DIR/.env.prod.local" \
  "$BACKEND_DIR/.env.dev.local" "$BACKEND_DIR/.env.uat.local" "$BACKEND_DIR/.env.prod.local" \
  "$FRONTEND_DIR/.env.dev.local" "$FRONTEND_DIR/.env.uat.local" "$FRONTEND_DIR/.env.prod.local"
do
  normalize_env_json_values "$path"
done

validate_canonical_keys "local" \
  "$BACKEND_DIR/.env" \
  "$FRONTEND_DIR/.env.local.local" \
  "development" \
  "development"

validate_canonical_keys "uat" \
  "$BACKEND_DIR/.env" \
  "$FRONTEND_DIR/.env.uat.local" \
  "development" \
  "uat"

validate_canonical_keys "prod" \
  "$BACKEND_DIR/.env" \
  "$FRONTEND_DIR/.env.prod.local" \
  "development" \
  "production"

for path in \
  "$BACKEND_DIR/.env" \
  "$FRONTEND_DIR/.env.local.local" "$FRONTEND_DIR/.env.uat.local" "$FRONTEND_DIR/.env.prod.local"
do
  key_count="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$path" | wc -l | tr -d ' ')"
  SUMMARY+=("hydrated ${path#$REPO_ROOT/} (${key_count} keys)")
done

echo "Bootstrap runtime mode summary:"
for item in "${SUMMARY[@]}"; do
  echo "- $item"
done

if [ "${#WARNINGS[@]}" -gt 0 ]; then
  echo ""
  echo "Warnings:"
  for warning in "${WARNINGS[@]}"; do
    echo "- $warning"
  done
fi

if [ "${#MISSING_REQUIRED[@]}" -gt 0 ]; then
  echo ""
  echo "Missing required values:"
  for missing in "${MISSING_REQUIRED[@]}"; do
    echo "- $missing"
  done
  if [ "$STRICT" = "true" ]; then
    exit 1
  fi
fi

echo ""
if [ "$GCLOUD_AVAILABLE" = "true" ]; then
  echo "Hydrated from gcloud account: ${GCLOUD_ACCOUNT:-"(unknown)"}"
else
  echo "Hydration source: templates and cached local profile files only"
fi

if [ -f "$REPO_ROOT/scripts/ops/verify-runtime-profile-env-shape.py" ]; then
  python3 "$REPO_ROOT/scripts/ops/verify-runtime-profile-env-shape.py" --include-runtime
fi
echo ""
echo "Done. Use a runtime mode with:"
echo "  bash scripts/env/use_profile.sh local|uat|prod"
