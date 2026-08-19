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

After a nearby presence is active, **Choose trusted people** opens the existing
recipient-scoped encrypted Check-In as an optional second consent stage. Nearby
presence never selects a recipient or creates a location grant. The owner
explicitly chooses trusted connections, duration, and message; successful
completion or Cancel returns to the active nearby sheet. A partial private-share
failure keeps only failed recipients selected for retry, so already-successful
recipients are not republished. The consent screen shares the exact point it
shows: a first confirmation requires a fix no older than 60 seconds, and a
partial retry retains the same point, confirmation timestamp, operation id, and
per-recipient ciphertext. After ten minutes, an unfinished confirmation must be
edited and reconfirmed; people already reached keep their original share, while
edits apply only to the remaining recipients. Grant replacement plus
first-envelope persistence is one idempotent backend mutation, so a transient
envelope failure cannot revoke an existing working share or send a premature
notification. The message is encrypted inside that first envelope; backend
grant/audit metadata and the push notification carry only a fixed Check-In
reason code. Recipient-key rotation invalidates the cached retry and requires a
fresh review instead of reusing ciphertext for the old key. The route handoff
uses an opaque, short-lived per-tab return token so Cancel, success, top-shell
Back, iOS edge Back, and Android Back return to the existing sheet history
boundary without leaving a replayable duplicate entry.

Nearby matching uses exact Haversine distance between independently captured
confirmation points, with an inclusive fixed 500-meter radius. The selected
place remains admission and display context; it does not substitute for the
user's check-in point. Peers appear only in the accessible roster, never as
precise pins or distance ordering. Responses expose a rotating alias,
safe display label, relationship, and Connect posture only. Check out clears
encrypted anchor/index material synchronously. At expiry the user disappears
from rosters and Connect synchronously; the backend scrubs due material on the
next feature operation or required hosted hourly retention job. The feature
remains a visibly labelled local/UAT simulation and fails closed in production until
organizer admission proof, replay resistance, and Block/Report controls exist.
Approximate native permission and fixes worse than 100 m fail before
publication with an app-settings recovery path. Active rosters refresh on a
15-second, visible-app cadence without extending the server expiry.

## Saved location onboarding

Every Location onboarding run offers the saved-place flow after foreground
permission is ready. The owner first confirms an entrance with a centre-pin map,
then supplies the house/flat/floor or block and PIN/postal code; building colour,
landmark, and a custom **Other** label remain optional. Google Maps never
initializes until the owner accepts the same versioned renderer disclosure used
by **Your Map**. Moving the map invalidates the previous address and disables
confirmation until the selected centre has finished resolving, so coordinates
cannot be paired with stale address copy.

Root setup deliberately precedes vault creation. Its confirmed place therefore
stays only in process memory, address autofill is disabled, reload/sign-out
discards it, and Skip clears it. Once setup creates and unlocks the vault, the
existing finalization transaction writes the place through encrypted Location
PKM. No bootstrap database, browser-storage record, vault schema, or plaintext
fallback is introduced. Home and Work retain their singleton behavior, and the
existing 25-metre cross-category duplicate guard remains authoritative.

## Your Map

`/one/location/map` is an immersive private map. It suppresses the app top
shell, Agent Bar, bottom navigation, and ambient chrome. A person must accept
the Google Maps renderer disclosure before it initializes.

- An active private or Circle share is visible on the recipient's map
  unconditionally. There is no separate map-visibility opt-in: a grant already
  is the sharer's consent, and gating a second time behind a preference meant
  an active share could still never appear where the recipient was most
  likely to look for it (#5425).
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
- While nearby presence is active, the people drawer also shows a distinct
  **Checked in nearby** roster for opted-in people within the server-selected
  500 m radius. These entries use only the rotating alias response, safe display
  name, and relationship posture; they never become geographic pins. The
  separate **Live locations shared with you** section remains the only source of
  peer map markers.
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
confirm multiple markers, unconditional share visibility, foreground-only
update behavior, suppressed chrome, and a Back return to `/one/location` in
the same vault session.
