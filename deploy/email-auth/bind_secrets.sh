#!/usr/bin/env bash
# Sourced after the backend deploy defines add_secret. Values stay in Secret Manager.
# Enabled UAT preflight requires all keys and proves MAIL_API_KEY is the One consumer.
if [[ "${1:-}" == "uat" ]]; then
  for key in EMAIL_AUTH_VERIFIER_KEY EMAIL_AUTH_PAYLOAD_KEY EMAIL_AUTH_LOOKUP_KEY; do
    add_secret "$key" "$key"
  done
  add_secret MAIL_API_KEY EMAIL_AUTH_MAIL_API_KEY
fi
