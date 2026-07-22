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

`/one/location/map` remains an immersive route, but Maps is temporarily
unavailable while the native SDK, restricted platform keys, device rendering,
and lifecycle proof are completed. The route suppresses persistent chrome and
does not load, decrypt, capture, or persist coordinates.

## Verification

Run `npm run verify:surface-map`, `npm run verify:capacitor:plugins`, focused
Location tests, and typecheck. Native release verification must confirm multiple
markers, permission parity, suppressed chrome, and a Back return to
`/one/location` in the same vault session.
