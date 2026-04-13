---
name: frontend-architecture
description: Use when changing Hushh frontend structure, route contracts, package-level conventions, or frontend verification ownership.
---

# Hushh Frontend Architecture Skill

## Purpose and Trigger

- Primary scope: `frontend-architecture`
- Trigger on frontend structure, route contracts, package conventions, shared frontend governance rules, and verification ownership.
- Avoid overlap with `frontend-design-system` and `frontend-surface-placement`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `frontend`

Owned repo surfaces:

1. `hushh-webapp/lib/navigation`
2. `hushh-webapp/scripts/architecture`
3. `hushh-webapp/package.json`
4. `docs/reference/architecture/route-contracts.md`

Non-owned surfaces:

1. `frontend`
2. `mobile-native`
3. `docs-governance`

## Do Use

1. Route-container and route-contract work.
2. Frontend package-script and verification ownership changes.
3. Shared frontend structure and governance decisions affecting multiple routes or folders.

## Do Not Use

1. Broad frontend intake where the correct spoke is still unclear.
2. Purely visual design-system work where structure is not changing.
3. Native-only plugin or parity work.

## Read First

1. `hushh-webapp/package.json`
2. `scripts/ci/web-check.sh`
3. `docs/reference/operations/ci.md`
4. `docs/reference/quality/frontend-ui-architecture-map.md`
5. `docs/reference/architecture/route-contracts.md`

## Workflow

1. Inspect current package scripts, route contracts, and frontend docs before changing structure.
2. Keep CI and local package verification aligned when adding or changing frontend rules.
3. Centralize route-container behavior in `AppPageShell` or `FullscreenFlowShell`.
4. Keep signed-in route families covered by the contract-driven browser sweep.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `frontend`.
2. If the task is shared visual-system ownership, use `frontend-design-system`.
3. If the task is deciding where code belongs between layers, use `frontend-surface-placement`.
4. If the task begins as a cross-domain scan, start with `repo-context`.

## Required Checks

```bash
cd hushh-webapp && npm run verify:docs
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run verify:routes
```
