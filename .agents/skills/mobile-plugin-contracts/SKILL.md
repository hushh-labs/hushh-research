---
name: mobile-plugin-contracts
description: Use when implementing or reviewing Capacitor plugin contracts, native plugin registration, or platform bridge alignment across iOS and Android.
---

# Hussh Mobile Plugin Contracts Skill

## Purpose and Trigger

- Primary scope: `mobile-plugin-contracts`
- Trigger on Capacitor plugin contracts, native plugin registration, platform bridge alignment, and service-to-plugin interface work.
- Avoid overlap with `mobile-parity-audit` and `frontend-architecture`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `mobile-native`

Owned repo surfaces:

1. `hushh-webapp/lib/capacitor`
2. `hushh-webapp/ios/App/App/Plugins`
3. `hushh-webapp/android/app/src/main`

Non-owned surfaces:

1. `mobile-native`
2. `frontend`
3. `backend`

## Do Use

1. Creating or updating native plugins and their TypeScript bridge contracts.
2. Plugin registration and method-name alignment across iOS, Android, and service-layer callers.
3. Reviewing plugin boundary drift between native and web paths.

## Do Not Use

1. Broad native parity or release-readiness work.
2. Broad frontend or backend intake.
3. Cross-domain repo mapping.

## Read First

1. `docs/guides/new-feature.md`
2. `hushh-webapp/ios/App/App/MyViewController.swift`
3. `hushh-webapp/android/app/src/main/AndroidManifest.xml`
4. `hushh-webapp/docs/ios-native-surface-adoption.md`

## Workflow

For custom native presentation changes, follow the current renderer boundaries
in `hushh-webapp/docs/ios-native-surface-adoption.md`. Prove a feasible whole-layer
composition first; retained hosts and ordered bridge receipts cannot synchronize
React and native animation frames. Choose one renderer before reveal and keep it
for that presentation lifetime. Do not reopen historical Debug flags as adoption.

1. Verify the TypeScript bridge, plugin registration, and native implementation paths first.
2. Keep plugin method names and service-layer contracts aligned across platforms.
3. Treat service-layer native/web branching as part of the same contract, not a follow-up.
4. Separate retained presentation, current action binding, interaction/accessibility eligibility and privacy. Capability/layout receipts are admission evidence, not rendered transition acceptance; use the adoption reference's qualification rules.
5. Treat keyboard movement as eligibility/geometry, not automatic host retirement. Validate deliberate focus cancellation separately from uncertainty; require fresh system geometry for keyboard acceptance. Refresh compatible admission without replacing unchanged presentation. Fence superseded layout failures as well as receipts; current failures remain fail-closed. Native drawers own complete motion locally; do not synchronize them with per-frame React poses. Historical pose protocols remain rollback-only, not product qualification.
6. Characterize renderer bootstrap against the installed SDK's final WebView creation path. Configuration hooks can be overwritten before document creation; use a host regression plus real renderer admission, not merely a mocked eligibility check. See the adoption reference's bootstrap evidence.
7. A private editor's final committed text can arrive after coverage revokes actions. Reconcile it through the editor's owner/revision fence without reviving actions, clearing a newer draft or logging its body. Acknowledgment of a trigger is not proof that its owned popup finished dismissal.
8. Transient feedback over a native pane belongs to its acknowledged owned presenter and accessible subtree, never a window-level sibling. Preserve the shared notification/promise owner, distinguish pending admission from retirement, and bind expiry/dismissal to the captured form, destination and revision. Prove retained-host replacement and delivered touches outside the bounded banner; an `isHittable` receipt alone is insufficient. Follow the adoption reference's private feedback boundary.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `mobile-native`.
2. If the task is parity or release-readiness rather than plugin contracts, use `mobile-parity-audit`.
3. If the work becomes broad web-frontend or backend architecture, route to `frontend` or `backend`.

## Required Checks

```bash
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run cap:build
```
