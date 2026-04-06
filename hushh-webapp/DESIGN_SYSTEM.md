# Hushh Frontend Design System

This file is the compact package-local entrypoint. The canonical design-system contract lives in:

1. `docs/reference/quality/design-system.md`
2. `docs/reference/quality/frontend-ui-architecture-map.md`
3. `docs/reference/quality/app-surface-design-system.md`
4. `docs/reference/quality/frontend-pattern-catalog.md`

## Layer Contract

| Layer | Location | Ownership |
|---|---|---|
| Stock primitives | `components/ui/*` | shadcn registry |
| Morphy UX | `lib/morphy-ux/*` | Hushh design-system root for primitives, tokens, motion, and surfaces |
| App surfaces | `components/app-ui/*` | Hushh semantic shell and shared app compositions |
| Labs | `app/labs/*`, `components/labs/*`, `lib/labs/*` | experimental only |

## Canonical Baseline

The current solved localhost/UAT shell is the production baseline:

1. High-contrast top-shell pills and action chips.
2. Shared ripple/focus/state-layer ownership for shell interactions.
3. Rounded segmented tabs with a clear active border and elevated highlight.
4. Neutral premium surfaces with shared tokens and no route-local chrome recipes.

## Rules

1. Use stock primitives by default.
2. Put reusable surface primitives, motion, and tokens in Morphy UX.
3. Put Hushh semantic shared compositions in `components/app-ui/*`, not `components/ui/*`.
4. Do not import labs into production routes without graduation.
5. Keep `components/ui/*` overwrite-safe.

## Verification

Run from `hushh-webapp`:

```bash
npm run verify:design-system
npm run verify:cache
npm run verify:docs
npm run audit:ui-surfaces
```

## Repo-Owned Skills

Project-local skills live under `.codex/skills/`:

1. `design-system`
2. `ui-migration`
3. `frontend-architecture`
4. `frontend-surface-governance`
- Badge/status in titles: use `inline-flex flex-wrap` to wrap gracefully
- Refresh buttons: `size="icon"` (circle) to stay compact
- Card shadows: reduced on mobile via `@media (max-width: 639px)` override

---

## 15. Motion & Animation

| Token | Value | Usage |
|-------|-------|-------|
| Standard ease | `cubic-bezier(0.2, 0, 0, 1)` | Material 3 standard |
| Emphasized ease | `cubic-bezier(0.2, 0, 0, 1)` | Page enters, primary |
| Spring ease | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Navbar indicator, tabs |
| Duration xs | 120ms | Micro-interactions |
| Duration md | 240ms | Standard transitions |
| Duration xl | 450ms | Page enter, reveals |

GSAP used for: page enter animations, feature rail trails, carousel deck focus.
CSS used for: tab indicators, button hover/active, navbar scroll-hide.
