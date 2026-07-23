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

## Your Map

`/one/location/map` is an immersive private map. It suppresses the app top
shell, Agent Bar, bottom navigation, and ambient chrome. A person must accept
the Google Maps renderer disclosure before it initializes.

- Ghost Mode is the default. It hides the owner from Your Map without changing
  any direct private share or its background publisher.
- The map returns only fresh (90-second default), active, recipient-scoped
  `foreground_map_visible` ciphertext. It never promotes a direct or
  background-share envelope onto the map.
- Opening Map never captures location. **Locate me** is the explicit
  foreground action that can publish a fresh encrypted Map envelope to the
  owner’s already-active private recipients.
- Decryption happens only in foreground device memory. Closing the route
  destroys the renderer and clears marker state. Coordinates are not added to
  storage, logs, route data, or map preference records.
- Web, iOS, and Android use the official Capacitor Google Maps renderer; there
  is no iframe or single-point fallback. Missing restricted platform keys shows
  a safe unavailable state without decrypting coordinates.
- The people surface is one matched-geometry control: it expands into search,
  visibility, and framing controls, then morphs into a 64px map button so the
  map remains unobstructed. Selecting a person or Show everyone minimizes it.
- Local development and injected native UI-test sessions expose a **Demo**
  control with fictional people. Demo markers stay in process memory and
  perform no preference, envelope, or share writes. **Locate me** continues to
  use the actual browser/native location provider while Demo is active. The
  control is unavailable in ordinary production sessions.

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
