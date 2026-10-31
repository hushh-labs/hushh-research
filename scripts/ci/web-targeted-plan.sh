#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

# Plan-only helpers for web-targeted-check.sh. The existing selector remains
# the single source of pack-to-path and command-to-browser classification.
PLAN_BROWSER_REQUIRED=0
PLAN_SELECTION_KNOWN=1
PLAN_ERROR=0
MATCHED_CHANGED_FILES=""

web_targeted_prepare() {
  WEB_TARGETED_PLAN_ONLY="${WEB_TARGETED_PLAN_ONLY:-0}"
  case "$WEB_TARGETED_PLAN_ONLY" in
    0|1) ;;
    *) echo "Invalid targeted-pack plan mode." >&2; exit 2 ;;
  esac
  if [ "$WEB_TARGETED_PLAN_ONLY" = "1" ]; then
    browser_primary=1
    web_targeted_plan_start
  else
    browser_primary="$(node "$WEB_DIR/scripts/testing/playwright-shard.cjs")"
    web_ci_preflight
    web_ci_install
  fi
}

web_targeted_plan_write() {
  local selection_known browser_required
  selection_known=false
  browser_required=false
  [ "$PLAN_SELECTION_KNOWN" -eq 1 ] && selection_known=true
  [ "$PLAN_BROWSER_REQUIRED" -eq 1 ] && browser_required=true
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'selection_known=%s\nbrowser_required=%s\n' \
      "$selection_known" "$browser_required" >> "$GITHUB_OUTPUT"
  else
    printf 'selection_known=%s\nbrowser_required=%s\n' \
      "$selection_known" "$browser_required"
  fi
}

web_targeted_plan_start() {
  web_ci_preflight >/dev/null
  if [ "$WEB_TARGETED_ALL_PACKS" = "1" ]; then
    PLAN_BROWSER_REQUIRED=1
    web_targeted_plan_write
    exit 0
  fi
  if [ -z "${WEB_TARGETED_BASE_SHA:-}" ] || [ -z "${WEB_TARGETED_HEAD_SHA:-}" ]; then
    echo "Targeted browser plan requires exact base and head SHAs." >&2
    exit 2
  fi
  if ! git rev-parse --verify "${WEB_TARGETED_BASE_SHA}^{commit}" >/dev/null 2>&1 || \
     ! git rev-parse --verify "${WEB_TARGETED_HEAD_SHA}^{commit}" >/dev/null 2>&1; then
    echo "Targeted browser plan could not resolve its exact base and head SHAs." >&2
    exit 2
  fi
}

web_targeted_plan_match() {
  local matched_paths status
  if matched_paths="$(grep -E "$1" <<<"$CHANGED_FILE_LIST")"; then
    MATCHED_CHANGED_FILES+="${matched_paths}"$'\n'
    return 0
  else
    status=$?
    if [ "$status" -gt 1 ]; then
      echo "Targeted browser plan could not evaluate a source matcher." >&2
      PLAN_ERROR=1
    fi
    return 1
  fi
}

web_targeted_plan_check() {
  local name="$1" part
  shift
  if ! part="$(check_part "$@")"; then
    echo "Targeted browser plan could not classify check '$name'." >&2
    PLAN_ERROR=1
    return 0
  fi
  [ "$part" = "browser" ] && PLAN_BROWSER_REQUIRED=1
  return 0
}

web_targeted_plan_finish() {
  if [ "$PLAN_ERROR" -ne 0 ]; then
    exit 2
  fi
  if [ "$ran" -eq 0 ]; then
    PLAN_SELECTION_KNOWN=0
    PLAN_BROWSER_REQUIRED=1
  else
    while IFS= read -r changed_path; do
      [ -z "$changed_path" ] && continue
      if ! grep -Fxq -- "$changed_path" <<<"$MATCHED_CHANGED_FILES"; then
        PLAN_SELECTION_KNOWN=0
        PLAN_BROWSER_REQUIRED=1
      fi
    done <<<"$CHANGED_FILE_LIST"
  fi
  web_targeted_plan_write
  exit 0
}
