#!/usr/bin/env bash
# Bind WorkOS enterprise SSO into the backend deploy. Sourced by
# deploy/backend.cloudbuild.yaml after add_secret and add_env are defined.
#
# The three secrets are optional by construction: add_secret skips any that do not
# exist in the deploy project, and the routes answer 404 until WORKOS_SSO_ENABLED
# is true. Secret name == environment variable name, so nothing else is wired.
# Secret values are never read into this shell.
add_secret WORKOS_API_KEY WORKOS_API_KEY
add_secret WORKOS_CLIENT_ID WORKOS_CLIENT_ID
add_secret WORKOS_WEBHOOK_SECRET WORKOS_WEBHOOK_SECRET
add_env WORKOS_SSO_ENABLED "${_WORKOS_SSO_ENABLED:-}"
add_env WORKOS_REDIRECT_URI "${_WORKOS_REDIRECT_URI:-}"
