---
name: design-system
description: Use when changing Hushh UI architecture, shared components, shell chrome, or styling rules. Follow the repo’s stock shadcn -> Morphy UX -> app-ui layering contract, the labs boundary, and the verification scripts before making UI changes.
---

# Hushh Design System Skill

Use this skill for any shared frontend UI work.

## Source of truth

Read these first:

1. `docs/reference/quality/design-system.md`
2. `docs/reference/quality/frontend-ui-architecture-map.md`
3. `docs/reference/quality/app-surface-design-system.md`
4. `docs/reference/quality/frontend-pattern-catalog.md`

## Layer rules

1. `components/ui/*` is stock shadcn only.
2. `lib/morphy-ux/*` is the standalone design-system root for ripple, motion, tokens, reusable surface primitives, and shared segmented controls.
3. `components/app-ui/*` owns Hushh semantic surfaces such as shell chrome, settings rows, and shared app-level compositions built from Morphy primitives.
4. `app/labs/*`, `components/labs/*`, and `lib/labs/*` are experimental and do not define production Kai UI.
5. `AppPageShell` and `FullscreenFlowShell` own route width and gutter behavior. Feature files should not introduce outer `max-w-* mx-auto px-*` wrappers unless the docs explicitly justify it.
6. Header accents must come from the shared semantic map, not raw route-local color recipes.

## Decision rules

1. Default to stock primitives.
2. Use Morphy when the change belongs to reusable design-system behavior, surface primitives, or the shared segmented-control contract.
3. Create or extend app-ui when the surface is semantic and shared across routes.
4. Do not invent feature-local primitives when a shared app-ui surface should exist.
5. Use `reading`, `standard`, and `expanded` shell widths instead of Tailwind-sized width language.

## Required checks

From `hushh-webapp`:

```bash
npm run verify:design-system
npm run verify:cache
npm run verify:docs
npm run typecheck
```

Run `npm run audit:ui-surfaces` when touching wrappers, shell primitives, or cleanup work.
