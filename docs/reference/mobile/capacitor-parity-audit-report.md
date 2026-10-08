# Capacitor Parity Audit Report


## Visual Context

Canonical visual owner: [Mobile Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Status as of: September 5, 2026

Founder-language note: this report is evidence for `Separation of Duties`, not a new architecture concept. It tracks whether the mobile delivery boundary stays aligned with the shared platform contract.

## Overall Status

Current status: cold route-parity gate implemented. The dated simulator/emulator reports below are historical cold-start evidence; they are not proof of normal-session vault or route continuity.

Historical route evidence (not current release proof):

- iOS simulator: `native-ios-parity-report.json`, generated `2026-05-25T06:27:59.825Z`, destination `platform=iOS Simulator,id=9C5B1D61-028C-474A-BDFC-523BACC3B02C`, 36 audited / 36 passed / 0 failed.
- Android emulator: `native-android-parity-report.json`, generated `2026-05-25T06:34:59.304Z`, device `emulator-5554`, 36 audited / 36 passed / 0 failed.

The native gate now includes:

- `cd hushh-webapp && npm run verify:surface-map`
- `cd hushh-webapp && npm run verify:capacitor:static`
- `cd hushh-webapp && npm run verify:capacitor:plugins`
- `xcodebuild -list -project ios/App/App.xcodeproj`
- `./gradlew tasks --all`
- `cd hushh-webapp && npm run ios:cold:audit`
- `cd hushh-webapp && npm run android:cold:audit`
- `cd hushh-webapp && npm run verify:capacitor:reports`

Continuity is separately rehearsed against an already-installed normal session with `ios:continuity:local` or `android:continuity:local`; it must not inherit evidence from a cold audit.

## Android Agents Rendered-UI Rehearsal — September 9, 2026

The Pixel 8 emulator running Android 17 and WebView 152.0.7977.64 reproduced
agent-grid pixels above Search while the DOM contained one correctly positioned
grid. Chromium's screenshot and Android's display capture disagreed. Removing
backdrop filters, disabling native overscroll, and disabling HWUI partial redraws
did not resolve the reproduction; those diagnostic overrides were removed.

The same rebuilt APK reproduced the overlap with the emulator's ANGLE/SwiftShader
software renderer and cleared it with the host GPU renderer (Apple M5/Metal).
The affected local AVD now uses `hw.gpu.mode=host`. This is an emulator rendering
configuration correction, not an application spacing or stacking-order fix.
When diagnosing this failure, compare the actual renderer reported by
`adb shell dumpsys SurfaceFlinger`, rather than assuming AVD `auto` selected
hardware rendering. A cold emulator launch with `-gpu host -no-snapshot-load`
allows comparison without wiping app storage.

The Android-only roster clipping/paint-containment workaround was removed.
The header, view controls, and Search remain outside the replaced content subtree.
After rebuilding and installing the APK, two touch-driven cycles covered both
views and returns from Connect, Feed, and the Search overlay. Sixteen Android
display captures were collected. The header/Search region matched across all
twelve return captures within each view. Component tests separately verify that
Grid/List replacement preserves the same header, search, and control nodes.

This is dated emulator evidence, not a physical-device or fresh iOS parity claim.
Do not introduce route-local clipping, offsets, or forced redraw timers to mask
an emulator compositor defect.

## Blockers

Current tracked evidence blockers:

- `verify:capacitor:reports` fails against the current 103-route inventory on the
  audited local revision. The tracked iOS report declares 91 audited routes but has
  only 13 results, including a failed `/register-phone`; Android has 76 results.
- Updated simulator/emulator runs are required to establish route parity. Static
  plugin checks and historical May results do not replace those runs.
- iOS background location sharing exists; Android explicitly reports it unavailable.
  Treat this as a behavioral gap, not proof of full native parity.

The repo now hard-fails when:

- the canonical app route contract in `hushh-webapp/lib/navigation/routes.ts` drifts from the docs/runtime contract
- native microphone permission metadata is missing while One Voice/Kai compatibility uses `getUserMedia({ audio: true })`
- native route inventory omits a `ROUTES` entry or leaves a legacy route unclassified
- iOS or Android route reports are stale against the current native-required route inventory
- an `ok: true` route report result lacks `ready=1`, `found=1`, expected marker, route match, auth match, or allowed data state
- TypeScript `registerPlugin` methods drift from iOS or Android native plugin methods
- route-facing browser-only APIs bypass shared wrappers or explicit exemptions
- docs drift from the current runtime/native contract

## Accepted Exceptions

None.

Android passkey PRF is part of the shipped native contract, and cloud-backed preference storage is the canonical cross-platform behavior rather than an exception.

## Advisory Follow-Up

### 1. Keep route classification current

Any new visible page must be added to:

- `hushh-webapp/lib/navigation/routes.ts`
- `docs/reference/architecture/route-contracts.md`

### 2. Keep browser APIs behind wrappers

Route-facing code should continue to use:

- `hushh-webapp/lib/utils/clipboard.ts`
- `hushh-webapp/lib/utils/browser-navigation.ts`
- `hushh-webapp/lib/utils/session-storage.ts`
- `hushh-webapp/lib/utils/native-download.ts`

Current registry-backed direct usage that must remain intentional and documented:

- internal navigation:
  - product/internal route changes should use Next.js `router.push` / `router.replace` or the shared internal navigation event handled by `app/providers.tsx`
  - native parity recovery must not use `window.location` because it can discard in-memory BYOK vault state
- external navigation:
  - true external exits should use `hushh-webapp/lib/utils/browser-navigation.ts`
- IndexedDB:
  - `hushh-webapp/lib/services/device-resource-cache-service.ts`
  - `hushh-webapp/lib/services/secure-resource-cache-service.ts`

Native auth storage note:

- `HushhAuth` persists native auth tokens through secure platform storage (`Keychain` / `Keystore`) rather than general user defaults or browser storage.

### 3. Keep Apple capability docs aligned

If entitlements change, update:

- `deploy/apple_app_id_capabilities.md`
- `deploy/app_store_deployment.md`
- `docs/guides/mobile.md`

in the same change.
