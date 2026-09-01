---
name: tri-flow-parity
description: Use when declaring, reviewing, or enforcing Web/iOS/Android tri-flow parity for a route or feature, including the excluded-route reason contract and the N/A declaration the PR template requires.
---

# Hussh Tri-Flow Parity Skill

## Purpose and Trigger

- Primary scope: `tri-flow-parity`
- Trigger on route additions or moves, and on any PR that must answer the
  Tri-Flow Architecture Check.
- Avoid overlap with `mobile-parity-audit` and `mobile-plugin-contracts`.

Tri-flow is Web + iOS + Android, and every layer is either covered or
explicitly marked N/A **with a reason**. Silent omission is not a third option.
The claim lives in `native-route-inventory.json`, not the PR checkbox: a tick in
a template is not reviewable six months later and nothing reads it.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `mobile-native`

Owned repo surfaces:

1. `hushh-webapp/native-route-inventory.json`
2. `hushh-webapp/scripts/native/verify-native-static-parity.mjs`
3. `docs/reference/mobile/tri-flow-parity.md`

Non-owned surfaces:

1. `hushh-webapp/ios`
2. `hushh-webapp/android`
3. `frontend`

## Do Use

1. Adding a route to `ROUTES` and classifying it in the same change.
2. Writing or reviewing the `reason` on an `excluded-*` route.
3. Answering the PR template's Tri-Flow Architecture Check.
4. Deciding whether an exclusion is permanent or a parity gap.

## Do Not Use

1. Implementing a Capacitor plugin or native bridge (`mobile-plugin-contracts`).
2. Running device or simulator audits (`mobile-parity-audit`).
3. Generic frontend route placement (`frontend-surface-placement`).

## Read First

1. `docs/reference/mobile/tri-flow-parity.md`
2. `.codex/skills/tri-flow-parity/references/reason-contract.md`

## Workflow

1. Classify the route. `native-required-*` means the native shells must render
   it; `excluded-*` means they are not expected to.
2. A `native-required` route needs an `expectedMarker`; an `excluded-*` route
   needs a `reason` of at least 40 characters. The static gate fails on either.
3. Write the reason truthfully, distinguishing a permanent exclusion (a
   property of the route) from a gap (a property of the current native shell).
   For a gap, write `GAP, not a permanent exclusion` and name what closes it.
4. Judge the reason against `references/reason-contract.md` before accepting it.
   A plausible-sounding justification is worse than a blank field.
5. Re-run the static gate. It is fast and needs no device.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `mobile-native`.
2. If the work is implementing the native surface, use `mobile-plugin-contracts`.
3. If the work is verifying live native behaviour, use `mobile-parity-audit`.
4. If the route placement itself is in question, use `frontend-surface-placement`.

## Required Checks

```bash
cd hushh-webapp && node scripts/native/verify-native-static-parity.mjs
cd hushh-webapp && npm run verify:surface-map
```
