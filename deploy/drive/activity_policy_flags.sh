#!/usr/bin/env bash
# Shared typed rollout controls; pause never disables Stop or reconciliation.
DRIVE_REQUEST_ACTIVITY_UNION_UAT_ENABLED="${DRIVE_REQUEST_ACTIVITY_UNION_UAT_ENABLED:-true}"
DRIVE_REQUEST_ACTIVITY_UNION_UAT_PAUSED="${DRIVE_REQUEST_ACTIVITY_UNION_UAT_PAUSED:-false}"
for policy_flag in "${DRIVE_REQUEST_ACTIVITY_UNION_UAT_ENABLED}" "${DRIVE_REQUEST_ACTIVITY_UNION_UAT_PAUSED}"; do
  case "${policy_flag}" in true|false) ;; *) echo "Invalid Drive activity policy flag" >&2; exit 1 ;; esac
done
readonly DRIVE_REQUEST_ACTIVITY_UNION_UAT_ENABLED DRIVE_REQUEST_ACTIVITY_UNION_UAT_PAUSED
