#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
# ASC credentials stay in runner-local files and masked environment values.
set -euo pipefail
project="${GCP_PROJECT_ID:-hushh-pda-uat}"
test -n "${RUNNER_TEMP:-}" && test -n "${GITHUB_ENV:-}"
get() { gcloud secrets versions access latest --secret="$1" --project="$project"; }
key_id="$(get APPSTORE_CONNECT_KEY_ID)"
issuer_id="$(get APPSTORE_CONNECT_ISSUER_ID)"
test -n "$key_id" && test -n "$issuer_id"
echo "::add-mask::$key_id"
echo "::add-mask::$issuer_id"
umask 077
get APPSTORE_CONNECT_API_KEY_P8_B64 | openssl base64 -d -A > "$RUNNER_TEMP/asc.p8"
chmod 600 "$RUNNER_TEMP/asc.p8"
grep -q 'BEGIN PRIVATE KEY' "$RUNNER_TEMP/asc.p8"
printf 'ASC_KEY_ID=%s\nASC_ISSUER_ID=%s\n' "$key_id" "$issuer_id" >> "$GITHUB_ENV"
