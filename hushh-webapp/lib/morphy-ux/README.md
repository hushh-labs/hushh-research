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

Page navigation is a single, app-wide crossfade — **every** screen-to-screen
switch shares the exact same frame (the `/one → /one/*` feel), regardless of how
the navigation was triggered. There is exactly **one** route-transition engine;
do not add a second (no framer-motion `template.tsx`, no View Transitions API,
no per-route motion). Both halves are mounted once in `app/providers.tsx` around
the shared shell content node and wrap `{children}` for every route + chrome
mode.

- `usePageEnterAnimation` (GSAP) owns the staggered **enter** reveal per route.
- `useRouteTransition` owns the **exit** crossfade and drives a single
  `data-route-transition` attribute on `<html>` (`idle` → `pending` →
  `entering`). CSS lives in globals.css under "UNIFORM ROUTE TRANSITION" and
  targets the app shell content node (`[data-app-shell-content="true"]`);
  timing/easing come from the `--motion-route-exit/enter-*` tokens.

**How uniformity is achieved (the layout-level chokepoint).** Three entry
points feed the same envelope so no call site needs special handling:

1. **Link clicks** — a capture-phase click interceptor catches same-origin `<a>`
   navigations and starts the exit beat at the earliest possible moment (before
   React re-renders), then pushes the route.
2. **All programmatic navigation** — `useRouteTransition` patches the History
   API (`history.pushState` / `history.replaceState`) **once**. Next.js App
   Router routes every `router.push` / `router.replace` through those two
   methods, so this single patch gives all programmatic navigations (bottom nav,
   tab bars, top app bar, buttons, onboarding handlers, voice/agent runtimes,
   auth guards/redirects — ~185 call sites) the same exit→enter crossfade
   without editing any of them. The patch runs the exit beat, then defers the
   real history mutation by one exit beat. A `transitionInFlight` re-entrancy
   flag ensures the deferred real call (and the click interceptor's own
   `router.push`) passes straight through instead of opening a second envelope.
3. **Browser back/forward** — the resolved-pathname effect plays the **enter**
   beat once the route settles (the outgoing frame is already gone on a real
   history pop).

The crossfade is reserved for REAL screen switches — i.e. the **pathname**
changes. Same-pathname writes (shallow query-string state like `?panel=`,
`?focus=`, `?tab=`, consent-sheet open/close, scroll sync, and Next.js' own
internal `replaceState` housekeeping) pass through instantly and never fade.
Animating those in-place updates is what made other routes feel abnormal/janky,
so both entry points (link interceptor + History patch) share this one select
check. The enter beat is owned by the resolved-pathname effect (the
authoritative "new route mounted" signal), so it fires once, at the right time,
without double-firing on shallow updates.

- Opt a link out of the crossfade with `data-no-route-transition="true"`.
- Reduced-motion users skip the exit entirely (CSS no-ops + the patch passes
  navigations through immediately).
- **Never reach for a parallel animation system** to "fix" a screen that feels
  like a hard cut. If a navigation doesn't crossfade, it's because it bypassed
  `router`/`<a>` (e.g. a raw `location.assign`) — route it through `router`
  instead. Keep `EXIT_MS`/`ENTER_MS` in `use-route-transition.ts` in sync with
  the `--motion-route-exit/enter-duration` tokens in globals.css.
