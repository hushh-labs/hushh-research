---
name: mobile-parity-audit
description: Use when auditing mobile/native parity, release readiness, the native route inventory report, or platform-specific coverage gates across the Hussh app.
---

# Hussh Mobile Parity Audit Skill

## Purpose and Trigger

- Primary scope: `mobile-parity-audit`
- Trigger on parity audits, native release-readiness checks, and platform-specific coverage or regression review.
- Avoid overlap with `mobile-plugin-contracts` and `quality-contracts`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `mobile-native`

Owned repo surfaces:

1. `docs/reference/mobile`
2. `hushh-webapp/scripts/native`
3. `hushh-webapp/ios/App/AppTests`
4. `hushh-webapp/ios/App/AppUITests`

Non-owned surfaces:

1. `mobile-native`
2. `frontend`
3. `security-audit`

## Do Use

1. Auditing web/iOS/Android parity and platform-specific gaps.
2. Running native release-readiness checks and reviewing native regression risk.
3. Confirming documented parity expectations against the current app surface.

## Do Not Use

1. Implementing plugin contracts or native bridge details directly.
2. Broad native intake when the actual subtype is still unclear.
3. Generic test-strategy work outside the mobile family.

## Read First

1. `docs/reference/mobile/README.md`
2. `docs/reference/mobile/capacitor-parity-audit.md`
3. `docs/reference/mobile/capacitor-parity-audit-report.md`

## Workflow

1. Start from the documented parity contract and then validate the live native surfaces.
2. Keep findings tied to concrete platform gaps, not generic “mobile broken” summaries.
3. Route implementation work back into plugin-contract or owner skills after the audit isolates the issue.
4. For generated native route audit reports, treat `ok: true` as advisory until the observed status also proves `ready=1`, `found=1`, and the observed marker equals the expected marker. A passed report with a missing marker is a blocker, not release evidence.
5. Before physical voice or route smoke, run the static native parity gate so missing microphone permission metadata, missing route-inventory entries, or unclassified legacy aliases fail before device work.
6. Any route added to `ROUTES` must be classified in `native-route-inventory.json` in the same change. Nested route families that share one workspace may share a marker, but each canonical route still needs an explicit inventory row and static-export-safe fixture.
7. Keep destructive cold audits and non-destructive continuity rehearsals separate. Cold fixture evidence never proves an active memory-only vault or route survives background/resume.
8. Start with static and host-native tests. A cold audit requires explicit authority, must terminate its test app on every host terminal path, and is never a default diagnosis command for a continuity failure.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `mobile-native`.
2. If the audit isolates a plugin-contract issue, use `mobile-plugin-contracts`.
3. If the problem is actually broader quality or trust validation, route to `quality-contracts` or `security-audit`.

## Required Checks

```bash
cd hushh-webapp && npm run verify:capacitor:static
cd hushh-webapp && ./android/gradlew -p android :app:testDebugUnitTest --no-daemon
cd hushh-webapp && xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/App/build/DerivedData build-for-testing
```

Run `npm run ios:cold:audit`, `npm run android:cold:audit`, or the UI cold-audit
equivalent only when the task explicitly authorizes a reset. Run
`ios:continuity:local` or `android:continuity:local` only for an intentional
normal-session rehearsal. Keep agent-driven simulations headless. Use the explicit
visible opt-in only when the user requests a desktop window.
