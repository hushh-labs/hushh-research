# Drive-to redesign + route map — design

**Date:** 2026-07-12
**Branch:** `fix/location-ui-bug-fixes`
**Status:** Approved

## Goal

Bring the One Location **Drive to** flow in line with the "Location Agent — Apple
Blue v2" reference design and add a real Google Map inside it that shows the
source → destination route. Preserve existing functionality (capture current
location, search a destination, pick who sees the drive, start sharing) while
presenting it in the cleaner single-card layout with a live ETA badge.

Today `DriveToFlow` (`hushh-webapp/components/one-location/redesign/drive-to-flow.tsx`)
is a pure intent form with **no map**. `LiveMap` exists and is reusable but
renders only a single marker and draws no route.

## Scope

In scope:
- Traffic-aware ETA on the backend Routes call + a `trafficLevel` classification.
- A new interactive `DriveRouteMap` component (two pins + route line + ETA badge)
  with the existing keyless iframe fallback for the iOS WebView.
- Restyle `DriveToFlow` to the reference layout; remove the duration chips from
  **this flow only** (default share duration = `2` hours).

Out of scope:
- Persisting `trafficLevel` into the encrypted envelope for recipients. The
  traffic label is preview-only for now. `DriveSharePayload` is unchanged.
- Duration chips in any other flow (Check-in, etc.) — untouched.

## Components

### 1. Backend — traffic-aware ETA

Files: `consent-protocol/hushh_mcp/services/google_maps_service.py` (`route_eta`),
`consent-protocol/api/routes/one/location.py` (`maps_route_eta`), and tests
(`tests/services/test_google_maps_service.py`, `tests/test_one_location_maps_routes.py`).

- Add `"routingPreference": "TRAFFIC_AWARE"` to the `computeRoutes` request body.
- Expand the field mask to
  `routes.duration,routes.staticDuration,routes.distanceMeters`.
- `duration` is now traffic-aware; `staticDuration` is the free-flow baseline.
- Classify `trafficLevel` from `ratio = duration / staticDuration`:
  - `ratio < 1.15` → `"light"`
  - `ratio < 1.40` → `"moderate"`
  - else → `"heavy"`
  - If `staticDuration` is missing/zero, `trafficLevel` is `null`.
- Return `{etaSeconds, distanceMeters, trafficLevel}`.

Frontend `OneLocationService.routeEta` (`hushh-webapp/lib/one-location/service.ts`)
gains the optional `trafficLevel?: "light" | "moderate" | "heavy" | null` in its
return type. The `/api/one/location/maps/route-eta` handler passes it through.
Existing downstream `drivePointForGrant` in `app/one/location/page.tsx` is
untouched — it reads only `etaSeconds` / `distanceMeters` and ignores the new
field.

### 2. `DriveRouteMap` (new)

Files: `hushh-webapp/components/one-location/redesign/drive-route-map.tsx` +
`__tests__/drive-route-map.test.tsx`.

Props:
- `origin: LatLngLiteral`
- `destination: DriveDestination`
- `eta?: { etaSeconds: number; distanceMeters: number; trafficLevel?: "light" | "moderate" | "heavy" | null } | null`
- `className?: string`

Behavior:
- Uses the existing `useGoogleMaps()` hook.
- When `status === "ready"`: create an interactive `google.maps.Map`, add two
  markers (blue dot origin, dark pin destination), render the route via
  `google.maps.DirectionsService` + `DirectionsRenderer`. If the Directions
  request fails (API not enabled / no route), fall back to a straight
  `google.maps.Polyline` between the two points. `fitBounds` to both points with
  padding.
- When `status !== "ready"` (iOS `App://` WebView, missing key, auth failure):
  render the **keyless directions iframe**
  `https://www.google.com/maps?saddr=<lat,lng>&daddr=<lat,lng>&output=embed`.
  A `googleMapsDirectionsEmbedUrl(origin, destination)` helper is added to
  `hushh-webapp/lib/one-location/maps-urls.ts`.
- ETA badge overlaid top-right when `eta` is present:
  `"<min> min · <km> km · <trafficLevel> traffic"` (traffic clause omitted when
  `trafficLevel` is null). Distance rendered in km to one decimal.

### 3. `DriveToFlow` restyle

File: `hushh-webapp/components/one-location/redesign/drive-to-flow.tsx` + test.

- Keep: destination search + recents, capture-location button, who-sees
  checklist, `vm.onDriveTo`.
- Remove the `DRIVE_DURATIONS` chips section; default `durationValue = "2"`.
- Layout:
  - Before a destination is chosen: destination search (as today).
  - After a destination is chosen: a single card containing `DriveRouteMap` on
    top, then two rows below — "Starting from · Live location" and
    "Heading to · <destination label>" — matching the reference.
  - "WHO SEES YOUR DRIVE" checklist card unchanged in behavior, restyled.
  - Blue pill "Start sharing drive" action button.
- Fetch `routeEta` (debounced ~400ms) whenever both `vm.myLocationPoint` and
  `destination` exist; store `{etaSeconds, distanceMeters, trafficLevel}` in
  local state and pass to `DriveRouteMap`. Refetch when either endpoint changes.

## Data flow

1. User captures live location → `vm.myLocationPoint` (origin).
2. User searches + selects a destination → `DriveDestination` (Places details).
3. Both present → debounced `OneLocationService.routeEta(...)` → local `eta` state.
4. `DriveRouteMap` renders route + badge; rows show origin/destination labels.
5. "Start sharing drive" → `vm.onDriveTo(destination, checkedIds, "2")`
   (unchanged handler; ETA continues to recompute downstream as today).

## Error handling / fallbacks

- No origin captured yet → map area shows a capture prompt (no route drawn);
  badge hidden.
- `routeEta` failure → badge hidden, origin/destination rows still render.
- Maps JS unavailable → keyless directions iframe embed.
- Directions request failure with Maps JS ready → straight polyline fallback.

## Testing

- Backend: `trafficLevel` classification at boundaries (light/moderate/heavy,
  and null when `staticDuration` absent); field mask + routingPreference present
  in the outgoing request.
- `DriveRouteMap`: ready path adds two markers + attempts a route; not-ready path
  renders an iframe whose `src` contains both `saddr` and `daddr`; badge text
  formats min/km and omits the traffic clause when `trafficLevel` is null.
- `drive-to-flow.test.tsx`: duration chips absent; map appears only after a
  destination is chosen; badge renders when `routeEta` resolves; start still
  calls `onDriveTo` with duration `"2"`.
