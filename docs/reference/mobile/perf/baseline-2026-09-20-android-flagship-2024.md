# Render performance baseline: Android (android-flagship-2024), 2026-09-20

## Visual Context

Canonical visual owner: [Mobile Reference Index](../README.md); the measurement flow and the bar are in [render-performance-charter.md](../render-performance-charter.md) (the *Android* section describes this lane), and this page is one dated reading beneath them.

The first reading from an Android phone: a 2024 flagship with a 120 Hz
panel, Android 16, the system WebView (Chromium 152), driven over adb. It
mirrors the iOS reading of the day before
([baseline-2026-09-19-ios-mid-2025.md](./baseline-2026-09-19-ios-mid-2025.md))
gesture for gesture, and adds the one instrument Android has that iOS does
not: HWUI's own frame account (`dumpsys gfxinfo`).

**Two lanes, stated plainly.**

- **Gesture card: attribution only.** Debug build, signed in as the reviewer
  through the native test bridge (intent extras, 350 ms status poll), probe
  switched on by the `HUSHH_PERF_PROBE` extra, gestures from
  `adb shell input`, HWUI counted around each gesture group.
  Reproduce: `ANDROID_SERIAL=<serial> npm run perf:android:card`.
- **Truth lane: UIAutomator, bridge off.** `AttachedRenderPerfTest` launches
  each surface with only the probe keys, unlocks the vault with the
  passphrase method and drives the same gestures on the phone's own clock.
  On the `perf` build type (release settings, debuggable false) it certifies.
  Reproduce: `PERF_ATTACHED=1 PERF_CONFIGURATION=Release ANDROID_SERIAL=<serial> npm run perf:android:card`.
  See *Status* below for what this lane has produced so far.

## The refresh-rate question first

`dumpsys display` with the app in front: active mode 1, `renderFrameRate`
120. The probe's steady-state intervals during a flick are 8 ms at p95 (the
120 Hz cadence is 8.3 ms), so the WebView is delivering 120 Hz frames. The
probe's boot sample, however, read 91.4 Hz raw and rounded it to a nominal 90
(budget 11.1 ms): the first second after boot is JavaScript-heavy and drops
frames, and the probe samples exactly that second. Two consequences for
reading the tables below:

1. The probe's verdict column uses the 11.1 ms budget where the honest budget
   on this panel is 8.3 ms; a p95 of 8 is on budget either way.
2. The boot sample is an attribution finding, not a platform setting: the
   panel is not pinned to 60 and no `preferredDisplayModeId` /
   `Surface.setFrameRate` work is needed for this phone. The sampler should
   confirm its rate again once the first route settles (a one-line change
   in `hushh-webapp/lib/perf/frame-pacing.ts`) before the next card.

## Gesture card (Debug, test bridge on, attribution only)

Captured 2026-09-20 at 8cec9a006, one rep per gesture, feed launch only
(the full three-launch, three-rep run was interrupted by the phone's secure
lock engaging mid-run; the card now keeps the screen on and refuses a locked
phone, see *Status*). rAF 91.4 Hz at boot (nominal 90, budget 11.1 ms;
steady state 120 Hz, see above); engine Linux Chrome/152.

| Gesture | Windows | Frames | p95 ms (median) | p99 ms (median) | Worst ms | Frames > 50 ms | Hitch ms/s (median) | Verdict |
|---|---|---|---|---|---|---|---|---|
| feed-flick | 10 | 808 | 8 | 8 | 83.2 | 1 | 0 | critical (one 83 ms frame on the first flick) |
| bottom-nav-switch | 3 | 425 | 9 | 33 | 58.2 | 1 | 75 | critical |
| profile-pane-open-dismiss | 2 | 315 | 8 | 41 | 50 | 0 | 61.2 | critical |
| chat-stream-30s | 0 | 0 | - | - | - | - | - | not measured (composer selector fixed after this run) |
| top-shell-pager-swipe | | | | | | | | pending the full run |
| kai-chart-flick | | | | | | | | pending the full run |
| location-map-pan | | | | | | | | pending the full run |

HWUI, same gestures (`dumpsys gfxinfo com.hussh.app reset` before, `framestats`
after; the whole app window, not just the WebView):

| Gesture | Frames | Janky % | p50 ms | p90 ms | p95 ms | p99 ms | Frames >= 50 ms | Missed vsync | Slow UI thread |
|---|---|---|---|---|---|---|---|---|---|
| feed-flick | 445 | 3.82 | 10 | 17 | 18 | 20 | 0 | 1 | 0 |
| bottom-nav-switch | 210 | 3.81 | 12 | 16 | 21 | 36 | 0 | 1 | 1 |
| profile-pane-open-dismiss | 76 | 9.21 | 11 | 17 | 20 | 42 | 0 | 0 | 1 |

Idle (no gesture in flight), by route, same lane:

| Route | Frames | p95 ms | Worst ms | Frames > 50 ms |
|---|---|---|---|---|
| idle:/one/feed/ | 1922 | 8 | 108.2 | 5 |
| idle:/one/ | 373 | 8 | 25 | 0 |
| idle:/one/connect/ | 324 | 8 | 49.9 | 0 |
| idle:/ | 2007 | 8 | 33.4 | 0 |

## Reading it

- **The feed flick is on budget at 120 Hz.** p95 8 ms, p99 8 ms across ten
  windows; the one frame over 50 ms (83 ms) is the first flick's first
  window, the same first-scroll cost the iOS reading attributes to row
  mount. HWUI agrees: 3.8 % janky, p99 20 ms, nothing at or over 50 ms.
  Against the charter's Android bar (janky < 5 %) this passes.
- **Tab switches and the pane are where the hitch is.** p99 33 to 41 ms and
  60 to 75 ms/s of hitch: many late frames during the route transition
  rather than one stall, the same shape as iOS. HWUI's p99 36 to 42 ms on
  those groups says the app window, not only the WebView, misses vsyncs
  there (one missed vsync, one slow UI thread frame each).
- **At rest** the feed route dropped five frames over 50 ms in sixteen
  seconds (worst 108 ms) while the other routes stayed clean; timers and
  polls, worth one `chrome://inspect` session on `/one/feed`.
- **The 120 Hz panel is real for the WebView.** The probe's budget should
  follow it (see *The refresh-rate question first*).

## Threads and X on the same phone

`PERF_THIRD_PARTY=1` flicks Threads (`com.instagram.barcelona`) and X
(`com.twitter.android`) with the same five-down, five-up swipes and records
`dumpsys gfxinfo` for each. Both are installed on this phone; the comparison
run is part of the full card and is recorded here when it lands. Read it as
native lists (RecyclerView) against a DOM scroller, same phone, same flick,
same HWUI unit.

## Status

- The card, the driver, the gfxinfo parser and the summary merge ran end to
  end on the phone for the feed launch (this page's numbers).
- The full three-launch run was interrupted when the phone's secure lock
  engaged (two-minute screen timeout, PIN keyguard): the feed launch timed
  out against the lock screen and the Finance and Location groups recorded
  zero HWUI frames. The card now sets `svc power stayon true` for the run,
  restores the setting, and fails fast with `PERF_BLOCKED reason=keyguard`
  on a locked phone. Re-run once the phone is unlocked:
  `PERF_SKIP_BUILD=1 PERF_THIRD_PARTY=1 ANDROID_SERIAL=<serial> npm run perf:android:card`.
- The truth lane (`AttachedRenderPerfTest`, UIAutomator 2.3.0) compiles for
  both the debug and the `perf` build types; its first phone run is pending
  the same unlock. Until it has run, nothing on this page certifies.

## What this reading cost to obtain

- `with-ios-native-env.mjs` pins `NEXT_DIST_DIR` from the env file, so a
  concurrent Android export needs its own wrapper
  (`hushh-webapp/scripts/native/with-android-native-env.mjs`) and its own dist dir.
- The WebView's accessibility tree is empty on the first `uiautomator dump`
  after a launch and populates on the second; the driver retries.
- The composer on `/` is exposed as a bare `EditText` (no label); the pane
  on this phone is a full-width sheet with no scrim, and the body swipe
  yields to the agent rows, so the pane is opened and closed through its own
  `Open Profile` / `Close Profile` controls.
- The phone's clock and the Mac's differed by about 25 ms; the driver
  measures the offset and stamps gesture lines in the phone's clock, because
  the probe's windows are stamped there.
