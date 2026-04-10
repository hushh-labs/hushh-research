---
name: frontend-surface-placement
description: Use when deciding whether frontend code belongs in Morphy UX, app-ui, or a feature folder inside the frontend owner family.
---

# Hushh Frontend Surface Placement Skill

## Purpose and Trigger

- Primary scope: `frontend-surface-placement`
- Trigger on deciding whether frontend code belongs in Morphy UX, app-ui, a feature folder, or labs.
- Avoid overlap with `frontend-design-system` and `frontend-architecture`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `frontend`

Owned repo surfaces:

1. `hushh-webapp/components/app-ui`
2. `hushh-webapp/lib/morphy-ux`
3. `hushh-webapp/components/kai`
4. `hushh-webapp/components/ria`

Non-owned surfaces:

1. `frontend`
2. `mobile-native`
3. `docs-governance`

## Do Use

1. File-placement and layer-ownership decisions for shared frontend code.
2. Auditing whether a new surface should be promoted into shared UI rather than staying feature-local.
3. Protecting the single card, surface, and route-container system from parallel implementations.

## Do Not Use

1. Broad frontend intake where the correct spoke is still unclear.
2. Visual-system changes where the owning layer is already clear.
3. Native plugin or route-contract work that belongs elsewhere.

## Read First

1. `hushh-webapp/lib/morphy-ux/README.md`
2. `hushh-webapp/components/app-ui/README.md`
3. `docs/reference/quality/design-system.md`
4. `docs/reference/quality/frontend-ui-architecture-map.md`

## Workflow

1. Decide whether the change owns primitives, semantic shared surfaces, feature-local composition, or labs exploration.
2. Keep primitive behavior in Morphy UX, semantic shared surfaces in app-ui, and feature mapping in feature folders.
3. Promote repeated feature-local patterns into the correct shared layer instead of cloning them.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `frontend`.
2. If the task changes the visual-system rules themselves, use `frontend-design-system`.
3. If the task changes route governance or verification ownership, use `frontend-architecture`.
4. If the task begins as a cross-domain scan, start with `repo-context`.

## Required Checks

```bash
cd hushh-webapp && npm run audit:ui-surfaces
cd hushh-webapp && npm run verify:design-system
cd hushh-webapp && npm run verify:docs
cd hushh-webapp && npm run typecheck
```
