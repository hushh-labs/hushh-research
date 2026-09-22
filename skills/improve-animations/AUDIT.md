# Animation Audit Playbook

The eight audit categories, what to look for in each, and the exact target values to cite in findings and plans. Distilled from Emil Kowalski's design engineering philosophy ([emilkowal.ski](https://emilkowal.ski/)). Never approximate a value that appears here — copy it.

## 1. Purpose & frequency

Every animation must answer "why does this animate?" — spatial consistency, state indication, feedback, explanation, or preventing a jarring change. "It looks cool" on a frequently-seen element is not a purpose.

| Frequency | Decision |
| --- | --- |
| 100+ times/day (keyboard shortcuts, command palette toggle) | No animation. Ever. |
| Tens of times/day (hover effects, list navigation) | Remove or drastically reduce |
| Occasional (modals, drawers, toasts) | Standard animation |
| Rare / first-time (onboarding, feedback, celebrations) | Can add delight |

Hunt for: animations on keyboard-initiated actions, command palettes with open/close transitions (Raycast has none — correct), decorative motion on list items or hover states hit constantly. The strongest fix is often **delete the animation**.

## 2. Easing & duration

Decision order for easing:

- Entering or exiting → **`ease-out`** (starts fast, feels responsive)
- Moving / morphing on screen → **`ease-in-out`**
- Hover / color change → **`ease`**
- Constant motion (marquee, progress) → **`linear`**
- Default → **`ease-out`**

**`ease-in` on UI is always a finding** — it starts slow, delaying the exact moment the user is watching. Built-in CSS easings are too weak for deliberate motion; plans should introduce strong custom curves (as tokens, matching repo conventions):

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);        /* strong ease-out for UI */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);    /* strong ease-in-out for on-screen movement */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);     /* iOS-like drawer curve */
```

Duration budgets — **Hushh UI Hard 150ms Ceiling**:

Across Hushh product surfaces, all interactive feedback, modal presentations, drawers, sheets, dropdowns, and segmented pills are hard-capped at **$\le 150\text{ms}$** maximum duration. Durations $>150\text{ms}$ on interactive UI elements are an immediate finding.

| Element | Target Duration | Easing Curve |
| --- | --- | --- |
| Button press feedback (`:active`) | 75–100ms | `var(--motion-ease-decelerate)` |
| Segmented pill crossfade / slide | 100–125ms | `var(--motion-ease-standard)` |
| Tooltips, dropdowns, popovers | 100–140ms | `var(--motion-ease-decelerate)` |
| Modals, sheets, history drawer | 125–150ms | `cubic-bezier(0.23, 1, 0.32, 1)` |
| Route transition crossfade | 60ms exit + 90ms enter (150ms total) | `cubic-bezier(0.16, 0.84, 0.28, 1)` |

Hunt for: Any duration $> 150\text{ms}$ on UI surfaces, `ease-in` anywhere, bare `linear` transitions on entrances, and non-composited transitions.

## 3. Physicality & origin

- **Never `scale(0)`** — nothing in the real world appears from nothing. Target: `scale(0.9–0.97)` + `opacity: 0`.
- **Popovers/dropdowns/tooltips scale from their trigger**, not center:
  ```css
  .popover { transform-origin: var(--transform-origin); } /* Base UI */
  ```
  **Modals are exempt** — they appear centered; `transform-origin: center` is correct there. Do not report it.
- **Press feedback**: `transform: scale(0.97)` on `:active` with `transition: transform 100ms ease-out`. Keep it subtle (0.95–0.98).

Verify runtime timers as well as CSS: route exit/enter timers must match the
60ms/90ms CSS tokens, and sheet drag settlement must respect the 150ms ceiling
and reduced motion. Token values alone do not prove all consumers comply.
Continuous loading indicators are not interaction latency; do not accelerate
their loops to 150ms. Measure dropped frames separately before claiming FPS.

Hunt for: `scale(0)`, pure-fade entrances with no initial transform, `transform-origin: center` (or none) on trigger-anchored elements, pressable elements with no press feedback.

## 4. Interruptibility

CSS **transitions** retarget from the current state mid-animation; **keyframes** restart from zero. Anything triggered rapidly or reversible mid-motion (toasts stacking, toggles, drags, expand/collapse) must use transitions or springs.

- Entry without JS: `@starting-style` (legacy fallback: a `data-mounted` attribute set in `useEffect`).
- Gesture-driven motion should use springs — they carry velocity when interrupted.
- Spring configs for finite Hushh UI interactions must settle within the same
  150ms envelope: `{ type: "spring", duration: 0.12, bounce: 0.15 }`. Keep
  bounce subtle and reserve it for interruptible gesture feedback; use a plain
  transform/opacity transition when a spring would obscure the timing contract.
- **Asymmetric timing**: deliberate phases (press, hold, destructive confirm) animate slower; the system's response snaps. Symmetric timing on press-and-release is a finding.

Hunt for: `@keyframes` on toasts/toggles/rapidly-triggered UI, gesture handlers that tween with fixed-duration keyframes, drags without velocity-based dismissal (dismiss on `Math.abs(distance)/elapsedMs > ~0.11`, not distance thresholds alone), hard stops at drag boundaries instead of rising friction.

## 5. Performance

- **Animate `transform` and `opacity` only.** `width`/`height`/`margin`/`padding`/`top`/`left` trigger layout + paint + composite.
- **`transition: all`** animates unintended properties off-GPU — always a finding.
- **Framer Motion `x`/`y`/`scale` shorthands are not hardware-accelerated** — they run on the main thread and drop frames under load. Target: the full transform string, `animate={{ transform: "translateX(100px)" }}`.
- **Don't drive child transforms via a CSS variable on the parent** — it recalcs styles for all children. Set `transform` directly on the element.
- CSS (and WAAPI) beat rAF-based JS under load — use CSS for predetermined motion, JS/springs for dynamic and gesture-driven motion.
- Keep transition-time `filter: blur()` under 20px — heavy blur is expensive, especially in Safari.

Hunt for: `transition: all`, animated layout properties, Framer Motion shorthand props on busy pages, `setProperty('--x', …)` driving child transforms, rAF loops doing what CSS could.

**JavaScript engines (what a CSS scan cannot see).** On WKWebView these
cost every frame in the app, not just the animated element. Hunt for:

- `documentElement.style.setProperty("--…")` from a scroll, pointer or
  `requestAnimationFrame` handler: a document-wide style invalidation per
  write. The fix is to write on the element that consumes the value
  (`lib/navigation/top-shell-tab-swipe-progress.ts` is the pattern).
- `new MutationObserver(...).observe(document.body, { subtree: true })`: it
  wakes on every streamed token and marker move. Check whether the engine's
  output is even consumed before rewriting it; the ambient chrome tint wrote
  four variables sixty times a second that nothing read.
- `addEventListener("touchmove", …, { passive: false })` on `window` or
  `document`: WebKit then waits for the main thread on every scroll frame.
- `setState` from an audio-level, scroll-progress or streaming-token
  callback: a React render per frame. Move the value to a CSS variable
  written from the loop or to a leaf `useSyncExternalStore` store.
- `[class*="…"] { will-change }` and any unconditional `will-change` on a
  `fixed` overlay: held compositor layers.
- Recharts series without `isAnimationActive`: 1500ms of SVG interpolation
  per data change.
- `read → write → read` of layout inside one scroll handler
  (`getBoundingClientRect` after `style.setProperty`): a forced reflow.

`cd hushh-webapp && npm run verify:render-performance` finds all of these
statically; `?perf=1` (web) or `-CapacitorStorage.hushh_perf_probe 1` (iOS
launch argument) measures them. Bar and instruments:
`docs/reference/mobile/render-performance-charter.md`.

## 6. Accessibility

```css
@media (prefers-reduced-motion: reduce) {
  .element { animation: fade 0.2s ease; } /* keep opacity/color, drop movement */
}
@media (hover: hover) and (pointer: fine) {
  .element:hover { transform: scale(1.05); } /* touch fires false hovers on tap */
}
```

Reduced motion disables nonessential presentation animation. Keep essential
state feedback readable (for example opacity or color), remove positional
movement and decorative sequencing, and never delay access to the next action.
In JS: `useReducedMotion()` and branch transform values.

Hunt for: movement with no `prefers-reduced-motion` handling, ungated `:hover` motion, reduced-motion implementations that nuke all feedback.

## 7. Cohesion & tokens

- Motion should match the product's personality — playful can be bouncier, a dashboard stays crisp. Mismatched personality across components is a finding.
- Curves and durations should live as shared tokens. Five hand-typed cubic-beziers that almost match is a consolidation finding.
- Avoid stagger on application chrome and interaction-critical surfaces. Rare
  first-run decoration may use a small stagger only when the complete sequence
  still settles within 150ms and the stagger never blocks interaction.
- A jarring crossfade that shows two overlapping states can be masked with subtle `filter: blur(2px)` during the transition.

Hunt for: duplicated near-identical easings/durations, one bouncy component in a crisp app, list/grid entrances with no stagger, crossfades that visibly double-expose.

## 8. Missed opportunities

The additive category — places that don't animate but should:

- State changes that teleport (content swaps, layout jumps) where a brief transition would prevent a jarring change.
- Spatially-connected UI (a panel that appears from a trigger) with no motion explaining where it came from.
- Rare, high-emotion moments (first-run, success, celebration) rendered with none of the delight budget they're allowed.
- `translate` percentages (`translateY(100%)` = element's own height) and `clip-path: inset()` reveals as tools for these — no hardcoded pixel offsets.

Report at most a handful, grounded in actual UX seams you observed — not a wishlist.
