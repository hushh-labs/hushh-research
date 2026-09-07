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
