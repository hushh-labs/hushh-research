#!/usr/bin/env bash
# Version-compatible packed search controls; no provider or deployment effects.
IFS='|' read -r _DRIVE_REQUEST_SEMANTIC_SEARCH_ENABLED _DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER _DRIVE_REQUEST_ACTIVITY_UNION_ENABLED _DRIVE_REQUEST_ACTIVITY_UNION_PAUSED _drive_search_extra <<< "${_DRIVE_SEARCH_SETTINGS:-false|gemini}"
_DRIVE_REQUEST_ACTIVITY_UNION_ENABLED="${_DRIVE_REQUEST_ACTIVITY_UNION_ENABLED:-true}"
_DRIVE_REQUEST_ACTIVITY_UNION_PAUSED="${_DRIVE_REQUEST_ACTIVITY_UNION_PAUSED:-false}"
if [[ -n "${_drive_search_extra}" || ! "${_DRIVE_REQUEST_SEMANTIC_SEARCH_ENABLED}" =~ ^(true|false)$ ||
      ! "${_DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER}" =~ ^(gemini|azure_openai)$ ||
      ! "${_DRIVE_REQUEST_ACTIVITY_UNION_ENABLED}" =~ ^(true|false)$ ||
      ! "${_DRIVE_REQUEST_ACTIVITY_UNION_PAUSED}" =~ ^(true|false)$ ]]; then
  echo "Invalid Drive semantic search settings." >&2; exit 1
fi
