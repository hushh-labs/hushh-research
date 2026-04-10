---
name: frontend-design-system
description: Use when changing Hushh UI architecture, shared components, shell chrome, or styling rules inside the frontend owner family.
---

# Hushh Frontend Design System Skill

## Purpose and Trigger

- Primary scope: `frontend-design-system`
- Trigger on shared UI architecture, reusable surface primitives, shell chrome, styling rules, and design-system policy changes.
- Avoid overlap with `frontend-architecture` and `frontend-surface-placement`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `frontend`

Owned repo surfaces:

1. `hushh-webapp/components/ui`
2. `hushh-webapp/lib/morphy-ux`
3. `hushh-webapp/components/app-ui`
4. `docs/reference/quality/design-system.md`

Non-owned surfaces:

1. `frontend`
2. `mobile-native`
3. `docs-governance`

## Do Use

1. Shared component and shell-chrome work.
2. Morphy UX, app-ui, and stock UI ownership decisions driven by design-system semantics.
3. Design-system rule changes that require docs and verification updates.

## Do Not Use

1. Broad frontend intake where the correct spoke is still unclear.
2. Native plugin or mobile parity work.
3. Route-contract and package-convention work without a design-system rule change.

## Read First

1. `docs/reference/quality/design-system.md`
2. `docs/reference/quality/frontend-ui-architecture-map.md`
3. `docs/reference/quality/app-surface-design-system.md`
4. `docs/reference/quality/frontend-pattern-catalog.md`

## Workflow

1. Read the design-system and frontend-ui architecture docs before touching shared UI code.
2. Decide the owning layer first: stock UI, Morphy UX, or app-ui.
3. Keep route-container ownership with `AppPageShell` or `FullscreenFlowShell`.
4. Update docs or verification commands in the same change when the rule itself changes.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `frontend`.
2. If the question is primarily about route contracts or verification ownership, use `frontend-architecture`.
3. If the question is primarily about file placement or layer ownership, use `frontend-surface-placement`.
4. If the request begins as a cross-domain scan, start with `repo-context`.

## Required Checks

```bash
cd hushh-webapp && npm run verify:design-system
cd hushh-webapp && npm run verify:cache
cd hushh-webapp && npm run verify:docs
cd hushh-webapp && npm run typecheck
```
