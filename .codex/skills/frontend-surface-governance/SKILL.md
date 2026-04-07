---
name: frontend-surface-governance
description: Use when deciding whether a frontend file belongs in Morphy UX, app-ui, or a feature folder. Keep the shared card system, design tokens, and semantic boundaries modular and traceable.
---

# Frontend Surface Governance Skill

Use this skill for frontend structure and placement decisions before adding or moving shared UI.

## Canonical sources

1. `hushh-webapp/lib/morphy-ux/*`
2. `hushh-webapp/components/app-ui/*`
3. `docs/reference/quality/design-system.md`
4. `docs/reference/quality/frontend-ui-architecture-map.md`
5. `docs/reference/quality/app-surface-design-system.md`

## Placement rules

1. Put reusable design-system primitives in `lib/morphy-ux/*`.
2. Put semantic app-level compositions in `components/app-ui/*`.
3. Put route-specific or domain-specific composition in feature folders.
4. Do not create a second shared card, surface, or segmented-tab system outside Morphy UX.
5. Do not create a second route-container system outside `AppPageShell` / `FullscreenFlowShell`.

## Decision rubric

Choose `lib/morphy-ux/*` when the change owns:
1. tokens
2. primitive surface shells
3. motion helpers
4. reusable interaction/state layers
5. shared segmented controls

Choose `components/app-ui/*` when the change owns:
1. app shell chrome
2. semantic page sections
3. shared product-level compositions built from Morphy primitives
4. route-width and gutter rules
5. shared header accent contracts

Choose `components/<feature>/*` when the change owns:
1. feature data mapping
2. route-local composition
3. domain-specific content structure

## Required checks

From `hushh-webapp`:

```bash
npm run audit:ui-surfaces
npm run verify:design-system
npm run verify:docs
npm run verify:cache
npm run typecheck
```
