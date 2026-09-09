#!/usr/bin/env bash

# Read only the UAT release configuration required after GitHub OIDC/WIF has
# authenticated the runner. Credentials, reviewer contact details, and notes
# remain in protected runner-local files and are never written to GitHub output.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-hushh-pda-uat}"
GITHUB_ENV_PATH="${GITHUB_ENV:-}"
RUNNER_TEMP_PATH="${RUNNER_TEMP:-}"
PRIVACY_CONTRACT_VERSION="${ONE_VOICE_PRIVACY_CONTRACT_VERSION:-one-voice-privacy-v1}"

if [[ -z "$GITHUB_ENV_PATH" || -z "$RUNNER_TEMP_PATH" ]]; then
  echo "materialize-ios-testflight-release-config requires GitHub Actions runner paths." >&2
  exit 2
fi

require_secret() {
  local name="$1"
  if ! gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "Missing required GCP secret: $name (project $PROJECT_ID)." >&2
    exit 1
  fi
}

read_secret() {
  gcloud secrets versions access latest --secret="$1" --project="$PROJECT_ID" 2>/dev/null
}

put_env() {
  printf '%s=%s\n' "$1" "$2" >> "$GITHUB_ENV_PATH"
}

require_exact_true() {
  local name="$1"
  local value
  value="$(read_secret "$name")"
  if [[ "$value" != "true" ]]; then
    echo "$name must be exactly true before a TestFlight upload." >&2
    exit 1
  fi
}

for secret in \
  APPSTORE_CONNECT_API_KEY_P8_B64 \
  APPSTORE_CONNECT_KEY_ID \
  APPSTORE_CONNECT_ISSUER_ID \
  APPSTORE_CONNECT_INTERNAL_TESTFLIGHT_GROUP_ID \
  APPSTORE_CONNECT_EXTERNAL_TESTFLIGHT_GROUP_ID \
  APPSTORE_CONNECT_BETA_REVIEW_CONTACT_JSON \
  APPSTORE_CONNECT_BETA_REVIEW_NOTES \
  APPSTORE_CONNECT_PRIVACY_DECLARATION_CONTRACT_VERSION \
  APPSTORE_CONNECT_EXPORT_COMPLIANCE_APPROVED \
  APPSTORE_CONNECT_VOICE_PROVIDER_PRIVACY_APPROVED; do
  require_secret "$secret"
done

privacy_contract="$(read_secret APPSTORE_CONNECT_PRIVACY_DECLARATION_CONTRACT_VERSION)"
if [[ "$privacy_contract" != "$PRIVACY_CONTRACT_VERSION" ]]; then
  echo "App Store privacy declaration attestation does not match $PRIVACY_CONTRACT_VERSION." >&2
  exit 1
fi
require_exact_true APPSTORE_CONNECT_EXPORT_COMPLIANCE_APPROVED
require_exact_true APPSTORE_CONNECT_VOICE_PROVIDER_PRIVACY_APPROVED

key_id="$(read_secret APPSTORE_CONNECT_KEY_ID)"
issuer_id="$(read_secret APPSTORE_CONNECT_ISSUER_ID)"
internal_group="$(read_secret APPSTORE_CONNECT_INTERNAL_TESTFLIGHT_GROUP_ID)"
external_group="$(read_secret APPSTORE_CONNECT_EXTERNAL_TESTFLIGHT_GROUP_ID)"
if [[ -z "$key_id" || -z "$issuer_id" || -z "$internal_group" || -z "$external_group" ]]; then
  echo "App Store Connect release identifiers must be non-empty." >&2
  exit 1
fi
if [[ "$internal_group" == "$external_group" ]]; then
  echo "Internal and external TestFlight group IDs must differ." >&2
  exit 1
fi

umask 077
key_path="$RUNNER_TEMP_PATH/asc.p8"
contact_path="$RUNNER_TEMP_PATH/asc-beta-review-contact.json"
notes_path="$RUNNER_TEMP_PATH/asc-beta-review-notes.txt"
read_secret APPSTORE_CONNECT_API_KEY_P8_B64 | openssl base64 -d -A > "$key_path"
read_secret APPSTORE_CONNECT_BETA_REVIEW_CONTACT_JSON > "$contact_path"
read_secret APPSTORE_CONNECT_BETA_REVIEW_NOTES > "$notes_path"
chmod 600 "$key_path" "$contact_path" "$notes_path"

if ! grep -q "BEGIN PRIVATE KEY" "$key_path"; then
  echo "App Store Connect signing key is not a valid PEM .p8." >&2
  exit 1
fi
if ! python3 - "$contact_path" "$notes_path" <<'PY'
import json
import pathlib
import sys

contact = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
required = ("first_name", "last_name", "email", "phone")
if not isinstance(contact, dict) or not all(isinstance(contact.get(key), str) and contact[key].strip() for key in required):
    raise SystemExit(1)
if not pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").strip():
    raise SystemExit(1)
PY
then
  echo "Beta review contact or notes are incomplete." >&2
  exit 1
fi

for value in "$key_id" "$issuer_id" "$internal_group" "$external_group"; do
  echo "::add-mask::$value"
done
put_env ASC_KEY_ID "$key_id"
put_env ASC_ISSUER_ID "$issuer_id"
put_env ASC_INTERNAL_GROUP_ID "$internal_group"
put_env ASC_EXTERNAL_GROUP_ID "$external_group"
put_env ASC_BETA_REVIEW_CONTACT_PATH "$contact_path"
put_env ASC_BETA_REVIEW_NOTES_PATH "$notes_path"

echo "Validated protected TestFlight groups, beta-review information, and privacy attestations."
