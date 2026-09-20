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

## After the first two fixes (same lane, same phone)

Two landings measured with the truth lane the same night:

| Gesture | Baseline | After 9230d6ae4 (scroll chrome off `<html>`) | After bda07869a (enter deferred, rows memoised) |
|---|---|---|---|
| feed-flick, frames > 50 ms (30 windows) | 16 | **0** | 0 |
| feed-flick, worst ms | 76 | 49 | 43 |
| feed-flick, hitch ms/s | 30.3 | 25.6 | 24.4 |
| kai-chart-flick, p95 ms | 43 | **21** | (not re-run) |
| kai-chart-flick, frames > 50 ms (9 windows) | 13 | 2 | |
| kai-chart-flick, hitch ms/s | 215 | 72 | |
| bottom-nav-switch, hitch ms/s | 51.8 | 50 | **41.6** |
| bottom-nav-switch, worst ms | 49 | 55 | 50 |
| profile-pane, pager, map | within 1 to 4 ms of budget | unchanged | unchanged |

Later the same night, with the Liquid Glass material on every filled button
(08eea591d) and the route-change hygiene (5e97ffab9), the full lane read:
feed flick 25.4 ms/s and no frame over 50 ms, Kai chart 70.3 ms/s (one frame
over 50), tab switch 46.5 ms/s, pane 22.2, pager 30.3, map 19.8. The
material is static by contract and costs nothing the probe can see.

The per-frame custom-property writes on `<html>` were the dominant scroll
cost: removing them took the feed flick to zero frames over 50 ms and halved
the Kai chart's p95. What remains on a tab switch is the incoming page's own
first frame (about 45 ms); the enter beat now waits two frames so that frame
is never inside the fade, which is what the person feels, but the probe still
counts it. Cutting that frame needs a profile of the mount (Time Profiler
over USB; `hushh-webapp/scripts/perf/ios-time-profile-buckets.mjs` buckets it).

## Phase 2, morning of 2026-09-20 (same lane, same phone)

Two more landings, each measured with the full truth lane (Release, test
mode off, certifying; webpack cache cleared and the export's CSS verified
fresh before every run, after three runs had measured a stale stylesheet):

| Gesture | Before (night of 09-19) | After a5579e196 (tab-switch shell work, run W) | After 8ab3218e9 + cc52e1c82 (solid Finance rows, chat lane, run Z) |
|---|---|---|---|
| bottom-nav-switch, hitch ms/s | 46.5 | **31.9** | 37.9 |
| bottom-nav-switch, p99 ms / worst ms | 47 / 56 | **32 / 44** | 37 / 48 |
| kai-chart-flick, hitch ms/s | 70.3 | (not re-run) | **33.2** |
| kai-chart-flick, p95 / p99 / worst ms | 21 / 72 / 74 | | 20 / 34 / 64 |
| kai-chart-flick, frames > 50 ms (9 windows) | 1 | | 2 |
| feed-flick, frames > 50 ms / worst ms / hitch ms/s | 0 / 43 / 25.4 | 0 / 44 / 25.1 | 0 / 46 / 36.3 |
| chat-stream-30s (first measurement) | never measured | | 2 windows, 113 frames, p99 62.5, worst 86, 92.4 ms/s (see below) |
| profile-pane / pager / map, hitch ms/s | 22.2 / 30.3 / 19.8 | 22.6 / 28.9 / 19.5 | 22 / 29.5 / 19.9 |

Run Z's rAF read 55.1 Hz at boot (the phone was warm from the build), so
its idle p95 of 17 ms sits on budget everywhere.

The tab switch: the shell work removed the root-variable churn (26 mirrored
variables removed and re-set on every navigation), memoised the bottom
shell and the profile pane, stopped the persona refresh on cached state,
and cut the scroll reset to one write plus one conditional frame. The
reading moved from 46.5 to 31.9 ms/s and the worst frame from 56 to 44 ms.
The next run read 37.9; the band on this gesture across identical builds
is about ±8 ms/s, so the two later readings agree with each other and both
sit below every earlier one.

The Finance flick: the eight advisor-pick rows carried their own frosted
blur and moved under the flick; solid rows took the hitch from 70.3 to
33.2 ms/s and the p99 from 72 to 34 ms. The remaining two frames over
50 ms are the chart's first paint on entry, not the flick.

The chat row is not yet a stream measurement. The probe opened windows on
pointer and scroll input only, so inside the 35 s stream span it caught two
1 s auto-scroll windows; the stream itself landed in `idle:/` (9767
frames, p95 17 ms, worst 98, 3 frames over 50 ms, 12.9 ms/s). be5899207
adds a `stream` window that stays open while the assistant bubble carries
`data-agent-streaming`; the next lane run reads the whole reply.

Run AB (later the same morning, 8d768b405: Liquid Glass on the circular
controls; the material is static by contract) against run Z:

| Gesture | Z | AB | Read |
|---|---|---|---|
| feed-flick, p95 / worst / hitch ms/s | 20 / 46 / 36.3 | 19.5 / 51 / 36.0 | flat |
| bottom-nav-switch, p99 / worst / hitch ms/s | 37 / 48 / 37.9 | 38 / 55 / 47.6 | top of this gesture's band on identical code (31.9 to 46.8); p99 +1 |
| profile-pane, hitch ms/s | 22.0 | 18.4 | flat |
| top-shell-pager-swipe, hitch ms/s | 29.5 | 26.1 | flat |
| kai-chart-flick, hitch ms/s | 33.2 | 71.9 | two-mode window mix: per window either ~30 (p95 20) or ~70 (p95 22, p99 41 to 47, no frame over 50); Z drew 4 of 9 low, AB 1 of 9; no chart code changed |
| location-map-pan, hitch ms/s | 19.9 | 18.7 | flat |

The material carries no cost the probe can see; every p95 is within 1 ms.

Chat on the phone does not stream. Every native API call goes through
`CapacitorHttp.request` (`lib/services/api-service.ts`), which returns the
body whole, so One's reply lands in one paint when the backend finishes
(web streams token by token and animates the reveal). That is why the
`stream` window never opens on native, and why the chat rows in Z and AB
(p99 62 to 70 ms, worst 84 to 86 ms, 1 to 2 frames over 50 ms in two 1 s
auto-scroll windows) measure one thing: painting the entire reply in a
single frame. Streaming on native (the WebView's own `fetch` for the SSE
route, which needs the backend to allow the `capacitor://localhost`
origin) is a Phase 3 item; until then the reveal could be animated on
native the way it is on web, which spreads that paint across frames.

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

1. Profile the tab switch's mount frame with Instruments over USB (Wi-Fi
   pairing cannot record) and split it into JavaScript, style, layout and
   paint; then either trim what mounts on first paint (`content-visibility`
   on off-screen rows, lighter Connect first render) or move work off the
   first frame.
2. Kai chart: re-run the truth lane on Finance after the next chart change;
   the remaining 72 ms/s is SVG layout and paint under a flick.
3. Chat stream: fix the composer selector so streaming is measured on the phone.
4. Re-run the full truth lane after each landing; before/after pairs go in
   the commit message, per the charter.
