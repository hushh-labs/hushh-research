#!/usr/bin/env bash
# Sourced after add_secret is defined. Values remain in Secret Manager.
# The exporter stays unavailable unless its production runtime flag is enabled.
if [[ "${1:-}" == "production" ]]; then
  plg_project="${2:-}"
  [[ -n "$plg_project" ]] || return 0
  for plg_secret in ONE_PLG_EXPORT_SECRET ONE_PLG_EXPORT_ACCOUNT_IDS; do
    if [[ "$(gcloud secrets versions describe latest --secret="$plg_secret" --project="$plg_project" --format='value(state)' 2>/dev/null)" == "ENABLED" ]]; then
      add_secret "$plg_secret" "$plg_secret"
    fi
  done
  if [[ "$(gcloud secrets versions describe latest --secret=ONE_PLG_SUBSCRIPTION_SECRET --project="$plg_project" --format='value(state)' 2>/dev/null)" == "ENABLED" ]]; then
    add_secret ONE_PLG_SUBSCRIPTION_SECRET ONE_PLG_SUBSCRIPTION_SECRET
  fi
  if [[ "$(gcloud secrets versions describe latest --secret=ONE_PLG_AUDIENCE_SECRET --project="$plg_project" --format='value(state)' 2>/dev/null)" == "ENABLED" ]]; then
    add_secret ONE_PLG_AUDIENCE_SECRET ONE_PLG_AUDIENCE_SECRET
  fi
  if [[ "$(gcloud secrets versions describe latest --secret=ONE_PLG_REPORTING_POLICY_JSON --project="$plg_project" --format='value(state)' 2>/dev/null)" == "ENABLED" ]]; then
    add_secret ONE_PLG_REPORTING_POLICY_JSON ONE_PLG_REPORTING_POLICY_JSON
  fi
fi
