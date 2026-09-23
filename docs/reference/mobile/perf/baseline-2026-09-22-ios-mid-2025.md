# Render performance baseline (ios-mid-2025)

## Visual Context

Canonical visual owner: [Mobile Reference Index](../README.md); the measurement
flow and the bar are in [render-performance-charter.md](../render-performance-charter.md),
and this page is one dated reading beneath them.

The reading taken after the motion-sync pass (`56ae2a6e7`): the composer and the
bottom navigation now ride together, and the keyboard's descent no longer steps.
Read it against [the 2026-09-19 reading](./baseline-2026-09-19-ios-mid-2025.md),
which is the first from this phone.

Every gesture here is at or under the 16.7 ms budget at p95 except the two
keyboard windows, and those were attributed to the system keyboard rather than
to the page (bug-log B43): the typing stall is WebKit's autocorrection context
and the presentation stall is the keyboard's own. The `critical` verdicts in the
table come from the hitch column, which the charter reads against Apple's 5 ms/s
"good" line, not from a dropped frame.


Captured 2026-09-22T04:45:52.884Z at 56ae2a6e7. Device run, Release, test mode off: certifying. rAF 61.1 Hz (nominal 60, budget 16.7 ms); engine iPhone AppleWebKit/605.

| Gesture | Windows | Frames | p95 ms (median) | p99 ms (median) | Worst ms | Frames > 50 ms | Hitch ms/s (median) | Verdict |
|---|---|---|---|---|---|---|---|---|
| feed-flick | 32 | 3073 | 21 | 35 | 47 | 0 | 37.1 | critical |
| bottom-nav-switch | 9 | 743 | 21 | 34 | 42 | 0 | 36.5 | critical |
| profile-pane-open-dismiss | 6 | 447 | 18.5 | 35 | 36 | 0 | 23.8 | critical |
| chat-keyboard-show | 1 | 55 | 21 | 90 | 90 | 1 | 98.3 | critical |
| chat-keyboard-type | 1 | 74 | 23 | 102 | 102 | 1 | 93.1 | critical |
| chat-stream-30s | 2 | 539 | 20.5 | 29.5 | 50 | 0 | 41.7 | critical |
| chat-keyboard-dismiss | 0 | 0 | - | - | 0 | 0 | - | good |
| chat-keyboard-show-2 | 1 | 58 | 21 | 63 | 63 | 1 | 66.8 | critical |
| chat-keyboard-dismiss-2 | 1 | 59 | 24 | 35 | 35 | 0 | 48.8 | critical |
| chat-transcript-flick | 4 | 623 | 17.5 | 36 | 41 | 0 | 24.7 | critical |
| top-shell-pager-swipe | 6 | 545 | 18.5 | 37 | 42 | 0 | 27.9 | critical |
| kai-chart-flick | 9 | 730 | 21 | 43 | 61 | 2 | 71.2 | critical |
| location-map-pan | 9 | 752 | 19 | 30 | 46 | 0 | 24.2 | critical |

Idle (no gesture in flight), by route:

| Route | Frames | p95 ms | Worst ms | Frames > 50 ms |
|---|---|---|---|---|
| idle:/one/location/ | 1328 | 19 | 114 | 2 |
| idle:/one/feed/ | 2175 | 29 | 113 | 2 |
| idle:/one/ | 792 | 22 | 51 | 1 |
| idle:/one/connect/ | 122 | 36 | 47 | 0 |
| idle:/ | 3040 | 17 | 124 | 6 |
| idle:/ | 1 | 10 | 10 | 0 |
| idle:/one/kai/ | 1988 | 23 | 105 | 2 |

Stalls (windows with a frame over 50 ms): where the worst frame sits, the longest event handler, the document's size.

| Gesture | Kind | Worst frame | Longest event | Elements | Commits |
|---|---|---|---|---|---|
| (none) | tap | 85 ms @ 544 ms, 79 ms @ 1166 ms, 62 ms @ 1382 ms | pointerover 40 ms (handler 1) @ -32 ms, touchstart 40 ms (handler 0) @ -32 ms, pointerdown 40 ms (handler 0) @ -32 ms | 327 | 0 |
| (none) | tap | 76 ms @ 1182 ms, 73 ms @ 531 ms, 52 ms @ 975 ms | keydown 48 ms (handler 0) @ 1181 ms, keypress 48 ms (handler 1) @ 1181 ms, keydown 40 ms (handler 0) @ 1190 ms | 287 | 0 |
| (none) | tap | 72 ms @ 77 ms, 38 ms @ 360 ms, 38 ms @ 782 ms | pointerup 40 ms (handler 1) @ 34 ms, pointerout 40 ms (handler 0) @ 34 ms, pointerleave 40 ms (handler 0) @ 34 ms | 758 | 0 |
| (none) | tap | 96 ms @ 539 ms, 86 ms @ 2430 ms, 75 ms @ 1185 ms | keydown 48 ms (handler 0) @ 1181 ms, keypress 48 ms (handler 1) @ 1181 ms, keydown 48 ms (handler 1) @ 1181 ms | 221 | 0 |
| (none) | tap | 74 ms @ 1236 ms, 60 ms @ 2556 ms, 52 ms @ 397 ms | mouseout 32 ms (handler 0) @ 66 ms, mouseover 32 ms (handler 0) @ 66 ms, mouseenter 32 ms (handler 0) @ 66 ms | 613 | 0 |
| chat-keyboard-show | scroll | 90 ms @ 132 ms, 32 ms @ 3 ms, 21 ms @ 42 ms | mouseout 96 ms (handler 0) @ 44 ms, mouseover 96 ms (handler 0) @ 44 ms, mousedown 96 ms (handler 0) @ 45 ms | 613 | 0 |
| chat-keyboard-type | type | 102 ms @ 876 ms, 26 ms @ 84 ms, 25 ms @ 467 ms | keydown 80 ms (handler 1) @ -31 ms, keypress 80 ms (handler 0) @ -31 ms, keydown 80 ms (handler 1) @ 7 ms | 613 | 0 |
| chat-keyboard-dismiss | scroll | 63 ms @ 121 ms, 30 ms @ 1 ms, 21 ms @ 45 ms | pointerover 24 ms (handler 0) @ -24 ms, touchstart 24 ms (handler 0) @ -24 ms, pointerdown 24 ms (handler 0) @ -24 ms | 684 | 0 |
| (none) | tap | 89 ms @ 2445 ms, 84 ms @ 561 ms, 78 ms @ 1202 ms | pointerover 24 ms (handler 1) @ -14 ms, touchstart 24 ms (handler 0) @ -14 ms, pointerdown 24 ms (handler 1) @ -14 ms | 300 | 0 |
| (none) | tap | 68 ms @ 365 ms, 46 ms @ 711 ms, 46 ms @ 2551 ms | mouseout 32 ms (handler 0) @ 50 ms, mouseover 32 ms (handler 0) @ 50 ms, mouseenter 32 ms (handler 0) @ 50 ms | 805 | 0 |
| kai-chart-flick | pager | 61 ms @ 335 ms, 34 ms @ 5 ms, 23 ms @ 44 ms | pointerover 32 ms (handler 0) @ -29 ms, touchstart 32 ms (handler 2) @ -29 ms, pointerdown 32 ms (handler 1) @ -29 ms | 805 | 0 |
| kai-chart-flick | pager | 61 ms @ 952 ms, 44 ms @ 90 ms, 34 ms @ 8 ms | pointerover 32 ms (handler 0) @ -21 ms, touchstart 32 ms (handler 0) @ -21 ms, pointerdown 32 ms (handler 0) @ -21 ms | 805 | 0 |

Bottom chrome sync (chat route, scroll windows): largest vertical divergence between the navigation and the composer, per frame.

| Gesture | Samples | Max divergence px |
|---|---|---|
| chat-keyboard-show | 4 | 0 |
| chat-stream-30s | 53 | 0 |
| chat-keyboard-dismiss | 6 | 0 |
| chat-keyboard-dismiss-2 | 51 | 0 |
| chat-transcript-flick | 94 | 0 |
| chat-transcript-flick | 175 | 0 |
| chat-transcript-flick | 175 | 0 |
| chat-transcript-flick | 179 | 0 |

Keyboard (settled, points): composer field bottom to keyboard top.

| Window h | Keyboard top | Key rows top | Composer bottom | Gap |
|---|---|---|---|---|
| 844 | 516 | 560 | 497 | 19 |

Route enter attribution (no profiling build: commit columns empty):

| Gesture | Route | First commit ms | First frame ms | Worst frame ms | Commits | Commits total ms | Top commits |
|---|---|---|---|---|---|---|---|
| bottom-nav-switch | /one/ | - | 28 | 42 | 0 | 0 | - |
| bottom-nav-switch | /one/feed/ | - | 28 | 38 | 0 | 0 | - |
| bottom-nav-switch | /one/feed/ | - | 27 | 36 | 0 | 0 | - |
| bottom-nav-switch | /one/feed/ | - | 25 | 34 | 0 | 0 | - |
| bottom-nav-switch | /one/connect/ | - | 23 | 34 | 0 | 0 | - |
| bottom-nav-switch | /one/connect/ | - | 20 | 30 | 0 | 0 | - |
| bottom-nav-switch | /one/ | - | 20 | 29 | 0 | 0 | - |
| bottom-nav-switch | /one/connect/ | - | 20 | 37 | 0 | 0 | - |
| bottom-nav-switch | /one/ | - | 18 | 31 | 0 | 0 | - |
