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
4. `hushh-webapp/docs/ios-native-surface-adoption.md`
5. `.agents/skills/repo-operations/references/admin-release-sop.md`

## Workflow

1. Start from the documented parity contract and validate live native surfaces with source-backed route locators and one selection owner per target. Parse/markup checks and build success are not visual runtime proof.
2. Human readout: lead with current design/decisions and a small scorecard separating implementation, verification, platform/runtime and delivery. Bind each claim to the exact worktree candidate (not remote/deployed), date, scope, target and evidence source; put limits beside it and refresh denominators after integration. Separate route reachability from task acceptance; count complete route/state journeys as accepted units and mark nested-state coverage unmeasured until its full denominator exists. Keep evidence compact and preserve unique receipts; use the adoption guide as the mobile plan template, not a chronological diary, duplicate docs-governance/Founder guidance, or an unweighted overall percentage.
3. Route implementation work back into plugin-contract or owner skills after the audit isolates the issue.
4. Generated route reports use the current inventory and actual unique rows: require `audit_complete`, matching `completed_routes`/`audited_routes`/row counts, every required route present without skips or failures, and each `ok` row's `ready=1`, `found=1`, marker, route, auth and data contract. Report stale/incomplete snapshots as passed/failed/missing; declared totals and raw `passed_routes` are not coverage.
5. Before physical voice or route smoke, run the static native parity gate so missing microphone permission metadata, missing route-inventory entries, or unclassified legacy aliases fail before device work.
6. Classify every in-app route, including standard physical pages absent from `ROUTES`. Track query-driven views and nested states separately from their parent route; each needs its own evidence. Nested families may share a marker, but each canonical route still needs an explicit inventory row and static-export-safe fixture.
7. Keep destructive cold audits and non-destructive continuity rehearsals separate. Cold fixture evidence never proves an active memory-only vault or route survives background/resume.
8. Start with static and host-native checks. A cold audit requires explicit authority, must terminate its test app on every host terminal path, and is never a default continuity diagnosis. After failure, classify product/harness/environment/fixture; persist bounded diagnostics and retry only after a verified correction. Preserve the full pretype predicate; after focus or keyboard changes, log bounded independent state, classify an offscreen keyboard as simulator environment, stop after two attempts until a specific correction is evidenced, and never weaken the gate.
9. Before physical reviewer XCUI, read `references/physical-reviewer-preflight.md`; distinguish transport, device unlock, automation authorization and vault admission before supplying credentials.
10. Qualify complete authored journeys with transition evidence and separate visual, touch, accessibility and privacy checks. Follow [`native-journey-evidence.md`](references/native-journey-evidence.md) for locators, fit, captures and failure receipts; stop repeating an unsuccessful approach after two attempts. Prepare installation separately from attach-only warm-session tests; follow the adoption reference, not repeated settled-button screenshots.
11. Distinguish expected glass press feedback from missing/replaced controls. Compare first touch and keyboard transitions, not only settled frames; host retention is not pixel acceptance. If cross-renderer motion fails the documented fluidity standard, stop expansion instead of hiding controls or weakening the gate.
12. Keep installation, XCTest body entry, product interaction, visual/accessibility and Release performance receipts separate and exact-build-bound. Qualification must use the real One/Puppy ports and complete History/Profile handoffs; do not transfer acceptance from a synthetic study or a recovery renderer.

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

Run `npm run ios:cold:audit`, `npm run android:cold:audit`, or the UI cold-audit equivalent only when the task explicitly authorizes a reset; run `ios:continuity:local` or `android:continuity:local` only for an intentional normal-session rehearsal. Keep agent-driven simulator runs headless unless visible observation is requested. For Xcode 27 simulator interaction, use Device Hub and follow the [native journey evidence](references/native-journey-evidence.md) guidance for keyboard visibility, host focus, and evidence-based retries.
