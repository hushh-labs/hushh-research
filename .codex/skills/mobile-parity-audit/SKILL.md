---
name: mobile-parity-audit
description: Use when auditing mobile/native parity, release readiness, or platform-specific coverage across the Hushh app.
---

# Hushh Mobile Parity Audit Skill

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

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `mobile-native`.
2. If the audit isolates a plugin-contract issue, use `mobile-plugin-contracts`.
3. If the problem is actually broader quality or trust validation, route to `quality-contracts` or `security-audit`.

## Required Checks

```bash
cd hushh-webapp && npm run cap:build
cd hushh-webapp && npm run ios:test
```
