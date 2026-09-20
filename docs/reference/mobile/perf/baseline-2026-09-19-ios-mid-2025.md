# Render performance baseline: iPhone (ios-mid-2025), 2026-09-19

## Visual Context

Canonical visual owner: [Mobile Reference Index](../README.md); the measurement flow and the bar are in [render-performance-charter.md](../render-performance-charter.md), and this page is one dated reading beneath them.

The first reading from a physical phone (60 Hz panel, iOS 27), and the first
side-by-side with Threads on the same phone.

**Two lanes, stated plainly.**

- **Truth lane: certifying.** Release build (`ENABLE_TESTABILITY=YES`, which
  keeps `-O`), test mode off, the founder's own account, each surface its own
  launch with the probe and a route argument, the vault unlocked by the test
  with the passphrase method. No reviewer bridge, no native status poll.
  Reproduce: `PERF_ATTACHED=1 PERF_CONFIGURATION=Release IOS_DEVICE_ID=<udid> HUSHH_PERF_TIER=ios-mid-2025 npm run perf:ios:card`.
  These are the numbers held against the bar.
- **Gesture card: attribution only.** Debug build, signed in as the reviewer
  through `-UITestMode` (native status poll every 350 ms, XCUITest snapshots).
  Kept below for the lane-overhead comparison.

## Truth lane (Release, test mode off, certifying)

Captured 2026-09-20T05:51:36Z at 85007a81f. rAF 59.8 Hz (nominal 60, budget
16.7 ms); engine iPhone AppleWebKit/605. Three reps each, median.

| Gesture | Windows | Frames | p95 ms (median) | p99 ms (median) | Worst ms | Frames > 50 ms | Hitch ms/s (median) | Verdict |
|---|---|---|---|---|---|---|---|---|
| feed-flick | 30 | 2739 | 18.5 | 35 | 76 | 16 | 30.3 | critical |
| bottom-nav-switch | 9 | 742 | 21 | 45 | 49 | 0 | 51.8 | critical |
| profile-pane-open-dismiss | 6 | 448 | 17.5 | 34 | 35 | 0 | 22.4 | critical |
| top-shell-pager-swipe | 6 | 546 | 18 | 34.5 | 38 | 0 | 24.7 | critical |
| kai-chart-flick | 9 | 643 | 43 | 81 | 83 | 13 | 215.4 | critical |
| location-map-pan | 9 | 755 | 18 | 30 | 31 | 0 | 18.9 | critical |
| chat-stream-30s | - | - | - | - | - | - | - | not in this lane yet |

Idle (no gesture in flight), by route, same lane:

| Route | Frames | p95 ms | Worst ms | Frames > 50 ms |
|---|---|---|---|---|
| idle:/one/feed/ | 9419 | 19 | 119 | 3 |
| idle:/one/kai/ | 9317 | 17 | 108 | 3 |
| idle:/one/location/ | 8534 | 17 | 97 | 1 |
| idle:/one/ | 1123 | 19 | 50 | 0 |

The lane overhead is small: the Debug/test-mode card below lands within
1 to 2 ms of these at p95 on every gesture, so the gesture cost is the app's,
not the harness's.

## Gesture card (Debug, test mode, attribution only)

Captured 2026-09-20T03:27:47Z at 8ac9b635b. rAF 61.2 Hz (nominal 60, budget
16.7 ms); engine iPhone AppleWebKit/605. Three reps each, median.

| Gesture | Windows | Frames | p95 ms (median) | p99 ms (median) | Worst ms | Frames > 50 ms | Hitch ms/s (median) | Verdict |
|---|---|---|---|---|---|---|---|---|
| feed-flick | 30 | 2727 | 20.5 | 35 | 77 | 16 | 33.8 | critical |
| bottom-nav-switch | 9 | 742 | 22 | 44 | 49 | 0 | 52.6 | critical |
| profile-pane-open-dismiss | 6 | 445 | 20 | 33.5 | 35 | 0 | 31.5 | critical |
| chat-stream-30s | 0 | 0 | - | - | - | - | - | not measured (composer not found) |
| top-shell-pager-swipe | 6 | 580 | 18.5 | 32.5 | 62 | 1 | 31.2 | critical |
| kai-chart-flick | 9 | 650 | 44 | 76 | 82 | 9 | 209 | critical |
| location-map-pan | 9 | 755 | 19 | 29 | 38 | 0 | 27.5 | critical |

Idle (no gesture in flight), by route, same lane:

| Route | Frames | p95 ms | Worst ms | Frames > 50 ms |
|---|---|---|---|---|
| idle:/one/feed/ | 2172 | 26 | 43 | 0 |
| idle:/one/kai/ | 1610 | 23 | 42 | 0 |
| idle:/one/location/ | 986 | 20 | 47 | 0 |
| idle:/one/ | 1222 | 21 | 40 | 0 |

## Threads on the same phone

Native Threads, driven by XCUITest through the same five-flick feed gesture,
scored by Apple's own `XCTOSSignpostMetric.scrollDecelerationMetric`, three
iterations:

| Metric | Iteration 1 | 2 | 3 |
|---|---|---|---|
| Hitch time ratio (ms per s) | 0 | 6.05 | 0 |
| Number of hitches | 0 | 1 | 0 |
| Hitches total duration (ms) | 0 | 16.7 | 0 |
| Frame rate through deceleration (fps) | 57.4 | 57.2 | 57.8 |

One dropped frame in fifteen flicks. That is the bar, in the unit the
charter uses.

**X** cannot be measured this way: the app calls `abort()` from its own
lifecycle library about 30 s into any XCUITest-driven session (two attempts,
identical crash report). The charter's screen-recording method remains the
symmetric option for X.

**Reading the comparison honestly.** Threads' number is Apple's hitch metric
on a UIScrollView during deceleration. One's feed scrolls a DOM element
(`ios.scrollEnabled: false`), which that instrument cannot see, so One's
number is the in-app probe's frame-interval hitch over the whole gesture
window, on a Debug build with the test bridge on. Same unit, same phone,
same flick, but One's figure is inflated by its lane. The truth lane closes
that gap.

## Reading it

- **Kai chart flick** is the surface furthest from the bar: p95 43 ms, 13
  frames over 50 ms in nine windows, 215 ms/s of hitch against Apple's
  10 ms/s "critical" line, with the Recharts tooltip already on tap and
  series animation off. What remains is layout and paint of several SVG
  charts and the pane under them; attribute with Web Inspector Timelines on
  `/one/kai` before touching code.
- **Feed flick** drops 16 frames over 50 ms in 30 windows (about one per
  flick) and its p99 is double the budget, against Threads' one dropped
  frame in fifteen flicks. The known seams are the top bar's per-scroll
  `<html>` write with a forced reflow and the unmemoised rows (charter items
  2 and 5; Wave 2 items 7 and 10).
- **Bottom-nav switch** has the highest hitch ratio of the navigation
  gestures (51.8 ms/s) with no frame over 50 ms: many slightly late frames
  during the route transition rather than one stall.
- **Profile pane, pager swipe, map pan** sit within 1 to 4 ms of budget at
  p95 with no frame over 50 ms; the map pan is the native map and the probe
  only sees the DOM around it.
- **At rest** every route is at or near budget (p95 17 to 19 ms) with a
  handful of stalls per two and a half minutes (worst 97 to 119 ms); those
  stalls are timers or polls and are worth one Web Inspector session each.
- **Chat stream** is not in the truth lane yet (the composer is not found by
  the driver on the phone). Fix the selector before the next card.

## What this reading cost to obtain

Recorded so the next person does not pay it again (details in the mobile
bug log, B33 and B34): the first Xcode 27 build crashed at launch until the
shell adopted the UIScene lifecycle; a bare `npx cap sync ios` shipped a
five-week-old bundle to the phone for three runs (the card now refuses a
stale sync); the reviewer bootstrap audited as the phone's owner until it
learned to withdraw a persisted session from the auth context; and the env
file's reviewer uid is not the one UAT mints.

## Next

1. Attribute the Kai chart flick and the feed flick on the phone with Web
   Inspector Timelines (Release made inspectable with `CAPACITOR_DEBUG=true`).
2. Wave 2 by that evidence: top bar and bottom chrome per-frame `<html>`
   writes, feed rows; chat streaming after the composer selector is fixed.
3. Re-run the truth lane after each Wave 2 landing; the before/after pair
   goes in the commit message, per the charter.
