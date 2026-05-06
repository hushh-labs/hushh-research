#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

usage() {
  cat <<'EOF'
Usage:
  scripts/ops/verify_runtime_db_contract.sh \
    --project <gcp-project> \
    --region <region> \
    --service <cloud-run-service> \
    --contract-file <path> \
    [--report-path <path>] \
    [--proxy-port <port>]

Description:
  Resolves DB runtime settings from Cloud Run + Secret Manager, then runs the
  read-only DB migration guard against the selected contract file.
EOF
}

PROJECT=""
REGION="us-central1"
SERVICE="consent-protocol"
CONTRACT_FILE=""
REPORT_PATH=""
PROXY_PORT="${DB_PROXY_PORT:-6543}"

while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    --project)
      PROJECT="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --service)
      SERVICE="${2:-}"
      shift 2
      ;;
    --contract-file)
      CONTRACT_FILE="${2:-}"
      shift 2
      ;;
    --report-path)
      REPORT_PATH="${2:-}"
      shift 2
      ;;
    --proxy-port)
      PROXY_PORT="${2:-}"
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

[ -n "$PROJECT" ] || { echo "--project is required" >&2; exit 1; }
[ -n "$CONTRACT_FILE" ] || { echo "--contract-file is required" >&2; exit 1; }

command -v gcloud >/dev/null 2>&1 || { echo "gcloud is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }

if [ -z "$REPORT_PATH" ]; then
  REPORT_PATH="$(mktemp "${TMPDIR:-/tmp}/runtime-db-contract.XXXXXX")"
fi

SERVICE_JSON="$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --format=json)"

runtime_env_value() {
  local name="$1"
  local value secret version
  value="$(printf '%s' "$SERVICE_JSON" | jq -r --arg name "$name" '.spec.template.spec.containers[0].env[]? | select(.name==$name) | .value // empty' | tail -n 1)"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  secret="$(printf '%s' "$SERVICE_JSON" | jq -r --arg name "$name" '.spec.template.spec.containers[0].env[]? | select(.name==$name) | .valueFrom.secretKeyRef.name // empty' | tail -n 1)"
  if [ -n "$secret" ]; then
    version="$(printf '%s' "$SERVICE_JSON" | jq -r --arg name "$name" '.spec.template.spec.containers[0].env[]? | select(.name==$name) | .valueFrom.secretKeyRef.key // "latest"' | tail -n 1)"
    gcloud secrets versions access "$version" --secret="$secret" --project="$PROJECT"
    return 0
  fi
}

secret_value_if_exists() {
  local name="$1"
  if gcloud secrets describe "$name" --project="$PROJECT" >/dev/null 2>&1; then
    gcloud secrets versions access latest --secret="$name" --project="$PROJECT"
  fi
}

DB_HOST="$(runtime_env_value DB_HOST)"
DB_PORT="$(runtime_env_value DB_PORT)"
DB_NAME="$(runtime_env_value DB_NAME)"
DB_UNIX_SOCKET="$(runtime_env_value DB_UNIX_SOCKET)"

DB_HOST="${DB_HOST:-$(secret_value_if_exists DB_HOST)}"
DB_PORT="${DB_PORT:-$(secret_value_if_exists DB_PORT)}"
DB_NAME="${DB_NAME:-$(secret_value_if_exists DB_NAME)}"
DB_UNIX_SOCKET="${DB_UNIX_SOCKET:-$(secret_value_if_exists DB_UNIX_SOCKET)}"

DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-postgres}"

DB_USER="$(gcloud secrets versions access latest --secret=DB_USER --project="$PROJECT")"
DB_PASSWORD="$(gcloud secrets versions access latest --secret=DB_PASSWORD --project="$PROJECT")"
echo "::add-mask::${DB_USER}" >/dev/null 2>&1 || true
echo "::add-mask::${DB_PASSWORD}" >/dev/null 2>&1 || true

PROXY_PID=""
cleanup() {
  if [ -n "$PROXY_PID" ] && kill -0 "$PROXY_PID" >/dev/null 2>&1; then
    kill "$PROXY_PID" >/dev/null 2>&1 || true
    wait "$PROXY_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ -n "$DB_UNIX_SOCKET" ] || [ "$DB_HOST" = "cloudsql-socket" ]; then
  command -v cloud-sql-proxy >/dev/null 2>&1 || {
    echo "cloud-sql-proxy is required when runtime DB uses Cloud SQL sockets." >&2
    exit 1
  }

  INSTANCE_CONNECTION_NAME="${DB_UNIX_SOCKET#/cloudsql/}"
  [ -n "$INSTANCE_CONNECTION_NAME" ] || {
    echo "Could not infer Cloud SQL instance connection name from DB_UNIX_SOCKET." >&2
    exit 1
  }

  cloud-sql-proxy "$INSTANCE_CONNECTION_NAME" --port "$PROXY_PORT" >/tmp/cloud-sql-proxy.log 2>&1 &
  PROXY_PID="$!"

  python3 - "$PROXY_PORT" <<'PY'
import socket
import sys
import time

port = int(sys.argv[1])
deadline = time.time() + 20

while time.time() < deadline:
    sock = socket.socket()
    sock.settimeout(1.0)
    try:
        sock.connect(("127.0.0.1", port))
    except OSError:
        time.sleep(0.5)
    else:
        sock.close()
        raise SystemExit(0)
    finally:
        sock.close()

raise SystemExit("Timed out waiting for cloud-sql-proxy")
PY

  export DB_HOST="127.0.0.1"
  export DB_PORT="$PROXY_PORT"
else
  export DB_HOST
  export DB_PORT
fi

export DB_NAME
export DB_USER
export DB_PASSWORD

python3 "$REPO_ROOT/scripts/ops/db_migration_release_guard.py" \
  --contract-file "$CONTRACT_FILE" \
  --report-path "$REPORT_PATH"

echo "Runtime DB contract verified. Report: $REPORT_PATH"
