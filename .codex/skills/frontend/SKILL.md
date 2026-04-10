---
name: frontend
description: Use when the request is broadly about the Hushh web frontend and the correct frontend specialist skill is not yet clear.
---

# Hushh Frontend Skill

## Purpose and Trigger

- Primary scope: `frontend-intake`
- Trigger on broad frontend requests across routes, components, services, contracts, and frontend verification where the correct spoke is not yet obvious.
- Avoid overlap with `mobile-native`, `docs-governance`, and `repo-context`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `frontend`

Owned repo surfaces:

1. `hushh-webapp/app`
2. `hushh-webapp/components`
3. `hushh-webapp/lib`
4. `hushh-webapp/__tests__`
5. `hushh-webapp/scripts`

Non-owned surfaces:

1. `hushh-webapp/ios`
2. `hushh-webapp/android`
3. `docs-governance`

## Do Use

1. Broad frontend intake before the correct spoke is clear.
2. Requests that cut across route contracts, UI ownership, service boundaries, and frontend verification.
3. Choosing whether work belongs in design-system, architecture, or surface-placement specialists.

## Do Not Use

1. Native-only plugin or parity work.
2. Backend, trust, or operational work outside the web frontend.
3. Broad repo mapping before the domain itself is known.

## Read First

1. `docs/reference/quality/frontend-ui-architecture-map.md`
2. `docs/reference/quality/design-system.md`
3. `hushh-webapp/components/README.md`
4. `hushh-webapp/lib/services/README.md`

## Workflow

1. Read the frontend architecture and design-system docs before narrowing the task.
2. Decide whether the work belongs to `frontend-design-system`, `frontend-architecture`, or `frontend-surface-placement`.
3. Route native-only concerns to `mobile-native`.
4. Keep route and verification changes aligned with existing package scripts and contracts.

## Handoff Rules

1. Route shared visual-system work to `frontend-design-system`.
2. Route route contracts, package conventions, and verification ownership to `frontend-architecture`.
3. Route file-placement and layer-boundary work to `frontend-surface-placement`.
4. If the task becomes native-only, route it to `mobile-native`.
5. If the task begins as a cross-domain scan, start with `repo-context`.

## Required Checks

```bash
cd hushh-webapp && npm run verify:docs
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run verify:routes
```
