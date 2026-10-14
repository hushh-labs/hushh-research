#!/usr/bin/env bash
# Bind WorkOS enterprise SSO into the backend deploy. Sourced by
# scripts/deploy/backend-deploy.sh after its optional binding helpers are defined.
#
# The three secrets are optional by construction: append_optional_secret skips any that do not
# exist in the deploy project, and the routes answer 404 until WORKOS_SSO_ENABLED
# is true. Secret name == environment variable name, so nothing else is wired.
# Secret values are never read into this shell.
append_optional_secret WORKOS_API_KEY WORKOS_API_KEY
append_optional_secret WORKOS_CLIENT_ID WORKOS_CLIENT_ID
append_optional_secret WORKOS_WEBHOOK_SECRET WORKOS_WEBHOOK_SECRET
append_optional_env WORKOS_SSO_ENABLED "${_WORKOS_SSO_ENABLED:-}"
append_optional_env WORKOS_REDIRECT_URI "${_WORKOS_REDIRECT_URI:-}"
