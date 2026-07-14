# Pickup Live Route Map — viewer-side dual-location map with self-recomputing ETA

**Date:** 2026-07-14
**Branch:** `fix/pick-me-up`
**Status:** Design approved, pending spec review

## Problem

In the One Location "pick me up" flow, the requester asks a trusted contact to
pick them up. The helper taps **"I'm on my way"**, which creates a reverse
`pickup_enroute` drive grant that streams the helper's live location back to the
requester. The requester's en-route card shows the helper's moving position and
an ETA.

The ETA frequently shows **"ETA unavailable"**, especially after a location
refresh.

### Root cause

The ETA is computed on the **helper's** side and shipped inside the encrypted
`point.drive.etaSeconds` payload:

- `driveEtaText(etaSeconds)` (`app/one/location/drive-eta.ts`) is the only
  producer of the literal `"ETA unavailable"`; it returns that string whenever
  `etaSeconds == null`.
- The helper's drive session lives in an in-memory `useRef`
  (`driveSessionRef`, `app/one/location/page.tsx`). When the helper's page
  refreshes/remounts, the location watch loop resumes but the session is gone,
  so `drivePointForGrant` publishes points **without** the `drive` payload →
  the requester's `etaSeconds` becomes `null` → "ETA unavailable".
- A `drive-session-store.ts` rehydration mechanism exists but has timing gaps
  (grants not loaded yet, session predates grants), so it does not reliably
  restore the shipped ETA.

Crucially, the helper's **raw live coordinates keep streaming** even when the
`drive` payload is missing — only the ETA field drops. The requester therefore
already has both endpoints needed to compute the ETA itself: the helper's
current position and the requester's own pickup point.

## Goal

Replace the requester's single-point en-route map preview with a new component
that maps **both** locations (helper + pickup point), draws the route between
them, and **recomputes the driving ETA on the requester's (viewer's) side** as
the helper's position streams in — the way a navigation app does. The ETA must
never fall back to "unavailable" due to a helper-side refresh.

## Scope

**In scope**

- New viewer-side component `PickupLiveRouteMap` on the requester's en-route
  card (replaces the current single-point `LiveMap` preview in place).
- Viewer-side ETA recomputation via the existing server `routeEta` proxy.
- Wiring changes to surface the requester's own pickup point to the card.

**Out of scope** (explicit product decision)

- Helper-side drive-session persistence hardening.
- The public share-link / token viewer
  (`app/one/location/request/[token]/page-client.tsx`) — keeps today's
  behavior (still reads the shipped `drive.etaSeconds`).
- The helper's own ETA badge — keeps today's behavior.

## ETA semantics

Driving route ETA (real road-network travel time), via the **server**
`OneLocationService.routeEta` proxy — not client-side `DirectionsService`.
Rationale: on the native iOS WKWebView the Google Maps JS SDK commonly degrades
to a keyless iframe embed, so client-side `DirectionsService` is unreliable on
device; the server routing proxy (`POST /api/one/location/maps/route-eta`) is
the dependable path. Traffic-aware ETA is not required for this change.

## Architecture & data flow

```
helper's live point (streamed via pickup_enroute grant, ~5s poll)
        │                          requester's own pickup point (known locally)
        ▼                                            │
   PickupLiveRouteMap ◄─────────────────────────────┘
        │  usePickupEta: routeEta(helper -> pickup), throttled
        ▼
   DriveRouteMap (both markers + route line + ETA badge)  +  driveEtaText label
```

ETA is a pure function of *(helper's current position → requester's pickup
point)*, computed where it is displayed. Because the helper's coordinates keep
streaming regardless of the helper's session state, the requester's ETA is
decoupled from the fragile helper-side drive session.

## Components & interfaces

### New: `components/one-location/redesign/pickup-live-route-map.tsx`

```ts
PickupLiveRouteMap({
  helperPoint,      // LocationPoint — helper's live position; updates on poll
  pickupPoint,      // LocationPoint — requester's pickup destination
  seedEtaSeconds?,  // number | null — helper's shipped ETA, shown instantly
                    //   before the first viewer-side recompute completes
  className?,
})
```

Rendering **reuses `DriveRouteMap`**
(`components/one-location/redesign/drive-route-map.tsx`) with
`origin=helperPoint`, `destination=pickupPoint`, and `eta=<recomputed RouteEta>`.
`DriveRouteMap` already renders both endpoints, the driving route
(`DirectionsService` → `DirectionsRenderer`), the ETA badge (`driveBadgeText`),
and the iOS-iframe / straight-`Polyline` fallbacks. The card's text ETA uses the
recomputed value through the existing `driveEtaText`.

### New hook: `usePickupEta(helperPoint, pickupPoint, seedEtaSeconds)`

Owns the viewer-side recompute loop. Returns
`{ etaSeconds, distanceMeters, status }` where
`status ∈ { "seeded", "live", "updating", "stale" }`.

Behavior:

1. **Seed** display from `seedEtaSeconds` so there is never an empty first frame.
2. **Recompute** `OneLocationService.routeEta({ origin: helperPoint, destination: pickupPoint })`
   when any of: first run; helper moved ≥ recompute-move threshold; ≥ recompute
   interval elapsed since last successful compute.
   - Reuse the existing throttle constants
     `DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS` (60_000) and
     `DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS` (250) — export/share them rather than
     duplicating. This protects Maps quota against the ~5s poll cadence.
3. **Retain last-known ETA on failure** — a failed `routeEta` never flips a good
   ETA back to `null`/"unavailable".
4. **Abort stale work** — an `AbortController` cancels in-flight/superseded calls
   on point change and on unmount; guard against setState-after-unmount.

## Wiring / placement

- `location-redesign-hub.tsx` — in the `PickupEnRouteCard` render
  (~lines 578–630): replace the single-point `renderMapPreview(...)` + shipped
  `driveEtaText(etaSeconds)` with `<PickupLiveRouteMap … />`.
- `components/one-location/redesign/pickup-enroute.ts` — extend
  `deriveEnRouteHelpers(...)` to also surface, per en-route helper:
  - `pickupPoint` — the requester's own outbound `pick_me_up` grant point
    (the destination), and
  - `seedEtaSeconds` — the shipped `point.drive?.etaSeconds` (may be `null`).
- **Verification during implementation:** confirm the requester has plaintext
  access to their own pickup coordinates on this screen. They own the outbound
  `pick_me_up` grant (and `pickupSessionRef`/`pickupPointForGrant` hold any
  fixed/adjusted spot), so this is expected to be available; if the point is only
  present in encrypted form, decrypt it the same way the outbound preview does.

## Edge cases & error handling

- **No helper point yet** → keep the existing "waiting for location" empty state;
  do not call `routeEta`.
- **No pickup point** → gracefully fall back to today's single-point `LiveMap`
  of the helper (no regression, no route/ETA).
- **`routeEta` fails with no prior value and no seed** → render the helper point
  with a soft "ETA updating…" label rather than "ETA unavailable".
- **Arrival** → `driveEtaText` already renders `< 60s` as "Arriving now".
- **Transient API failure after a good value** → keep showing the last-known ETA
  (see hook behavior #3).

## Testing

Follow existing patterns (vitest; `__tests__` / co-located tests).

**Hook (`usePickupEta`):**
- Seeds display from `seedEtaSeconds` on first render.
- Recomputes when the helper moves ≥ the move threshold.
- Throttles: no recompute within the interval and below the move threshold.
- Retains last-known ETA when `routeEta` rejects.
- Never emits `null` once a value has been established.
- Aborts a superseded/in-flight request when the point changes or on unmount.

**Component (`PickupLiveRouteMap`):**
- Renders both endpoints and the recomputed ETA badge/text when both points
  are present.
- Degrades to single-point `LiveMap` when `pickupPoint` is absent.
- Shows "ETA updating…" (not "unavailable") when no ETA is available yet.

## Reuse summary

| Concern | Reused artifact |
| --- | --- |
| Route + both markers + ETA badge rendering | `DriveRouteMap`, `driveBadgeText` (`redesign/drive-route-map.tsx`) |
| ETA number (server, iOS-safe) | `OneLocationService.routeEta` (`lib/one-location/service.ts`) |
| ETA label formatting | `driveEtaText` (`app/one/location/drive-eta.ts`) |
| Recompute throttle constants | `DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS`, `DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS` |
| En-route pairing / point derivation | `deriveEnRouteHelpers` (`redesign/pickup-enroute.ts`) |
| Single-point fallback | `LiveMap` (`components/one-location/live-map.tsx`) |
