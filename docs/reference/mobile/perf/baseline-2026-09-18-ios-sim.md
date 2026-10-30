# Render performance baseline: iOS simulator, 2026-09-18

## Visual Context

Canonical visual owner: [Mobile Reference Index](../README.md); the measurement flow and the bar are in [render-performance-charter.md](../render-performance-charter.md), and this page is one dated reading beneath them.

**Attribution only. This run certifies nothing.** iPhone 16e simulator (renders
through the Mac's GPU), Debug build (`-Onone`), signed in as the reviewer with
the vault unlocked through `-UITestMode`, which also runs the native 350ms
status poll (a known contaminant of this lane). Three launches (feed, Finance,
Location), the fixed gesture card driven by XCUITest, in-app probe on
(`-CapacitorStorage.hushh_perf_probe 1`). Reproduce with
`cd hushh-webapp && npm run perf:ios:card`.

What the native engine reported about itself: Event Timing is supported, Long
Tasks and Long Animation Frames are not (so the frame interval is the primary
signal on the phone, as the charter says); the boot probe read ~51 Hz while the
page was still loading and snapped to a 60 Hz budget (16.7 ms).

Captured 2026-09-19T04:22:24.334Z at 93156050d. **Simulator run: attribution only, certifies nothing.** rAF 51.2 Hz (nominal 60, budget 16.7 ms); engine iPhone AppleWebKit/605.

| Gesture | Windows | Frames | p95 ms (median) | p99 ms (median) | Worst ms | Frames > 50 ms | Hitch ms/s (median) | Verdict |
|---|---|---|---|---|---|---|---|---|
| feed-flick | 30 | 2845 | 19 | 22 | 80 | 15 | 17.3 | critical |
| bottom-nav-switch | 6 | 493 | 19 | 28 | 39 | 0 | 19.8 | critical |
| profile-pane-open-dismiss | 4 | 356 | 18 | 25 | 36 | 0 | 15.6 | critical |
| chat-stream-30s | 2 | 87 | 30.5 | 37 | 55 | 2 | 66.9 | critical |
| top-shell-pager-swipe | 6 | 546 | 18 | 24 | 30 | 0 | 0 | warning |
| kai-chart-flick | 9 | 610 | 51 | 59 | 438 | 29 | 120.7 | critical |
| location-map-pan | 11 | 1390 | 17 | 20 | 28 | 0 | 0 | warning |

Idle (no gesture in flight), by route:

| Route | Frames | p95 ms | Worst ms | Frames > 50 ms |
|---|---|---|---|---|
| idle:/login/ | 100 | 33 | 110 | 1 |
| idle:/one/feed/ | 1469 | 18 | 148 | 2 |
| idle:/one/ | 181 | 18 | 26 | 0 |
| idle:/one/connect/ | 380 | 18 | 31 | 0 |
| idle:/ria/onboarding/ | 2855 | 17 | 68 | 1 |
| idle:/login/ | 27 | 32 | 34 | 0 |
| idle:/one/kai/ | 1646 | 17 | 309 | 4 |
| idle:/login/ | 43 | 35 | 108 | 1 |
| idle:/one/location/ | 690 | 17 | 190 | 3 |


## Reading it

- **Kai chart flick** is the worst surface by a wide margin: p95 51 ms, a 438 ms
  frame, 29 frames over 50 ms in nine windows. Attribute first (Web Inspector
  Timelines on `/one/kai?tab=analysis`): candidates are the Recharts mount and
  data-change work on the analysis pane and the sparkline strip. The chart
  animation default was switched off in 5edf48abd; this run is on the same
  commit, so what remains is layout and paint cost, not animation.
- **Feed flick**: 15 frames over 50 ms across 30 windows, p95 19 ms. The known
  seams are the top bar's per-scroll `<html>` write plus forced reflow and the
  unmemoised, unvirtualised rows (Wave 2 items 7 and 10).
- **Chat stream**: only 87 frames landed inside the gesture window; the typed
  prompt may not have sent on the simulator (the probe's idle bucket for `/one`
  holds 181 frames at p95 18). Treat as not measured until the composer send is
  confirmed on the next run.
- **Pager swipe, profile pane, map pan, bottom nav**: no frames over 50 ms, p95
  within 1 to 2 ms of the 60 Hz budget on a Debug simulator build. These are
  already close; the phone run decides whether they pass.
- The idle buckets show what a screen costs when nothing is touched: the login
  screen sits at p95 32 to 35 ms (its constellation and aurora animations), and
  `/one/kai` idle shows a 309 ms frame.

## Caveats that make this attribution, not sign-off

1. Simulator GPU and refresh; the bar is judged on a phone.
2. Debug configuration; Release is roughly a different app for JavaScript cost.
3. The `-UITestMode` bootstrap runs `evaluateJavaScript` every 350 ms.
4. Three runs per gesture were driven, but this table pools the windows rather
   than reporting run medians; the phone protocol reports the median of three.
5. The "Feed" bottom-nav label was not found by accessibility name in this
   build, so the nav loop ran One -> Connect only.

## Next

1. Web Inspector attribution on `/one/kai?tab=analysis` and `/one/feed` (Debug
   build is already inspectable).
2. Land Wave 2 items 7 (top bar), 8 (bottom chrome) and 10 (feed rows); rerun
   this card for before/after on the same simulator.
3. Phone hand-over: `IOS_DEVICE_ID=<udid> HUSHH_PERF_TIER=ios-<tier>-<year> npm run perf:ios:card`
   on a Release-configured build, test mode off, with `xctrace` Animation
   Hitches attached, for the certifying numbers.
