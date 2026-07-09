# Background Location Sharing (iOS) — Design

**Date:** 2026-07-09
**Status:** Approved (design); pending implementation plan
**Scope:** One Location Agent — background location publishing on iOS

## Goal

Enable **near-real-time location sharing that continues while the iOS app is
backgrounded or the screen is locked**, with **full end-to-end encryption
preserved** (the server never sees plaintext coordinates).

- iOS first. Android is designed-for-later but **not** built in this effort.
- Web (desktop + mobile browser) stays **foreground-only by design** — this is a
  platform limitation (JS timers freeze when a tab is hidden; no GPS in service
  workers). We add honest UX around it, not a workaround.

## Background & current behavior

Today, live sharing is foreground-only on every platform. Both the sender's
publish loop and the recipient's view poll bail when the tab/app is hidden:

- Sender heartbeat interval — `hushh-webapp/app/one/location/page.tsx` (~3343)
- Sender movement watch — `page.tsx` (~3413)
- Recipient view poll — `page.tsx` (~3506)

All three guard on `document.visibilityState === "hidden"`.

The native iOS plugin is deliberately foreground-only:
`ios/App/App/Plugins/HushhLocationPlugin.swift` requests only
`requestWhenInUseAuthorization` and hardcodes `"background": "foreground-only"`
(~line 202).

### Encryption scheme (why native publish is feasible)

`hushh-webapp/lib/one-location/encryption.ts:524` (`encryptLocationForRecipient`)
is **ECIES-style**:

1. For each publish, the sender generates a **fresh ephemeral ECDH P-256 keypair**.
2. Derives an AES-256-GCM key via ECDH against the **recipient's public key**.
3. Sends `{ ciphertext, iv, senderEphemeralPublicKeyJwk, recipientKeyId }`.

**Critical consequence:** the sender side needs **no secret key material** — only
each recipient's *public* key + keyId (non-secret). Therefore native Swift can
reproduce the entire envelope with CryptoKit using only public inputs, and full
E2E is preserved on the background path. The recipient decrypts with their
**vault-synced private key** (`ensureVaultSyncedRecipientKey`,
`encryption.ts:441`), which is the same `keyId` on every device they log into.

## Cross-platform behavior (agreed)

A share is a **server-side grant**, not a device. Any of the sender's signed-in
devices can publish into a grant; the recipient decrypts on any of their devices.

- **Recipient viewing platform is irrelevant** — vault-synced key means desktop
  web / mobile web / phone app all decrypt the same stream.
- **Sender publishing requires a live device.** Only a device actively running the
  publisher produces new points:
  - Desktop web: publishes only while the tab is open + foreground. Closing it
    stops publishing entirely (web has no background).
  - Phone native app (this feature): keeps publishing even when backgrounded/locked.
  - Phone mobile web: foreground-only.
- **Handoff gap:** between closing the desktop and opening the phone app, no device
  publishes, so the recipient sees the last point (stale) until the phone takes over.
- **Phone must register the share once:** native background publishing starts only
  after JS hands the share session to native, which happens when the user opens the
  share on the phone at least once. After that, native continues on its own.
- **Double-publish:** if desktop and phone are both open, both publish to the same
  grant (harmless, last-write-wins server-side). Dedupe deferred.

## Architecture (Approach A — extend the native plugin)

Chosen over adopting a community background-geolocation plugin: we already own the
native plugin, and the E2E + native-publish requirement means we write native code
regardless, so a third-party dependency (whose JS-callback / built-in-HTTP features
don't fit the E2E model) adds cost without benefit.

Four components:

1. **`HushhLocationPlugin.swift` (extended)** — Always auth,
   `allowsBackgroundLocationUpdates = true`, `pausesLocationUpdatesAutomatically =
   false`, Background Modes → Location capability.
2. **`LocationPublisher` (new, native Swift)** — on each CLLocation fix, runs ECIES
   per active grant (CryptoKit) and POSTs ciphertext via `URLSession`. Runs with no
   JS alive.
3. **JS ↔ native "share session" bridge** — when a share is active *and the app is
   foreground*, JS hands native a session config; native persists it and owns
   publishing while backgrounded.
4. **Foreground/background handoff** — JS keeps today's publish path in foreground;
   native takes over when hidden. Guarded so both don't hit the endpoint at once
   (native pauses while JS is foregrounding; JS's `visibilityState` guards already
   stop JS when hidden).

## Data flow

1. User enables background sharing on the phone (see UX). JS builds a **share
   session**:
   ```
   {
     vaultOwnerToken,
     publishEndpoint,
     grants: [{ grantId, recipientKeyId, recipientPublicKeyJwk }],
     minMoveMeters,
     minIntervalMs
   }
   ```
   and calls `HushhLocation.startBackgroundShare(session)`.
2. Native persists it (secure store / Keychain) and starts background location updates.
3. On each fix (throttled by the same move/interval thresholds JS uses today): for
   each grant → **CryptoKit ECIES** → POST `{ envelope }` to `publishEndpoint` with
   the Bearer token.
4. `HushhLocation.stopBackgroundShare()` on revoke / user toggle-off / no grants left.

## Crypto parity (correctness-critical)

Swift must produce envelopes **byte-compatible** with `encryption.ts:524`:

- Ephemeral `P256.KeyAgreement.PrivateKey()`; shared secret = **raw X-coordinate**
  (32 bytes, **no HKDF** — matches Web Crypto's ECDH→AES-GCM derivation, which uses
  the raw shared secret directly); use those 32 bytes as the AES-256 key.
- `AES.GCM.seal` with a random 12-byte IV; **concatenate ciphertext + 16-byte tag**
  (Web Crypto appends the tag to the ciphertext); base64url-encode.
- Export ephemeral public key to JWK (`kty`, `crv`, `x`, `y`).

**Validation:** golden test vectors — encrypt in Swift and decrypt with the
existing JS `decryptLocationEnvelope`, and vice-versa. This is the single place a
subtle mismatch silently breaks decryption, so it gets dedicated tests.

## iOS permissions & config

- `requestAlwaysAuthorization`.
- Info.plist: `NSLocationAlwaysAndWhenInUseUsageDescription`,
  `NSLocationWhenInUseUsageDescription`, `UIBackgroundModes: [location]`.
- Background Modes capability on the app target.
- `getPermissionState().background` stops being hardcoded `"foreground-only"` and
  reflects real `CLAuthorizationStatus` (`available` when `.authorizedAlways`).

## Auth token in the background

Native needs a valid Bearer token for the session lifetime. **Decision:** JS passes
the current `vaultOwnerToken`; native stores it and refreshes on `401` via the
app's existing refresh path (exact mechanism confirmed during planning). If refresh
fails, native buffers fixes (see Error handling) and surfaces a "re-auth needed"
state on next foreground.

## UX & product behavior

- **Explicit opt-in toggle** (decided): "Keep sharing when the app is closed" switch
  on the active-share screen — not automatic. Rationale: Always-location is a serious
  privacy ask, iOS shows strong prompts, and App Store review expects a clear,
  user-driven justification. Once on, it stays on for that share until revoked / toggled off.
- **Handoff-gap UX** (decided, in v1): recipient sees "Live — updated Xs ago" vs
  "Paused — last seen Xm ago" (driven by `capturedAt` staleness). Sender sees a nudge:
  "Open the app to resume live sharing" when no device is publishing.
- iOS blue status indicator while background-tracking is expected and acceptable.

## Error handling & offline buffering

Background POSTs fail often (tunnels, no signal). Native keeps a **small bounded
queue** (e.g. last N fixes / last few minutes), flushes on connectivity, drops
oldest beyond the cap and logs the drop count. New fixes are never blocked on a
stuck POST.

## Out of scope (v1)

- **Android** background service (designed-for, built later).
- **Per-grant drive overrides** in the background path (`drivePointForGrant`) —
  background publishes the *real* point; drive-to overrides remain foreground-only.
- **Recipient-side background** refresh (recipient still opens the app to see;
  unchanged).
- **Multi-publisher dedupe** beyond last-write-wins (noted, deferred).

## Testing

- **Swift:** crypto parity vectors, throttle logic, queue/flush, token-refresh-on-401.
- **JS:** share-session builder, start/stop bridge calls, `background` permission-state
  plumbing, foreground/background handoff.
- **Manual (physical device):** background + lock, drive a loop, confirm a recipient
  on a *different* platform sees the dot move; confirm handoff gap + resume.
