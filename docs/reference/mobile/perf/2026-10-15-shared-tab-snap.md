# Shared tab snap measurement, 2026-10-15

## Visual Context

Canonical visual owner: [Mobile Index](../README.md). This measurement follows
the [Render performance charter](../render-performance-charter.md).

This desktop browser reading uses the production Referrals components and
`SwipeViews`, with synthetic authentication and service responses. Chromium and
WebKit run at 390px and 1024px. It is attribution evidence; it does not certify
frame pacing on an iPhone or Android phone.

## Observed behavior

The default Embla drag spring (`duration: 16`, friction `0.68`) travels
continuously, then slightly overshoots an interior tab. A stationary 500ms
midpoint was not observed. At 1024px the pane took about 546ms to remain within
3px of Ranking, so visual arrival lagged the selected tab.

Programmatic selections use duration `2` and friction `0.34`, which are Embla
spring parameters rather than milliseconds. Selection compares the pending
destination with the requested pane: a swipe's state update does not restart
its release, and a rapid tap retargets a pane already passing the viewport.
Settle restores the base physics. Drag handling, reduced-motion placement,
height protection, indicator ownership and geometry repair keep their owners.
Scroll listeners stay attached across selection changes so an echoed selection
cannot clear in-flight ownership or release the outgoing height prematurely.
If the route catches up after the final rendered frame, the pager releases its
height floor only when the exact rendered offset proves arrival within 3px.
This recovery keeps indicator ownership through settle and needs no additional
scroll event.

| Browser | Width | You to Ranking, before | After |
| --- | --- | --- | --- |
| Chromium | 390px | 341ms | 228ms |
| Chromium | 1024px | 547ms | 262ms |
| WebKit | 390px | 333ms | 227ms |
| WebKit | 1024px | 546ms | 262ms |

Across Ranking, Rewards and return-to-You clicks, sustained arrival changed
from 333–547ms to 227–295ms. The canonical frame probe records trusted pointer
interactions as `top-tabs`; its tick error count is zero in both engines.
Chromium's measured frame intervals remain about 16.7ms. Headless WebKit retains
variable frame intervals; these results establish quicker travel and settling,
not a device-wide frame-rate improvement.

## Reproducible repository checks

```bash
cd hushh-webapp
npx vitest run __tests__/components/swipe-views.test.tsx --maxWorkers=2
CI=1 npx playwright test e2e/wallet-workspace.layout.spec.ts --project=chromium --project=webkit --grep 'tab clicks settle without|Wallet Add scrolls in the page' --workers=1
npm run verify:render-performance
```

The real-Embla browser cases compose `TopShellTabs` and `SwipeViews` around
three simple panes, isolating spring behavior from Wallet form rendering. They
enforce sustained arrival below 400ms and at most 3px overshoot on 390px and
1024px layouts. Full Wallet Add/scroll/swipe cases retain workspace coverage.
A temporary fixture transform removing the programmatic spring override made
both 1024px cases fail: sustained arrival took 544ms in Chromium and 539ms in
WebKit. The transform was removed after this negative control.
Under concurrent local browser load, the full Wallet recorded 400–416ms WebKit
arrival with 129–132ms before its first frame and 145–150ms frame gaps; isolated
spring timing does not establish that this rendering overhead is fixed.
Additional trusted-pointer fixture
checks cover a rapid Rewards-to-Ranking retarget, a short fast swipe and reduced
motion in both engines. The unit contract covers destination echoes, rapid
retargeting and restoration of drag physics.
