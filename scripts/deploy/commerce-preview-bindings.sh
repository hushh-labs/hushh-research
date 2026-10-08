#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
# Existing backend deploy port: fixed namespace, never shared-secret fallback.
commerce_preview_prefix="${_SECRET_PREFIX:-}"
if [[ -n "${commerce_preview_prefix}" ]]; then
  if [[ "${commerce_preview_prefix}" != "SCOPE_COMMERCE_SANDBOX_" \
    || "${PROJECT_ID}" != "hushh-pda-dev" \
    || "${_BACKEND_SERVICE}" != "consent-protocol-commerce-sandbox" \
    || "${_RUNTIME_SERVICE_ACCOUNT}" != "commerce-sandbox-runtime@hushh-pda-dev.iam.gserviceaccount.com" \
    || "${_CLOUDSQL_INSTANCES}" != "hushh-pda-dev:us-central1:hushh-dev-pg" \
    || "${_BUILD_POD_IMAGE}" != "false" ]]; then
    echo "Commerce preview binding is invalid." >&2
    exit 1
  fi
fi
commerce_secret_name() {
  printf '%s%s' "${commerce_preview_prefix}" "$1"
}

# BEGIN BACKEND PROCESS BOUNDS
configure_backend_process_bounds() {
  worker_count="2"
  # Dev's connection budget and the isolated OAuth rehearsal need one worker.
  if [[ "${_DEPLOY_ENV}" == "dev" || -n "${commerce_preview_prefix:-}" ]]; then
    worker_count="1"
  fi
  if [[ -n "${commerce_preview_prefix:-}" ]]; then
    # Constrain process-local OAuth routing. Restarts, rollouts and temporary
    # extra instances still require a fresh sign-in; this is not durable recovery.
    _CLOUD_RUN_MAX_INSTANCES="1"
    _CLOUD_RUN_MIN_INSTANCES="1"
  fi
}
# END BACKEND PROCESS BOUNDS

append_optional_secret() {
  local secret_name
  local env_name="$2"
  if [[ -z "$1" ]]; then
    return
  fi
  secret_name="$(commerce_secret_name "$1")"
  if gcloud secrets describe "${secret_name}" --project="$PROJECT_ID" >/dev/null 2>&1; then
    secrets="${secrets},${env_name}=${secret_name}:latest"
  else
    echo "Skipping optional secret ${secret_name}; not found in project ${PROJECT_ID}."
  fi
}
