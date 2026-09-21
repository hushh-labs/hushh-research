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

Captured 2026-09-20 18:22 UTC at c5f250861, three reps per gesture, all
three launches (feed, Finance, Location) plus the chat section. rAF 81.4 Hz
at boot (nominal 90, budget 11.1 ms; steady state 120 Hz, see above); engine
Linux Chrome/152. An earlier partial run (8cec9a006, feed launch only, one
rep) read the same shape: feed flick p95 8, tab switch 75 ms/s, pane 61 ms/s.

| Gesture | Windows | Frames | p95 ms (median) | p99 ms (median) | Worst ms | Frames > 50 ms | Hitch ms/s (median) | Verdict |
|---|---|---|---|---|---|---|---|---|
| feed-flick | 30 | 2465 | 8 | 24 | 50 | 0 | 23.9 | critical |
| bottom-nav-switch | 9 | 1294 | 8 | 33 | 58.5 | 2 | 83.9 | critical |
| profile-pane-open-dismiss | 8 | 1131 | 8 | 25 | 98.6 | 3 | 34.5 | critical |
| chat-stream-30s | 1 | 68 | 43 | 127 | 166.4 | 2 | 365.7 | critical (one paint of the whole reply; chat does not stream on native, bug log B39) |
| top-shell-pager-swipe | 6 | 977 | 8 | 16 | 50 | 0 | 19.8 | critical |
| kai-chart-flick | 9 | 828 | 8 | 11 | 49.9 | 0 | 23.5 | critical |
| location-map-pan | 11 | 2238 | 8 | 8 | 41.7 | 0 | 2.2 | good |

HWUI, same gestures (`dumpsys gfxinfo com.hussh.app reset` before, `framestats`
after; the whole app window, not just the WebView):

| Gesture | Frames | Janky % | p50 ms | p90 ms | p95 ms | p99 ms | Frames >= 50 ms | Missed vsync | Slow UI thread |
|---|---|---|---|---|---|---|---|---|---|
| feed-flick | 1001 | 3.2 | 12 | 15 | 18 | 25 | 1 | 1 | 4 |
| bottom-nav-switch | 650 | 3.08 | 12 | 18 | 21 | 44 | 1 | 0 | 2 |
| profile-pane-open-dismiss | 261 | 4.98 | 12 | 23 | 26 | 42 | 1 | 0 | 5 |
| chat-stream-30s | 54 | 29.63 | 17 | 20 | 22 | 81 | 2 | 0 | 4 |
| top-shell-pager-swipe | 922 | 4.99 | 12 | 17 | 18 | 24 | 0 | 0 | 0 |
| kai-chart-flick | 164 | 3.05 | 10 | 12 | 14 | 44 | 1 | 1 | 1 |
| location-map-pan | 1648 | 0.06 | 9 | 9 | 9 | 11 | 0 | 0 | 1 |

Idle (no gesture in flight), by route, same lane:

| Route | Frames | p95 ms | Worst ms | Frames > 50 ms |
|---|---|---|---|---|
| idle:/one/feed/ | 2345 | 8 | 183.2 | 2 |
| idle:/one/ | 1495 | 8 | 41.7 | 0 |
| idle:/one/connect/ | 388 | 8 | 58.3 | 3 |
| idle:/ | 3595 | 16 | 150 | 4 |
| idle:/one/kai/ | 2486 | 8 | 191.4 | 5 |
| idle:/one/location/ | 2203 | 8 | 183.1 | 3 |

## Reading it

- **Every flick and pan is on budget at 120 Hz.** Feed, Finance chart,
  pager and map all read p95 8 ms (the 8.3 ms cadence) with no frame over
  50 ms; the map pan is the first gesture on either phone to read "good"
  (2.2 ms/s). The Finance flick that cost 215 ms/s on the iPhone at the
  start of the program costs 23.5 ms/s here after the solid rows.
- **Tab switches and the pane are where the hitch is,** the same shape as
  iOS: p99 33 ms and 84 ms/s on the switch (two frames over 50 ms in nine
  windows), p99 25 and a 99 ms worst frame on the pane. HWUI puts both
  groups at 3 to 5 % janky with p99 42 to 44 ms, so the app window misses
  vsyncs there, not only the WebView's JavaScript.
- **Chat is one paint.** 68 frames in the window, worst 166 ms: the whole
  reply lands in a single frame because native does not stream (B39).
  HWUI: 30 % of 54 frames janky.
- **At rest** every route drops two to five frames over 50 ms in twenty
  seconds (worst 150 to 191 ms); timers and polls, worth one
  `chrome://inspect` session on `/one/feed` and `/one/kai`.
- **The 120 Hz panel is real for the WebView.** The probe's budget should
  follow it (see *The refresh-rate question first*).

## Threads and X on the same phone

`PERF_THIRD_PARTY=1` (or `PERF_SECTION=reference` for the reference apps
alone) drives Threads (`com.instagram.barcelona`) and X
(`com.twitter.android`) through the same four gestures our card measures:
the feed flick, bottom-bar tab switches (the tab row is read from the
accessibility tree and the compose control skipped), the home pager's
top-tab drag, and open/dismiss of a post (tap a post, system back), each
group from a cold launch, HWUI only (there is no probe inside them).
Captured 2026-09-20, three reps:

| Gesture (HWUI) | One (Debug, bridge on) | Threads | X |
|---|---|---|---|
| feed flick: janky % / p99 ms / frames >= 50 ms | 3.2 / 25 / 1 | 3.6 / 29 / 0 | 6.8 / 21 / 0 |
| bottom-bar tab switch | 3.1 / 44 / 1 | 13.1 / 101 / 29 | 7.5 / 53 / 19 |
| open/dismiss (our profile pane; their post) | 5.0 / 42 / 1 | 5.5 / 77 / 27 | 5.6 / 65 / 18 |
| top-tab pager drag | 5.0 / 24 / 0 | no pager (the home tabs are a tap pill; 46 frames) | did not page (5 frames) |

Read it as native lists and native tabs against a WebView, same phone, same
gestures, same HWUI unit. On this phone the shell's tab switches and pane
miss fewer vsyncs than either reference app's; the reference apps load a
cold tab on each switch (Threads 29 frames at or over 50 ms across three
rounds) where our tabs are already mounted. The probe adds what HWUI
cannot see inside our WebView (the 58 ms JavaScript frame on the switch,
the 99 ms one on the pane), which is where our remaining work is.

## Status

- The card, the driver, the gfxinfo parser and the summary merge ran end to
  end on the phone: three launches, chat, all reps, both reference apps.
- The phone's secure lock (two-minute screen timeout, PIN keyguard) engaged
  during the first full attempt; the card now sets `svc power stayon true`
  for the run, restores the setting, and fails fast with
  `PERF_BLOCKED reason=keyguard` on a locked phone. Re-run:
  `PERF_SKIP_BUILD=1 PERF_THIRD_PARTY=1 ANDROID_SERIAL=<serial> npm run perf:android:card`.
- The truth lane (`AttachedRenderPerfTest`, UIAutomator 2.3.0) ran its kai
  section on the phone (Debug, bridge off): it cancels Android's Credential
  Manager sheet (the gate's passkey attempt), types the passphrase, and its
  shell-input gestures reach the page (probe windows recorded). Its first
  full run, and the `perf` build type, wait for a phone that stays
  unlocked for a lane's length (the secure lock engaged between runs
  twice). Until then nothing on this page certifies. Note for the reading:
  with the bridge off, HWUI on the Finance launch read 0.13 to 0.44 %
  janky against 3 to 5 % with the bridge's 350 ms status poll on, so the
  attribution card's HWUI columns run high.

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
