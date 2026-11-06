#!/usr/bin/env bash
# Sourced after append_optional_secret is defined. Values remain in Secret Manager.
if [[ "${1:-}" == "uat" ]]; then
  [[ -z "${_SECRET_PREFIX:-}" ]] || return 0
  if [[ "${2:-}" != "hushh-pda-uat" ]]; then
    echo "UAT PLG secret bindings require the UAT project." >&2
    return 1
  fi
  for plg_secret in ONE_PLG_UAT_EXPORT_SECRET ONE_PLG_ACTIVITY_UAT_ACCOUNT_IDS \
    ONE_PLG_ATTEMPT_EMAIL_SECRET ONE_PLG_ATTEMPT_EMAIL_ACCOUNT_IDS; do
    if [[ "$(gcloud secrets versions describe latest --secret="$plg_secret" --project="$2" --format='value(state)' 2>/dev/null)" == "ENABLED" ]]; then
      append_optional_secret "$plg_secret" "$plg_secret"
    fi
  done
  return 0
fi
# The exporter stays unavailable unless its production runtime flag is enabled.
if [[ "${1:-}" == "production" ]]; then
  plg_project="${2:-}"
  [[ -n "$plg_project" ]] || return 0
  for plg_secret in ONE_PLG_EXPORT_SECRET ONE_PLG_EXPORT_ACCOUNT_IDS; do
    if [[ "$(gcloud secrets versions describe latest --secret="$plg_secret" --project="$plg_project" --format='value(state)' 2>/dev/null)" == "ENABLED" ]]; then
      append_optional_secret "$plg_secret" "$plg_secret"
    fi
  done
  if [[ "$(gcloud secrets versions describe latest --secret=ONE_PLG_SUBSCRIPTION_SECRET --project="$plg_project" --format='value(state)' 2>/dev/null)" == "ENABLED" ]]; then
    append_optional_secret ONE_PLG_SUBSCRIPTION_SECRET ONE_PLG_SUBSCRIPTION_SECRET
  fi
  if [[ "$(gcloud secrets versions describe latest --secret=ONE_PLG_AUDIENCE_SECRET --project="$plg_project" --format='value(state)' 2>/dev/null)" == "ENABLED" ]]; then
    append_optional_secret ONE_PLG_AUDIENCE_SECRET ONE_PLG_AUDIENCE_SECRET
  fi
  if [[ "$(gcloud secrets versions describe latest --secret=ONE_PLG_REPORTING_POLICY_JSON --project="$plg_project" --format='value(state)' 2>/dev/null)" == "ENABLED" ]]; then
    append_optional_secret ONE_PLG_REPORTING_POLICY_JSON ONE_PLG_REPORTING_POLICY_JSON
  fi
fi
