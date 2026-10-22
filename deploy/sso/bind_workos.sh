#!/usr/bin/env bash
# Bind WorkOS enterprise SSO into the backend deploy. Sourced by
# scripts/deploy/backend-deploy.sh after its optional binding helpers are defined.
#
# The three secrets are optional by construction: append_optional_secret skips any that do not
# exist in the deploy project, and the routes answer 404 until WORKOS_SSO_ENABLED
# is true. Secret name == environment variable name, so nothing else is wired.
# Secret values are never read into this shell.
#
# The three non-secret values arrive packed in one variable (enabled | redirect URI | redirect
# origins) because Cloud Build allows at most 100 env entries per step and this step is at the
# limit; a 101st entry rejects every backend deploy at submission.
IFS='|' read -r _WORKOS_SSO_ENABLED _WORKOS_REDIRECT_URI _WORKOS_REDIRECT_ORIGINS <<< "${_WORKOS_CONFIG:-||}"
append_optional_secret WORKOS_API_KEY WORKOS_API_KEY
append_optional_secret WORKOS_CLIENT_ID WORKOS_CLIENT_ID
append_optional_secret WORKOS_WEBHOOK_SECRET WORKOS_WEBHOOK_SECRET
append_optional_env WORKOS_SSO_ENABLED "${_WORKOS_SSO_ENABLED:-}"
append_optional_env WORKOS_REDIRECT_URI "${_WORKOS_REDIRECT_URI:-}"
append_optional_env WORKOS_REDIRECT_ORIGINS "${_WORKOS_REDIRECT_ORIGINS:-}"

# Fail closed: with SSO switched on, a missing secret would deploy a sign-in that silently does not
# work (the secrets are otherwise optional and skipped when absent).
if [[ "${_WORKOS_SSO_ENABLED:-}" == true ]]; then
  for required in WORKOS_API_KEY WORKOS_CLIENT_ID WORKOS_WEBHOOK_SECRET; do
    if [[ "${secrets}" != *",${required}="* ]]; then
      echo "WorkOS SSO is enabled but the secret ${required} does not exist in ${PROJECT_ID}." >&2
      exit 1
    fi
  done
  if [[ -z "${_WORKOS_REDIRECT_URI:-}" ]]; then
    echo "WorkOS SSO is enabled but no redirect URI is configured." >&2
    exit 1
  fi
fi
