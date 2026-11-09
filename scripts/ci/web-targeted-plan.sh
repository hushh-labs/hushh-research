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

# These paths have explicit non-browser owners. Runtime application paths are
# deliberately absent: a new component, API implementation or shared dependency
# must not become a silent no-browser selection. Existing pack matches still win.
web_targeted_non_browser_owner() {
  case "$1" in
    .agents/*|.github/*|docs/*|scripts/*|deploy/*|config/*|AGENTS.md|README.md|LICENSE*|NOTICE*) return 0 ;;
    # Backend changes retain Protocol/Integration ownership. Explicit browser
    # boundary matches above still win; an unrelated Python path is not an
    # unknown frontend dependency and must not expand every browser pack.
    consent-protocol/*|contracts/*|packages/*) return 0 ;;
    # These exact CI selectors are exercised by the existing Node governance owner.
    hushh-webapp/scripts/testing/affected-tests.mjs|hushh-webapp/scripts/testing/affected-tests.test.mjs) return 0 ;;
    # Web Core owns structural checks; Governance exercises these CLI profiles.
    hushh-webapp/scripts/architecture/verify-design-system.mjs|hushh-webapp/scripts/architecture/verify-render-performance.mjs|hushh-webapp/scripts/design/verify-apple-hierarchy.mjs) return 0 ;;
    # The unconditional UI Contracts job runs these exact Node validators.
    hushh-webapp/scripts/architecture/ui-review-receipts.mjs|hushh-webapp/scripts/architecture/verify-ui-contracts.mjs|hushh-webapp/scripts/architecture/back-navigation.test.mjs|hushh-webapp/scripts/voice/search-contracts.test.mjs) return 0 ;;
    hushh-webapp/__tests__/*|hushh-webapp/contracts/ui-review/*|hushh-webapp/docs/*) return 0 ;;
    # These exact compiler outputs retain UI Contracts and their affected unit
    # owners. Unknown JSON and generated runtime code remain conservative.
    hushh-webapp/contracts/kai/one-capability-graph.v1.json|hushh-webapp/contracts/kai/one-route-orchestration-index.v1.json|hushh-webapp/contracts/kai/kai-action-gateway.vnext.json) return 0 ;;
    hushh-webapp/frontend-native-surface-map.generated.json|hushh-webapp/cache-coherence-screen-manifest.generated.json) return 0 ;;
    hushh-webapp/lib/*/__tests__/*|hushh-webapp/components/*/__tests__/*|hushh-webapp/app/*/__tests__/*) return 0 ;;
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}

web_targeted_plan_finish() {
  if [ "$PLAN_ERROR" -ne 0 ]; then
    exit 2
  fi
  while IFS= read -r changed_path; do
    [ -z "$changed_path" ] && continue
    if grep -Fxq -- "$changed_path" <<<"$MATCHED_CHANGED_FILES"; then
      continue
    fi
    if web_targeted_non_browser_owner "$changed_path"; then
      printf 'Non-browser owner: %s\n' "$changed_path" >&2
    else
      printf 'Unclassified application impact: %s; retaining conservative browser coverage.\n' "$changed_path" >&2
      PLAN_SELECTION_KNOWN=0
      PLAN_BROWSER_REQUIRED=1
    fi
  done <<<"$CHANGED_FILE_LIST"
  web_targeted_plan_write
  exit 0
}
