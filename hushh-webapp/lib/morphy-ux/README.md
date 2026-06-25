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

## Motion system (single source of truth)

All motion in the app is driven by CSS custom properties declared once in
`app/globals.css` and mirrored in `motion.ts`. Never hand-pick durations or
easings in a component — reference the tokens so the whole app shares one frame.

### Tokens

- Durations: `--motion-duration-xs|sm|md|lg|xl|xxl` (120 → 600ms).
- Easings: `--motion-ease-standard|accelerate|decelerate|emphasized`.
- Overlay set (dialog/popover/sheet/menu/tooltip):
  - `--motion-overlay-enter-duration` / `--motion-overlay-enter-ease`
    (decelerate — surfaces settle in).
  - `--motion-overlay-exit-duration` / `--motion-overlay-exit-ease`
    (slightly quicker accelerate — dismissal stays responsive, never snaps).

### Rules

1. **Enter and exit are both first-class.** Every appearing element must also
   define its disappearing animation. Open/close are symmetric: if open slides
   from a side, close slides back to that side.
2. **Open = decelerate, close = accelerate.** Close is a touch faster than open
   so dismissal feels crisp without reading as a hard cut.
3. **Animate only `opacity` and `transform`** so frames stay GPU-composited.
4. **One driver per concern.** Overlay enter/exit is centralized in globals.css
   under "UNIFORM OVERLAY MOTION" via the Radix `data-slot` + `data-state`
   attributes — components keep their directional `slide-*`/`zoom-*` utilities
   but inherit uniform duration + easing. Do not re-specify timing per overlay.
5. **Scrims fade with their surface.** Dialog/sheet/drawer/alert-dialog put the
   blur/tint on the Radix `*-overlay` (which owns the open/close lifecycle), not
   a static sibling `<div>` — otherwise the backdrop vanishes instantly and the
   surface looks like it snaps shut.
6. **Respect `prefers-reduced-motion`.** Every motion block has a reduced-motion
   guard that collapses animation to ~0ms.

### Route transitions

Page navigation is a crossfade, matching hussh-wiki / hushh-search-console:

- `usePageEnterAnimation` (GSAP) owns the staggered **enter** reveal per route.
- `useRouteTransition` owns the **exit**: it intercepts internal link clicks,
  sets `data-route-transition` on `<html>` (`idle` → `pending` → `entering`),
  fades the current page out, then pushes the route. CSS for this lives in
  globals.css under "UNIFORM ROUTE TRANSITION" and targets the app shell content
  node (`[data-app-shell-content="true"]`).
- Opt a link out of the crossfade with `data-no-route-transition="true"`.
