#!/usr/bin/env bash
# Validate independent sandbox credentials before changing any Cloud Run service.
if [[ "${_DRIVE_REQUEST_HASHCOINS_ENABLED}" == "true" ]]; then
  if [[ "${_STRIPE_CONNECT_MODE}" != "test" ]]; then
    echo "Hashcoin redemption rollout currently requires sandbox Connect." >&2
    exit 1
  fi
  for required_secret in "${_STRIPE_CONNECT_SECRET_KEY_SECRET}" "${_STRIPE_CONNECT_TEST_WEBHOOK_SECRET_SECRET}"; do
    if [[ -z "$required_secret" ]] || ! gcloud secrets describe "$required_secret" --project="${1:?deploy project required}" >/dev/null 2>&1; then
      echo "Hashcoin sandbox requires its isolated Connect secrets." >&2
      exit 1
    fi
  done
fi
