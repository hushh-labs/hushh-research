# One Location: Now and Your Map

## Visual Context

Canonical visual owner: [Hussh Webapp Docs](./README.md). The default Location
workspace is a compact, no-scroll hub; focused detail views may scroll, while
the immersive Your Map route suppresses persistent app chrome.

`/one/location` has one compact default hub: **Now**, **People**, and **Links**.

## Now

Now is intentionally bounded on a normal phone viewport. It contains only:

- Share location
- Your Map
- Active shares, Shared with me, and Needs my review with live counts
- Settings
- Check-In and Alert

Each count opens a focused detail view. Legacy `view=inbox` links canonicalize
to Now. Retired Drive To, Pick Me Up, Meeting, and Safe Arrival action links
also return to Now and display an unavailable outcome; they do not recreate a
sharing flow. Existing grants and their historical/revocation records remain
available through the active share detail surfaces.

In local/UAT, the **Check-In** quick action opens
`/one/location/map?action=check-in`; the ordinary **Your Map** row opens the same
map without forcing the sheet. Production retains the established
recipient-scoped encrypted Check-In while nearby discovery remains disabled.
The nearby sheet captures a fresh foreground fix, preselects the closest
provider place, supports a location-biased search edit, and offers 30-minute,
one-hour, and two-hour visibility. Nothing is submitted until the owner checks
the explicit visibility confirmation. **Allow connection requests** is separate
and off by default.

Nearby matching uses a fixed 500-meter radius between independently selected
public-place anchors, so people at Spot A and Spot B can see one another without
typing or sharing an event code. Peers appear only in the accessible roster,
never as precise pins or distance ordering. Responses expose a rotating alias,
safe display label, relationship, and Connect posture only. Check out clears
encrypted anchor/index material synchronously. At expiry the user disappears
from rosters and Connect synchronously; the backend scrubs due material on the
next feature operation or required hosted hourly retention job. The feature
remains a visibly labelled local/UAT simulation and fails closed in production until
organizer admission proof, replay resistance, and Block/Report controls exist.
Approximate native permission and fixes worse than 100 m fail before
publication with an app-settings recovery path. Active rosters refresh on a
15-second, visible-app cadence without extending the server expiry.

## Your Map

`/one/location/map` is an immersive private map. It suppresses the app top
shell, Agent Bar, bottom navigation, and ambient chrome. A person must accept
the Google Maps renderer disclosure before it initializes.

- Ghost Mode is the default. It hides the owner from Your Map without changing
  any direct private share or its background publisher.
- The map returns only fresh (90-second default), active, recipient-scoped
  `foreground_map_visible` ciphertext. It never promotes a direct or
  background-share envelope onto the map.
- Opening Map centers on the owner immediately: it paints a process-memory
  location first when available, then requests one fresh foreground fix and
  animates the camera to the accuracy-appropriate zoom. This entry focus never
  starts a watcher or publishes the point. **Locate me** remains the explicit
  action that can publish a fresh encrypted Map envelope to the owner’s
  already-active private recipients.
- Decryption happens only in foreground device memory. Closing the route
  destroys the renderer and clears marker state. Coordinates are not added to
  storage, logs, route data, or map preference records.
- Web, iOS, and Android use the official Capacitor Google Maps renderer; there
  is no iframe or single-point fallback. Missing restricted platform keys shows
  a safe unavailable state without decrypting coordinates.
- The people surface is one matched-geometry control: it expands into search,
  visibility, and framing controls, then morphs through one coordinated
  width/measured-height/radius transition into a 56px circular map button so
  the map remains unobstructed. The body is taken out of layout during the
  morph because WebKit can retain a collapsed grid track and render a tall
  empty pill. Selecting a person or Show everyone minimizes it.
- Local development, UAT, and injected native UI-test sessions expose a
  **Demo** control with 50 deterministic fictional people distributed around
  the world. Demo markers stay in process memory and perform no preference,
  envelope, or share writes. **Locate me** continues to use the actual
  browser/native location provider while Demo is active. The control is
  unavailable in ordinary production sessions.

Builds must inject separate restricted values for
`NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY`,
`NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY`, and
`NEXT_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY`. They must never reuse the backend
Maps key or be committed to source.

## Verification

Run `npm run verify:surface-map`, `npm run verify:capacitor:static`, focused
Location tests, typecheck, and native builds. Native release verification must
confirm multiple markers, Ghost Mode, foreground-only update behavior,
suppressed chrome, and a Back return to `/one/location` in the same vault
session.
