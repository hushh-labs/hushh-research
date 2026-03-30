# Capacitor Parity Audit Report


## Visual Context

Canonical visual owner: [Mobile Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Last audited: March 29, 2026

## Overall Status

Current status: release-gate pass with no accepted parity exceptions.

The following all pass together:

- `npm run verify:routes`
- `npm run verify:parity`
- `npm run verify:capacitor:routes`
- `npm run verify:capacitor:config`
- `npm run verify:mobile-firebase`
- `npm run verify:docs`
- `npm run verify:native:browser-compat`
- `npm run verify:capacitor:audit`
- `xcodebuild -list -project ios/App/App.xcodeproj`
- `./gradlew tasks --all`

## Blockers

None at the time of this audit.

The repo now hard-fails when:

- a visible page route is not declared in `route-contracts.json`
- a declared visible page route is not classified in `mobile-parity-registry.json`
- route-facing browser-only APIs bypass shared wrappers or explicit exemptions
- docs drift from the current runtime/native contract

## Accepted Exceptions

None.

Android passkey PRF is part of the shipped native contract, and cloud-backed preference storage is the canonical cross-platform behavior rather than an exception.

## Advisory Follow-Up

### 1. Keep route classification current

Any new visible page must be added to:

- `hushh-webapp/route-contracts.json`
- `hushh-webapp/mobile-parity-registry.json`

### 2. Keep browser APIs behind wrappers

Route-facing code should continue to use:

- `hushh-webapp/lib/utils/clipboard.ts`
- `hushh-webapp/lib/utils/browser-navigation.ts`
- `hushh-webapp/lib/utils/session-storage.ts`
- `hushh-webapp/lib/utils/native-download.ts`

Current registry-backed direct usage that must remain intentional and documented:

- navigation mutation:
  - `hushh-webapp/components/app-ui/route-error-boundary.tsx`
  - `hushh-webapp/components/vault/vault-lock-guard.tsx`
  - `hushh-webapp/lib/consent/use-consent-actions.ts`
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
