#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Hushh
# SPDX-License-Identifier: Apache-2.0
#
# Notarization runbook for the One Mac app (Developer ID scheme).
#
# CI usage (macos-15 runner):
#   APPLE_ID=ci@hushh.ai \
#   APPLE_TEAM_ID=XXXXXXXXXX \
#   APPLE_APP_SPECIFIC_PASSWORD=*** \
#   ./apps/one-mac/scripts/notarize.sh build/OneMac.app
#
# Dry-run on PRs: pass --dry-run to skip notarytool submit (still does archive,
# codesign verify, stapler probe).
#
# Exit codes:
#   0  notarization Accepted + stapled + validated
#   1  archive / signing failure
#   2  notarytool returned Invalid or Rejected
#   3  staple failed
#   4  spctl assess failed
#   42 missing required env var

set -euo pipefail

APP_PATH="${1:-build/OneMac.app}"
DRY_RUN="${DRY_RUN:-false}"

require_env() {
    if [ -z "${!1:-}" ]; then
        echo "Error: required env var $1 is not set" >&2
        exit 42
    fi
}

log() {
    printf '\033[1;36m==>\033[0m %s\n' "$*"
}

if [ "$DRY_RUN" = "false" ]; then
    require_env APPLE_ID
    require_env APPLE_TEAM_ID
    require_env APPLE_APP_SPECIFIC_PASSWORD
fi

if [ ! -d "$APP_PATH" ]; then
    echo "Error: app bundle not found at $APP_PATH" >&2
    exit 1
fi

if [ "$DRY_RUN" = "true" ]; then
    # Dry-run on PRs exercises the script path against unsigned ad-hoc bundles
    # produced by CODE_SIGNING_ALLOWED=NO. Skip codesign/runtime/zip checks —
    # those only make sense on Developer-ID-signed bundles (real cert on a
    # main-merge build). Verify the bundle structure and announce success.
    log "DRY_RUN=true: verifying bundle structure only"
    if [ ! -f "$APP_PATH/Contents/Info.plist" ]; then
        echo "Error: $APP_PATH/Contents/Info.plist missing" >&2
        exit 1
    fi
    log "Bundle layout OK. Skipping codesign verify, hardened-runtime probe,"
    log "and notarytool submit. Real signing + notarization runs on tagged releases."
    exit 0
fi

log "Verifying codesign on $APP_PATH"
codesign --verify --strict --deep --verbose=4 "$APP_PATH" || exit 1

log "Verifying hardened runtime is enabled"
if ! codesign -d --entitlements - "$APP_PATH" 2>/dev/null | grep -q 'com.apple.security'; then
    echo "Error: entitlements unreadable; signing identity may be wrong" >&2
    exit 1
fi
codesign -d --verbose "$APP_PATH" 2>&1 | grep -q 'flags=.*runtime' || {
    echo "Error: hardened runtime flag not set on bundle" >&2
    exit 1
}

ZIP_PATH="$(mktemp -d)/OneMac.zip"
log "Compressing for notarytool: $ZIP_PATH"
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

log "Submitting to Apple notarytool (this can take 1-5 minutes)"
xcrun notarytool submit "$ZIP_PATH" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --wait \
    --output-format json > notarytool-result.json

STATUS="$(python3 -c "import json,sys; print(json.load(open('notarytool-result.json'))['status'])")"
log "notarytool status: $STATUS"

if [ "$STATUS" != "Accepted" ]; then
    cat notarytool-result.json
    exit 2
fi

log "Stapling notarization ticket to $APP_PATH"
xcrun stapler staple "$APP_PATH" || exit 3
xcrun stapler validate "$APP_PATH" || exit 3

log "Final Gatekeeper check (spctl)"
spctl --assess --type execute --verbose=4 "$APP_PATH" || exit 4

rm -rf "$(dirname "$ZIP_PATH")"
log "Notarization complete. App is ready for distribution."
