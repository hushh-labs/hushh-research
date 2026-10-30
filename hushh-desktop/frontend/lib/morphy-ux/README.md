# Morphy UX

Morphy UX is the frontend design-system root for reusable UI primitives and interaction behavior.

## Owns

- design tokens
- shared card and surface primitives
- motion helpers
- ripple/state layers
- reusable low-level UI utilities

## Does not own

- app shell composition
- route-level page chrome
- feature-local UI structure

Those stay in:

- `hushh-webapp/components/app-ui/*` for semantic shared app composition
- `hushh-webapp/components/<feature>/*` for feature composition

## Start Here

- `card.tsx`
- `surfaces.tsx`
- `button.tsx`
- `motion.ts`
- `tokens/*`
