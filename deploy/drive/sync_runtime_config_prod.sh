#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
# One production profile for the existing config owner and staged worker.
set -euo pipefail
candidate_flags=()
case "${PRODUCTION_DRIVE_CANDIDATE_ONLY:-false}" in
  false) ;;
  true) candidate_flags=(--production-drive-candidate-only) ;;
  *) echo "Invalid candidate configuration mode" >&2; exit 1 ;;
esac
case "${PRODUCTION_DRIVE_ACTIVE:-}" in true|false) ;; *) exit 1 ;; esac
nearby_mode=""
if [[ -n "${NEARBY_CHECK_IN_COHORT:-}" ]]; then nearby_mode=production; fi
"${PROTOCOL_PYTHON:?protocol runtime required}" scripts/ops/sync_backend_runtime_secrets.py "${candidate_flags[@]}" \
  --project "${GCP_PROJECT_ID}" \
  --environment production \
  --app-frontend-origin "${APP_FRONTEND_ORIGIN}" \
  --db-host "cloudsql-socket" \
  --db-port "5432" \
  --db-name "${PROD_DB_NAME}" \
  --db-unix-socket "${PROD_DB_UNIX_SOCKET}" \
  --cloudsql-instance-connection-name "${PROD_CLOUDSQL_INSTANCE}" \
  --consent-sse-enabled "false" \
  --sync-remote-enabled "false" \
  --developer-api-enabled "true" \
  --remote-mcp-enabled "true" \
  --cors-allowed-origins "${APP_FRONTEND_ORIGIN}" \
  --obs-data-stale-ratio-threshold "0.25" \
  --plaid-env "production" \
  --plaid-client-name "Hushh Kai" \
  --plaid-country-codes "US" \
  --plaid-webhook-url "${APP_FRONTEND_ORIGIN}/api/kai/plaid/webhook" \
  --plaid-redirect-path "/kai/plaid/oauth/return" \
  --plaid-tx-history-days "730" \
  --connections-panel-v2 "${PRODUCTION_DRIVE_ACTIVE:?Drive mode required}" \
  --google-drive-connection "${PRODUCTION_DRIVE_ACTIVE:?Drive mode required}" \
  --google-drive-live "${PRODUCTION_DRIVE_ACTIVE:?Drive mode required}" \
  --google-drive-picker "${PRODUCTION_DRIVE_ACTIVE:?Drive mode required}" \
  --drive-document-indexing "${PRODUCTION_DRIVE_ACTIVE:?Drive mode required}" \
  --drive-four-group-index "false" \
  --drive-document-sharing "${PRODUCTION_DRIVE_ACTIVE:?Drive mode required}" \
  --google-drive-chat-reads "${PRODUCTION_DRIVE_ACTIVE:?Drive mode required}" \
  --connector-production-all-users "${PRODUCTION_DRIVE_ACTIVE:?Drive mode required}" \
  --curated-mcp-connectors "$PROD_CURATED_MCP_CONNECTORS" \
  --production-drive-candidate-secret "${DRIVE_CANDIDATE_RUNTIME_SECRET}" \
  --one-location-read-only-state-enabled "false" \
  --consent-center-summary-v2-enabled "${CONSENT_CENTER_SUMMARY_V2_ENABLED:-true}" \
  --hushh-trusted-device-enabled "${HUSSH_TRUSTED_DEVICE_ENABLED:-false}" \
  --hushh-tech-client-enabled "false" \
  --one-voice-mail-reply-enabled "false" \
  --one-voice-mail-schedule-send-enabled "false" \
  --one-voice-mail-drafts-enabled "false" \
  --mail-scheduled-drain-enabled "false" \
  --hushh-tech-allowed-consent-scopes "" \
  --one-location-nearby-presence-mode "${nearby_mode}" \
  --one-location-nearby-presence-cohort "${NEARBY_CHECK_IN_COHORT:-}" \
  --advisors-api-base-url "${ADVISORS_API_BASE_URL:-https://brokercheck.35.253.255.106.sslip.io}" \
  --insurance-agents-api-base-url "${INSURANCE_AGENTS_API_BASE_URL:-https://insurance-agents.34.61.69.175.sslip.io}" \
  --one-places-directory-enabled "${ONE_PLACES_DIRECTORY_ENABLED_PROD:-true}" \
  > /tmp/prod-runtime-secret-sync.json
