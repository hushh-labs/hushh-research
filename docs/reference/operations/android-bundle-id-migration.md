# Android Bundle ID Migration: com.hushh.app → com.hussh.app

## Visual Context

Canonical visual owner: [Operations Index](README.md). This page is the migration-plan
record required by [Hussh Rebrand Classification](./hussh-rebrand-classification.md)'s
`copy-sensitive runtime string` bucket ("bundle IDs and app IDs: preserve unless there is
a dedicated alias or migration plan"), written retroactively after the rename landed
without one.

## What changed and why

Android's application id moved from `com.hushh.app` to `com.hussh.app`. **iOS deliberately
stays on `com.hushh.app`** — this is a one-platform rename, not a project-wide rebrand.

Root cause: `com.hushh.app` could not be registered as a new app in Google Play Console.
Direct API calls to the Play Developer API confirmed the package is already claimed under
a different, untraceable developer account (never published publicly — a public search for
the literal string turned up nothing, consistent with an old, forgotten registration rather
than a live competing app). Google Play never releases a reserved package name once claimed,
so `com.hushh.app` is permanently unusable for Android regardless of who owns this codebase.
`com.hussh.app` was confirmed available and is what Android now ships under.

## What moved (landed in commit `f5a7e712c`, PR #4947)

- `hushh-webapp/android/app/build.gradle`: `namespace` / `applicationId`
- The full `com/hushh/app` Kotlin/Java source tree → `com/hussh/app` (16 files: `MainActivity.kt` + 11 plugins + tests)
- `strings.xml`: `package_name`, `custom_url_scheme`
- CI: `.github/workflows/ship-android-playstore-v1.yml`'s `ANDROID_PACKAGE_NAME`, `scripts/ci/resolve-android-build-number.py`'s default package
- A **new** Firebase Android app for `com.hussh.app`, provisioned in the correct project (`hushh-pda` — the one Firebase project shared across dev/UAT/prod per
  [env-and-secrets.md](./env-and-secrets.md), matching iOS and the pre-existing `com.hushh.app`
  Android app; **not** `hushh-pda-uat`, despite this being a UAT-scoped ship pipeline)
- The `ANDROID_GOOGLE_SERVICES_JSON_B64` secret (in `hushh-pda-uat` Secret Manager, which is
  where CI actually reads it from — a naming/storage-location quirk, not a project split)
- `NEXT_PUBLIC_ANDROID_APP_ID` / `ANDROID_SHA256_CERT_FINGERPRINTS` secrets in both `hushh-pda`
  and `hushh-pda-uat` (drives passkey/Digital Asset Links delegation, [runtime.md](../../guides/mobile/runtime.md))

## What deliberately did NOT move

- iOS: bundle id, `GoogleService-Info.plist`, Apple Services ID (`com.hushh.app.signin`) — unchanged, out of scope.
- `hushh-webapp/capacitor.config.ts`'s shared top-level `appId` — stays `"com.hushh.app"`.
  Capacitor's config schema has no per-platform `appId` override, and nothing at Android
  runtime reads the generated `assets/capacitor.config.json` copy of it (confirmed by audit).
  This is an intentional, harmless mismatch, not drift to "fix" later.

## Known-open items from this migration (do not silently close)

1. **Google Sign-In on Android was broken by this migration and is still unresolved as of
   this writing.** The Firebase Android app's registered signing certificate is the release
   *upload key's* SHA-1. Play App Signing re-signs the distributed app with its own
   certificate, which is what Google Sign-In actually validates against at runtime — that
   certificate's SHA-1 was never registered. Firebase's `androidApps/{app}/sha` API only
   provisions a new Google Sign-In OAuth client when a **SHA-1** is added; adding SHA-256
   fingerprints alone (already done, for passkey/Digital Asset Links purposes) does not
   create one. **Fix requires the Play App Signing SHA-1 from Play Console → Setup → App
   integrity → App signing** (no API exposes this — confirmed by direct discovery-document
   inspection of the Android Publisher API, no `signing`-related method exists). Once
   obtained, register it via the same Firebase Management API `sha` endpoint used for the
   SHA-256 values.
2. **Sign in with Apple on Android depends on Apple Developer Portal configuration this
   session has no access to verify.** Android's native flow
   (`firebaseAuth.startActivityForSignInWithProvider`, in `HushhAuthPlugin.kt`) is
   architecturally correct and uses the same Apple Services ID (`com.hushh.app.signin`)
   Firebase Auth already has enabled — but that Services ID's Return URLs (registered with
   Apple, not Google) must include Firebase's auth handler
   (`hushh-pda.firebaseapp.com/__/auth/handler`, confirmed present in Firebase's authorized
   domains). iOS does not depend on this path at all (fully native
   `ASAuthorizationController`), so this is Android-only and may never have been exercised
   for real before this migration surfaced it.
3. No CI step cross-validates that the live `IOS_GOOGLESERVICE_INFO_PLIST_B64` /
   `ANDROID_GOOGLE_SERVICES_JSON_B64` secret contents actually match the hardcoded client
   IDs baked into `Info.plist` / `strings.xml` at build time — this class of drift is exactly
   what caused this migration to break sign-in silently. Worth a follow-up CI check; out of
   scope for this record.
