#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

# Secret names for the Drive connector share one Cloud Build env entry. Require
# the complete shape even when the optional names are empty, so a typo cannot
# silently omit a configured binding.
IFS=',' read -r -a _drive_secret_pairs <<< "${_DRIVE_SECRET_SETTINGS:?missing Drive secret settings}"
for _pair in "${_drive_secret_pairs[@]}"; do
  [[ "${_pair}" == *=* ]] || { echo "Invalid Drive secret settings." >&2; exit 1; }
  _key="${_pair%%=*}"; _value="${_pair#*=}"
  case "${_key}" in
    oauth_id) _GOOGLE_DRIVE_OAUTH_CLIENT_ID_SECRET="${_value}" ;;
    oauth_secret) _GOOGLE_DRIVE_OAUTH_CLIENT_SECRET_SECRET="${_value}" ;;
    picker_key) _GOOGLE_DRIVE_PICKER_API_KEY_SECRET="${_value}" ;;
    connector_key) _EXTERNAL_CONNECTOR_CREDENTIAL_KEY_SECRET="${_value}" ;;
    document_key) _DRIVE_DOCUMENT_KEY_V1_SECRET="${_value}" ;;
    sharing_key) _DRIVE_SHARING_KEY_V1_SECRET="${_value}" ;;
    stripe_secret) _STRIPE_SECRET_KEY_SECRET="${_value}" ;;
    stripe_webhook) _STRIPE_WEBHOOK_SECRET_SECRET="${_value}" ;;
    stripe_connect) _STRIPE_CONNECT_WEBHOOK_SECRET_SECRET="${_value}" ;;
    connect_secret) _STRIPE_CONNECT_SECRET_KEY_SECRET="${_value}" ;;
    connect_test_webhook) _STRIPE_CONNECT_TEST_WEBHOOK_SECRET_SECRET="${_value}" ;;
    answer_secret) _PKM_ANSWER_STRIPE_SECRET_KEY_SECRET="${_value}" ;;
    answer_webhook) _PKM_ANSWER_STRIPE_WEBHOOK_SECRET_SECRET="${_value}" ;;
    answer_test_secret) _PKM_ANSWER_STRIPE_TEST_SECRET_KEY_SECRET="${_value}" ;;
    answer_test_webhook) _PKM_ANSWER_STRIPE_TEST_WEBHOOK_SECRET_SECRET="${_value}" ;;
    answer_live_secret) _PKM_ANSWER_STRIPE_LIVE_SECRET_KEY_SECRET="${_value}" ;;
    answer_live_webhook) _PKM_ANSWER_STRIPE_LIVE_WEBHOOK_SECRET_SECRET="${_value}" ;;
    *) echo "Drive secret settings carry an unknown key." >&2; exit 1 ;;
  esac
done
if [[ "${#_drive_secret_pairs[@]}" -ne 17 ]]; then
  echo "Drive secret settings must contain seventeen keys." >&2; exit 1
fi
for _required in _GOOGLE_DRIVE_OAUTH_CLIENT_ID_SECRET _GOOGLE_DRIVE_OAUTH_CLIENT_SECRET_SECRET _GOOGLE_DRIVE_PICKER_API_KEY_SECRET _EXTERNAL_CONNECTOR_CREDENTIAL_KEY_SECRET _DRIVE_DOCUMENT_KEY_V1_SECRET _DRIVE_SHARING_KEY_V1_SECRET _STRIPE_SECRET_KEY_SECRET _STRIPE_WEBHOOK_SECRET_SECRET _STRIPE_CONNECT_WEBHOOK_SECRET_SECRET _STRIPE_CONNECT_SECRET_KEY_SECRET _STRIPE_CONNECT_TEST_WEBHOOK_SECRET_SECRET _PKM_ANSWER_STRIPE_SECRET_KEY_SECRET _PKM_ANSWER_STRIPE_WEBHOOK_SECRET_SECRET _PKM_ANSWER_STRIPE_TEST_SECRET_KEY_SECRET _PKM_ANSWER_STRIPE_TEST_WEBHOOK_SECRET_SECRET _PKM_ANSWER_STRIPE_LIVE_SECRET_KEY_SECRET _PKM_ANSWER_STRIPE_LIVE_WEBHOOK_SECRET_SECRET; do
  if ! declare -p "${_required}" >/dev/null 2>&1; then
    echo "Drive secret settings are missing ${_required}." >&2; exit 1
  fi
done
