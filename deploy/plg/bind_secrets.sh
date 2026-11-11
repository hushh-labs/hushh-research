#!/usr/bin/env bash
# Sourced after append_optional_secret is defined. Values remain in Secret Manager.
# Credentials cannot activate collection, own reads or optional attempt emails.
# Isolated preview namespaces must not borrow canonical environment keys.
[[ -z "${_SECRET_PREFIX:-}" ]] || return 0
plg_lane="${1:-}"
plg_project="${2:-}"
case "$plg_lane:$plg_project" in
  dev:hushh-pda-dev)
    plg_secrets=(ONE_PLG_DEV_EXPORT_SECRET ONE_PLG_ACTIVITY_DEV_ACCOUNT_IDS) ;;
  uat:hushh-pda-uat)
    plg_secrets=(ONE_PLG_UAT_EXPORT_SECRET ONE_PLG_ACTIVITY_UAT_ACCOUNT_IDS) ;;
  production:hushh-pda)
    plg_secrets=(ONE_PLG_EXPORT_SECRET ONE_PLG_EXPORT_ACCOUNT_IDS ONE_PLG_SUBSCRIPTION_SECRET
      ONE_PLG_AUDIENCE_SECRET ONE_PLG_REPORTING_POLICY_JSON ONE_PLG_OWNER_EXPORT_SECRET ONE_PLG_OWNER_ACCOUNT_IDS) ;;
  *) echo "PLG secret bindings require an exact environment/project pair." >&2; return 1 ;;
esac
plg_secrets+=(ONE_PLG_ATTEMPT_EMAIL_SECRET ONE_PLG_ATTEMPT_EMAIL_ACCOUNT_IDS)
for plg_secret in "${plg_secrets[@]}"; do
  if [[ "$(gcloud secrets versions describe latest --secret="$plg_secret" --project="$plg_project" --format='value(state)' 2>/dev/null)" == ENABLED ]]; then
    append_optional_secret "$plg_secret" "$plg_secret"
  fi
done
