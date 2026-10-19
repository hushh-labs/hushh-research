#!/usr/bin/env bash
# Sourced after add_secret is defined. Values remain in Secret Manager.
# The exporter stays unavailable unless its production runtime flag is enabled.
if [[ "${1:-}" == "production" ]]; then
  add_secret ONE_PLG_EXPORT_SECRET ONE_PLG_EXPORT_SECRET
  add_secret ONE_PLG_EXPORT_ACCOUNT_IDS ONE_PLG_EXPORT_ACCOUNT_IDS
fi
