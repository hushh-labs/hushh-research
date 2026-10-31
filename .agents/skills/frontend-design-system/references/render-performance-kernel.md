# Render Performance Kernel

Frame pacing is a contract, not an audit. The bar in numbers, the in-app
probe, the native instruments and the gesture card live in
`docs/reference/mobile/render-performance-charter.md`; this is the working
rule set a surface inherits when it is built.

## Every new surface

1. Animates only `transform` and `opacity`. Height, width, top, left, margin
   and padding relayout every frame; use a transform or `grid-template-rows`.
2. Never writes a custom property on `<html>` per frame. A write there
   invalidates style for the whole document; write on the element that
   consumes the value, as `lib/navigation/top-shell-tab-swipe-progress.ts` does.
3. Never registers a non-passive `touchmove`/`touchstart`/`wheel` listener on
   `window` or `document`. WebKit then waits for the main thread on every
   scroll frame in the app. `touch-action` on the scroll root refuses a pan.
4. Never watches `document.body` with a subtree `MutationObserver`. It wakes
   on every streamed token and marker move; observe the owning element or use
   explicit triggers (route settle, theme flip, resize, scroll idle).
5. Sets `will-change` only for the gesture that needs it, and clears it after.
   No wildcard selectors, no permanent `will-change` on a fixed overlay.
6. Never drives a React state update from an audio, scroll or streaming
   frame. A CSS variable written from the loop, or a leaf store with
   `useSyncExternalStore`, carries per-frame values; React commits at
   boundaries. `components/agent/agent-voice-waveform.tsx` is the pattern.
7. Passes `CHART_ANIMATION_ACTIVE` (from `components/ui/chart.tsx`) to every
   Recharts series and `CHART_TOOLTIP_TRIGGER` to every Recharts tooltip; the
   defaults are a 1500ms animation on mount and on each data change, and a
   tooltip that re-renders the chart on every touch frame of a flick.
8. Takes any z-index from the `--z-*` ladder in `app/globals.css`: transient
   menus above dialogs above sheets above chrome. A menu that opens behind a
   sheet is a ladder bug, never a reason for a new number.
9. Uses the `.motion-step-enter` utility or the single route transition; no
   second motion engine, no per-node GSAP on high-churn surfaces.

## Proving it

- `cd hushh-webapp && npm run verify:render-performance` refuses a violation;
  the allowlist beside it carries today's debt and only shrinks
  (`--write-allowlist` after paying debt down; `// perf-lint: allow <rule> -- <reason>`
  for a justified site).
- A change to the shell scroll engines, sheets, streaming or the chrome masks
  ships with before/after numbers from the in-app probe: `?perf=1` on the
  web, `-CapacitorStorage.hushh_perf_probe 1` as an iOS launch argument;
  `window.__hushhPerf.export()` returns the JSON.
- Simulator numbers attribute; a phone certifies. The sign-off report is a
  dated file under `docs/reference/mobile/perf/`.

## Do not touch

The Keyboard `resize: "none"` contract and `--kb-height`, `ios.scrollEnabled:
false` and the DOM scroll root, the motion duration tokens, the single route
transition engine, and `SwipeViews` as the only pager. Each is load-bearing
and documented where it lives.
