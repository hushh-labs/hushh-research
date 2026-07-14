# Pickup Live Route Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the requester's single-point en-route map with a dual-location live map that recomputes the driving ETA on the viewer's side, so the ETA never falls back to "ETA unavailable" after a helper-side refresh.

**Architecture:** The requester already receives the helper's live coordinates continuously; only the shipped `drive.etaSeconds` drops on helper refresh. We compute the ETA on the requester's side from *(helper's current position → requester's pickup point)* via the server `routeEta` proxy (iOS-reliable). A pure throttle helper decides when to recompute, a `usePickupEta` hook owns the recompute loop and last-known-value resilience, a presentational `PickupLiveRouteMap` renders both points + route + ETA badge (reusing `DriveRouteMap`), and a thin `PickupEnRouteCardLive` container wires the hook's ETA into both the card header text and the map badge.

**Tech Stack:** Next.js (React client components), TypeScript, Google Maps JS API (via existing `DriveRouteMap`/`LiveMap`), Vitest 4 + @testing-library/react 16 (jsdom).

## Global Constraints

- Lint runs with **`--max-warnings=0`** — every commit must be warning-clean.
- ETA source is the **server** proxy `OneLocationService.routeEta` only — never client-side `google.maps.DirectionsService` for the number (the iOS WKWebView degrades the SDK to an iframe). Route *rendering* may use the SDK via the existing `DriveRouteMap` (it already falls back gracefully).
- Recompute throttle values (verbatim): `DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS = 60_000`, `DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS = 250`.
- Out of scope: helper-side drive-session persistence, the public token viewer (`app/one/location/request/[token]/page-client.tsx`), and the helper's own ETA badge. Do not modify them.
- Tests are co-located under `__tests__/` next to the unit (existing pattern: `lib/one-location/__tests__/`, `components/one-location/__tests__/`).
- Run a single test file with: `npx vitest run <path>`.
- Reused type/function signatures (do not redefine):
  - `type PlainLocationPoint = { latitude: number; longitude: number; accuracyM?: number | null; capturedAt: string; sourcePlatform: LocationSourcePlatform; drive?: DriveSharePayload | null }` (`lib/one-location/types.ts`)
  - `type RouteEta = { etaSeconds: number; distanceMeters: number; trafficLevel?: TrafficLevel | null }` (`lib/one-location/types.ts`)
  - `type DriveDestination = { label: string; latitude: number; longitude: number; placeId?: string | null }` (`lib/one-location/types.ts`)
  - `type LatLngLiteral = { lat: number; lng: number }` (`lib/one-location/marker-interpolation.ts`)
  - `function haversineMeters(a: LatLngLiteral, b: LatLngLiteral): number` (`lib/one-location/marker-interpolation.ts`)
  - `function locationLatLng(point: PlainLocationPoint): LatLngLiteral` (`lib/one-location/maps-urls.ts`)
  - `function driveEtaText(etaSeconds: number | null): string` (`app/one/location/drive-eta.ts`)
  - `DriveRouteMap({ origin: LatLngLiteral; destination: DriveDestination; eta?: RouteEta | null; className?: string })` (`components/one-location/redesign/drive-route-map.tsx`)
  - `OneLocationService.routeEta({ vaultOwnerToken: string; originLat: number; originLng: number; destLat: number; destLng: number }): Promise<RouteEta>` (`lib/one-location/service.ts`)

---

### Task 1: Shared ETA recompute throttle module

Extract the recompute-timing rule into a pure, testable helper so both the existing publish loop and the new viewer hook share one source of truth.

**Files:**
- Create: `hushh-webapp/lib/one-location/eta-recompute.ts`
- Test: `hushh-webapp/lib/one-location/__tests__/eta-recompute.test.ts`
- Modify: `hushh-webapp/app/one/location/page.tsx` (replace the two local `const` declarations at ~lines 228–229 with an import)

**Interfaces:**
- Produces:
  - `const DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS: number` (= 60_000)
  - `const DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS: number` (= 250)
  - `function shouldRecomputeEta(params: { lastComputedAt: number | null; lastOrigin: LatLngLiteral | null; nextOrigin: LatLngLiteral; now: number }): boolean`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/lib/one-location/__tests__/eta-recompute.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS,
  DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS,
  shouldRecomputeEta,
} from "../eta-recompute";

const ORIGIN = { lat: 40.7518, lng: -74.0506 };

describe("shouldRecomputeEta", () => {
  it("recomputes on the first call (no prior compute)", () => {
    expect(
      shouldRecomputeEta({ lastComputedAt: null, lastOrigin: null, nextOrigin: ORIGIN, now: 1_000 }),
    ).toBe(true);
  });

  it("skips when within the interval and below the move threshold", () => {
    expect(
      shouldRecomputeEta({
        lastComputedAt: 1_000,
        lastOrigin: ORIGIN,
        nextOrigin: { lat: ORIGIN.lat + 0.0001, lng: ORIGIN.lng }, // ~11 m
        now: 1_000 + 5_000,
      }),
    ).toBe(false);
  });

  it("recomputes once the move threshold is exceeded", () => {
    expect(
      shouldRecomputeEta({
        lastComputedAt: 1_000,
        lastOrigin: ORIGIN,
        nextOrigin: { lat: ORIGIN.lat + 0.01, lng: ORIGIN.lng }, // ~1.1 km
        now: 1_000 + 5_000,
      }),
    ).toBe(true);
  });

  it("recomputes once the interval has elapsed", () => {
    expect(
      shouldRecomputeEta({
        lastComputedAt: 1_000,
        lastOrigin: ORIGIN,
        nextOrigin: ORIGIN,
        now: 1_000 + DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  it("exposes the verbatim constants", () => {
    expect(DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS).toBe(60_000);
    expect(DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS).toBe(250);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/eta-recompute.test.ts`
Expected: FAIL — cannot resolve `../eta-recompute`.

- [ ] **Step 3: Write minimal implementation**

Create `hushh-webapp/lib/one-location/eta-recompute.ts`:

```ts
import { haversineMeters, type LatLngLiteral } from "./marker-interpolation";

/** How often the drive/pickup ETA may be recomputed while roughly stationary. */
export const DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS = 60_000;
/** Movement (meters) that forces an ETA recompute sooner than the interval. */
export const DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS = 250;

/**
 * Pure decision: should we recompute the ETA for a new origin? True on the
 * first call, when the origin has moved >= the move threshold, or when the
 * interval has elapsed since the last successful compute.
 */
export function shouldRecomputeEta(params: {
  lastComputedAt: number | null;
  lastOrigin: LatLngLiteral | null;
  nextOrigin: LatLngLiteral;
  now: number;
}): boolean {
  const { lastComputedAt, lastOrigin, nextOrigin, now } = params;
  if (lastComputedAt == null || lastOrigin == null) return true;
  const movedMeters = haversineMeters(lastOrigin, nextOrigin);
  const sinceMs = now - lastComputedAt;
  return (
    movedMeters >= DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS ||
    sinceMs >= DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/eta-recompute.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: DRY up page.tsx to import the shared constants**

In `hushh-webapp/app/one/location/page.tsx`, delete these two local declarations (~lines 228–229):

```ts
const DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS = 60_000;
const DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS = 250;
```

Add to the existing `@/lib/one-location/*` import block near the top of the file:

```ts
import {
  DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS,
  DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS,
} from "@/lib/one-location/eta-recompute";
```

- [ ] **Step 6: Verify typecheck + existing usage still compiles**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no errors (the two constants are now imported; their use at the old lines ~2613–2614 is unchanged).

- [ ] **Step 7: Commit**

```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research
git add hushh-webapp/lib/one-location/eta-recompute.ts \
        hushh-webapp/lib/one-location/__tests__/eta-recompute.test.ts \
        hushh-webapp/app/one/location/page.tsx
git commit -m "feat(one-location): shared ETA recompute throttle helper

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 2: Surface the requester's pickup point in en-route derivation

`deriveEnRouteHelpers` already pairs the helper's `pickup_enroute` grant to the requester's outbound `pick_me_up` grant. Add the requester's own pickup point (needed as the ETA destination) to each derived helper.

**Files:**
- Modify: `hushh-webapp/components/one-location/redesign/pickup-enroute.ts`
- Test: `hushh-webapp/components/one-location/redesign/__tests__/pickup-enroute.test.ts`

**Interfaces:**
- Consumes: `decryptedPoints: Record<string, PlainLocationPoint>` (already a param), `outboundGrant.id`.
- Produces: `EnRouteHelper` gains `pickupPoint: PlainLocationPoint | null` — the decrypted point of the requester's outbound `pick_me_up` grant, or `null` if not decrypted/available. Existing fields unchanged (`etaSeconds` remains the shipped seed).

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/components/one-location/redesign/__tests__/pickup-enroute.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveEnRouteHelpers } from "../pickup-enroute";
import type { OneLocationGrant, PlainLocationPoint } from "@/lib/one-location/types";

function point(lat: number, lng: number, etaSeconds?: number): PlainLocationPoint {
  return {
    latitude: lat,
    longitude: lng,
    capturedAt: "2026-07-14T00:00:00.000Z",
    sourcePlatform: "web",
    drive:
      etaSeconds == null
        ? null
        : {
            destination: { label: "Pickup", latitude: 0, longitude: 0 },
            etaSeconds,
            distanceMeters: 1000,
            etaComputedAt: "2026-07-14T00:00:00.000Z",
          },
  } as PlainLocationPoint;
}

function grant(over: Partial<OneLocationGrant>): OneLocationGrant {
  return {
    id: "g",
    ownerUserId: "owner",
    recipientUserId: "me",
    shareKind: "pick_me_up",
    status: "active",
  } as unknown as OneLocationGrant;
}

const received: OneLocationGrant = grant({
  id: "recv-1",
  ownerUserId: "helper-1",
  recipientUserId: "me",
  shareKind: "pickup_enroute",
});
const outbound: OneLocationGrant = grant({
  id: "out-1",
  ownerUserId: "me",
  recipientUserId: "helper-1",
  shareKind: "pick_me_up",
});

it("includes the requester's own pickup point from the outbound grant", () => {
  const helpers = deriveEnRouteHelpers({
    receivedGrants: [received],
    activeOwnerGrants: [outbound],
    decryptedPoints: {
      "recv-1": point(40.75, -74.05, 300), // helper live point + shipped ETA
      "out-1": point(40.76, -74.04), // requester pickup point
    },
    labelFor: () => "Alex",
  });
  expect(helpers).toHaveLength(1);
  expect(helpers[0].pickupPoint).toEqual(
    expect.objectContaining({ latitude: 40.76, longitude: -74.04 }),
  );
  expect(helpers[0].etaSeconds).toBe(300); // seed unchanged
});

it("sets pickupPoint to null when the outbound point is not decrypted", () => {
  const helpers = deriveEnRouteHelpers({
    receivedGrants: [received],
    activeOwnerGrants: [outbound],
    decryptedPoints: { "recv-1": point(40.75, -74.05, 300) },
    labelFor: () => "Alex",
  });
  expect(helpers[0].pickupPoint).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/pickup-enroute.test.ts`
Expected: FAIL — `pickupPoint` is `undefined` (property does not exist yet).

- [ ] **Step 3: Add the field to the type and derivation**

In `hushh-webapp/components/one-location/redesign/pickup-enroute.ts`, add to the `EnRouteHelper` type (after `point`):

```ts
  /** The requester's own pickup destination (their outbound pick_me_up point), or null. */
  pickupPoint: PlainLocationPoint | null;
```

In the returned object inside `.flatMap(...)`, add the field (after `point,`):

```ts
          pickupPoint: decryptedPoints[outboundGrant.id] ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/pickup-enroute.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research
git add hushh-webapp/components/one-location/redesign/pickup-enroute.ts \
        hushh-webapp/components/one-location/redesign/__tests__/pickup-enroute.test.ts
git commit -m "feat(one-location): expose requester pickup point in en-route derivation

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 3: `usePickupEta` recompute hook

Owns the viewer-side recompute loop: seed → throttle → fetch → keep-last-on-failure.

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/use-pickup-eta.ts`
- Test: `hushh-webapp/components/one-location/redesign/__tests__/use-pickup-eta.test.tsx`

**Interfaces:**
- Consumes: `shouldRecomputeEta` (Task 1), `locationLatLng`, `PlainLocationPoint`, `RouteEta`, `LatLngLiteral`.
- Produces:
  - `type PickupEtaStatus = "idle" | "seeded" | "updating" | "live" | "stale"`
  - `interface PickupEtaState { eta: RouteEta | null; status: PickupEtaStatus }`
  - `function usePickupEta(params: { helperPoint: PlainLocationPoint | null; pickupPoint: PlainLocationPoint | null; seedEtaSeconds: number | null; fetchEta: (origin: LatLngLiteral, dest: LatLngLiteral) => Promise<RouteEta> }): PickupEtaState`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/components/one-location/redesign/__tests__/use-pickup-eta.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePickupEta } from "../use-pickup-eta";
import type { PlainLocationPoint, RouteEta } from "@/lib/one-location/types";

function pt(lat: number, lng: number): PlainLocationPoint {
  return {
    latitude: lat,
    longitude: lng,
    capturedAt: "2026-07-14T00:00:00.000Z",
    sourcePlatform: "web",
  } as PlainLocationPoint;
}
const HELPER = pt(40.75, -74.05);
const PICKUP = pt(40.76, -74.04);
const ETA: RouteEta = { etaSeconds: 240, distanceMeters: 1800 };

it("seeds the ETA from seedEtaSeconds before any fetch", () => {
  const fetchEta = vi.fn().mockResolvedValue(ETA);
  const { result } = renderHook(() =>
    usePickupEta({ helperPoint: null, pickupPoint: null, seedEtaSeconds: 360, fetchEta }),
  );
  expect(result.current.status).toBe("seeded");
  expect(result.current.eta?.etaSeconds).toBe(360);
  expect(fetchEta).not.toHaveBeenCalled();
});

it("recomputes via fetchEta when both points are present", async () => {
  const fetchEta = vi.fn().mockResolvedValue(ETA);
  const { result } = renderHook(() =>
    usePickupEta({ helperPoint: HELPER, pickupPoint: PICKUP, seedEtaSeconds: null, fetchEta }),
  );
  await waitFor(() => expect(result.current.status).toBe("live"));
  expect(fetchEta).toHaveBeenCalledTimes(1);
  expect(result.current.eta).toEqual(ETA);
});

it("keeps the last-known ETA when a later fetch fails (never 'unavailable')", async () => {
  const fetchEta = vi
    .fn()
    .mockResolvedValueOnce(ETA)
    .mockRejectedValueOnce(new Error("network"));
  const { result, rerender } = renderHook(
    ({ helper }) =>
      usePickupEta({ helperPoint: helper, pickupPoint: PICKUP, seedEtaSeconds: null, fetchEta }),
    { initialProps: { helper: HELPER } },
  );
  await waitFor(() => expect(result.current.eta).toEqual(ETA));
  // Move far enough to force a recompute (~1.1 km), which will reject.
  rerender({ helper: pt(40.77, -74.05) });
  await waitFor(() => expect(result.current.status).toBe("stale"));
  expect(result.current.eta).toEqual(ETA); // retained
});

it("does not fetch when either point is missing", () => {
  const fetchEta = vi.fn().mockResolvedValue(ETA);
  renderHook(() =>
    usePickupEta({ helperPoint: HELPER, pickupPoint: null, seedEtaSeconds: null, fetchEta }),
  );
  expect(fetchEta).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/use-pickup-eta.test.tsx`
Expected: FAIL — cannot resolve `../use-pickup-eta`.

- [ ] **Step 3: Write the hook**

Create `hushh-webapp/components/one-location/redesign/use-pickup-eta.ts`:

```ts
"use client";

import { useEffect, useRef, useState } from "react";

import { locationLatLng } from "@/lib/one-location/maps-urls";
import { shouldRecomputeEta } from "@/lib/one-location/eta-recompute";
import type { LatLngLiteral } from "@/lib/one-location/marker-interpolation";
import type { PlainLocationPoint, RouteEta } from "@/lib/one-location/types";

export type PickupEtaStatus = "idle" | "seeded" | "updating" | "live" | "stale";

export interface PickupEtaState {
  eta: RouteEta | null;
  status: PickupEtaStatus;
}

/**
 * Viewer-side ETA for a pickup: recomputes routeEta(helper -> pickup) as the
 * helper moves, throttled by shouldRecomputeEta. Seeds from the helper's last
 * shipped ETA and NEVER downgrades a good value to null on a failed refresh, so
 * the requester never sees "ETA unavailable" once an ETA exists.
 */
export function usePickupEta(params: {
  helperPoint: PlainLocationPoint | null;
  pickupPoint: PlainLocationPoint | null;
  seedEtaSeconds: number | null;
  fetchEta: (origin: LatLngLiteral, dest: LatLngLiteral) => Promise<RouteEta>;
}): PickupEtaState {
  const { helperPoint, pickupPoint, seedEtaSeconds, fetchEta } = params;

  const [state, setState] = useState<PickupEtaState>(() =>
    seedEtaSeconds != null && Number.isFinite(seedEtaSeconds)
      ? { eta: { etaSeconds: seedEtaSeconds, distanceMeters: 0 }, status: "seeded" }
      : { eta: null, status: "idle" },
  );

  const lastComputedAtRef = useRef<number | null>(null);
  const lastOriginRef = useRef<LatLngLiteral | null>(null);
  const etaRef = useRef<RouteEta | null>(state.eta);
  etaRef.current = state.eta;

  const helperLat = helperPoint?.latitude ?? null;
  const helperLng = helperPoint?.longitude ?? null;
  const pickupLat = pickupPoint?.latitude ?? null;
  const pickupLng = pickupPoint?.longitude ?? null;

  useEffect(() => {
    if (!helperPoint || !pickupPoint) return;
    const origin = locationLatLng(helperPoint);
    const dest = locationLatLng(pickupPoint);
    if (
      !shouldRecomputeEta({
        lastComputedAt: lastComputedAtRef.current,
        lastOrigin: lastOriginRef.current,
        nextOrigin: origin,
        now: Date.now(),
      })
    ) {
      return;
    }

    let cancelled = false;
    setState((s) => ({ eta: s.eta, status: "updating" }));
    fetchEta(origin, dest)
      .then((eta) => {
        if (cancelled) return;
        lastComputedAtRef.current = Date.now();
        lastOriginRef.current = origin;
        setState({ eta, status: "live" });
      })
      .catch(() => {
        if (cancelled) return;
        // Keep the last-known ETA; a failed refresh must not show "unavailable".
        setState({ eta: etaRef.current, status: etaRef.current ? "stale" : "idle" });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helperLat, helperLng, pickupLat, pickupLng, fetchEta]);

  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/use-pickup-eta.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research
git add hushh-webapp/components/one-location/redesign/use-pickup-eta.ts \
        hushh-webapp/components/one-location/redesign/__tests__/use-pickup-eta.test.tsx
git commit -m "feat(one-location): usePickupEta viewer-side ETA recompute hook

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 4: `PickupLiveRouteMap` presentational component

Renders both points + route + ETA badge by reusing `DriveRouteMap`; degrades to a supplied single-point fallback when the pickup point is unknown. Pure presentation — ETA is a prop (no hook), so it is trivially testable.

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/pickup-live-route-map.tsx`
- Test: `hushh-webapp/components/one-location/redesign/__tests__/pickup-live-route-map.test.tsx`

**Interfaces:**
- Consumes: `DriveRouteMap`, `locationLatLng`, `PlainLocationPoint`, `RouteEta`.
- Produces:
  - `interface PickupLiveRouteMapProps { helperPoint: PlainLocationPoint; pickupPoint: PlainLocationPoint | null; eta: RouteEta | null; fallbackPreview: ReactNode; className?: string }`
  - `function PickupLiveRouteMap(props: PickupLiveRouteMapProps): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/components/one-location/redesign/__tests__/pickup-live-route-map.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PickupLiveRouteMap } from "../pickup-live-route-map";
import type { PlainLocationPoint, RouteEta } from "@/lib/one-location/types";

// Stub DriveRouteMap so the test asserts wiring, not Google Maps internals.
vi.mock("../drive-route-map", () => ({
  DriveRouteMap: (props: { origin: { lat: number }; destination: { latitude: number }; eta: RouteEta | null }) => (
    <div
      data-testid="drive-route-map"
      data-origin-lat={props.origin.lat}
      data-dest-lat={props.destination.latitude}
      data-eta={props.eta ? props.eta.etaSeconds : "none"}
    />
  ),
}));

function pt(lat: number, lng: number): PlainLocationPoint {
  return { latitude: lat, longitude: lng, capturedAt: "x", sourcePlatform: "web" } as PlainLocationPoint;
}
const ETA: RouteEta = { etaSeconds: 300, distanceMeters: 2000 };

it("renders DriveRouteMap with both points and the ETA when pickup is known", () => {
  render(
    <PickupLiveRouteMap
      helperPoint={pt(40.75, -74.05)}
      pickupPoint={pt(40.76, -74.04)}
      eta={ETA}
      fallbackPreview={<div data-testid="fallback" />}
    />,
  );
  const map = screen.getByTestId("drive-route-map");
  expect(map.getAttribute("data-origin-lat")).toBe("40.75");
  expect(map.getAttribute("data-dest-lat")).toBe("40.76");
  expect(map.getAttribute("data-eta")).toBe("300");
  expect(screen.queryByTestId("fallback")).toBeNull();
});

it("renders the fallback preview (single point) when pickup is unknown", () => {
  render(
    <PickupLiveRouteMap
      helperPoint={pt(40.75, -74.05)}
      pickupPoint={null}
      eta={null}
      fallbackPreview={<div data-testid="fallback" />}
    />,
  );
  expect(screen.getByTestId("fallback")).toBeInTheDocument();
  expect(screen.queryByTestId("drive-route-map")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/pickup-live-route-map.test.tsx`
Expected: FAIL — cannot resolve `../pickup-live-route-map`.

- [ ] **Step 3: Write the component**

Create `hushh-webapp/components/one-location/redesign/pickup-live-route-map.tsx`:

```tsx
"use client";

import type { ReactNode } from "react";

import { locationLatLng } from "@/lib/one-location/maps-urls";
import type { PlainLocationPoint, RouteEta } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

import { DriveRouteMap } from "./drive-route-map";

export interface PickupLiveRouteMapProps {
  /** The helper's live position (route origin). */
  helperPoint: PlainLocationPoint;
  /** The requester's pickup destination, or null when not yet known. */
  pickupPoint: PlainLocationPoint | null;
  /** Recomputed ETA to badge on the map, or null while none is available. */
  eta: RouteEta | null;
  /** Single-point preview used when pickupPoint is unknown (no regression). */
  fallbackPreview: ReactNode;
  className?: string;
}

/**
 * Viewer-side pickup map: shows the helper AND the requester's pickup point with
 * the driving route + a recomputed ETA badge. Falls back to the caller-supplied
 * single-point preview when the pickup point is unavailable.
 */
export function PickupLiveRouteMap({
  helperPoint,
  pickupPoint,
  eta,
  fallbackPreview,
  className,
}: PickupLiveRouteMapProps) {
  if (!pickupPoint) {
    return <>{fallbackPreview}</>;
  }
  return (
    <DriveRouteMap
      origin={locationLatLng(helperPoint)}
      destination={{
        label: "Pickup",
        latitude: pickupPoint.latitude,
        longitude: pickupPoint.longitude,
      }}
      eta={eta}
      className={cn("h-44 w-full overflow-hidden rounded-2xl", className)}
    />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/pickup-live-route-map.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research
git add hushh-webapp/components/one-location/redesign/pickup-live-route-map.tsx \
        hushh-webapp/components/one-location/redesign/__tests__/pickup-live-route-map.test.tsx
git commit -m "feat(one-location): PickupLiveRouteMap dual-location presentational map

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 5: `PickupEnRouteCardLive` container + wire into the hub

A thin container that calls `usePickupEta` once per helper and feeds the recomputed ETA into BOTH the card header text and the map badge, then replace the inline en-route card block in the hub with it.

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/pickup-enroute-card-live.tsx`
- Test: `hushh-webapp/components/one-location/redesign/__tests__/pickup-enroute-card-live.test.tsx`
- Modify: `hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx` (the `enRouteHelpers.map(...)` block at ~lines 621–630)

**Interfaces:**
- Consumes: `usePickupEta` (Task 3), `PickupLiveRouteMap` (Task 4), `PickupEnRouteCard` (`./cards`), `driveEtaText`, `RouteEta`, `PlainLocationPoint`, `LatLngLiteral`.
- Produces:
  - `interface PickupEnRouteCardLiveProps { helperName: string; helperPoint: PlainLocationPoint; pickupPoint: PlainLocationPoint | null; seedEtaSeconds: number | null; fetchEta: (origin: LatLngLiteral, dest: LatLngLiteral) => Promise<RouteEta>; fallbackPreview: ReactNode; onCancel: () => void }`
  - `function PickupEnRouteCardLive(props: PickupEnRouteCardLiveProps): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/components/one-location/redesign/__tests__/pickup-enroute-card-live.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PickupEnRouteCardLive } from "../pickup-enroute-card-live";
import type { PlainLocationPoint, RouteEta } from "@/lib/one-location/types";

// Stub the map so we assert the card text (ETA) without Google Maps.
vi.mock("../pickup-live-route-map", () => ({
  PickupLiveRouteMap: (props: { eta: RouteEta | null }) => (
    <div data-testid="map" data-eta={props.eta ? props.eta.etaSeconds : "none"} />
  ),
}));

function pt(lat: number, lng: number): PlainLocationPoint {
  return { latitude: lat, longitude: lng, capturedAt: "x", sourcePlatform: "web" } as PlainLocationPoint;
}
const ETA: RouteEta = { etaSeconds: 300, distanceMeters: 2000 };

it("shows the recomputed ETA in the card header and drives the map badge", async () => {
  const fetchEta = vi.fn().mockResolvedValue(ETA);
  render(
    <PickupEnRouteCardLive
      helperName="Alex"
      helperPoint={pt(40.75, -74.05)}
      pickupPoint={pt(40.76, -74.04)}
      seedEtaSeconds={null}
      fetchEta={fetchEta}
      fallbackPreview={<div />}
      onCancel={() => {}}
    />,
  );
  expect(screen.getByText("Alex is on the way")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText("~5 min away")).toBeInTheDocument());
  expect(screen.getByTestId("map").getAttribute("data-eta")).toBe("300");
});

it("shows a soft updating label instead of 'ETA unavailable' when no ETA yet", () => {
  const fetchEta = vi.fn().mockReturnValue(new Promise<RouteEta>(() => {})); // never resolves
  render(
    <PickupEnRouteCardLive
      helperName="Alex"
      helperPoint={pt(40.75, -74.05)}
      pickupPoint={pt(40.76, -74.04)}
      seedEtaSeconds={null}
      fetchEta={fetchEta}
      fallbackPreview={<div />}
      onCancel={() => {}}
    />,
  );
  expect(screen.getByText("ETA updating…")).toBeInTheDocument();
  expect(screen.queryByText("ETA unavailable")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/pickup-enroute-card-live.test.tsx`
Expected: FAIL — cannot resolve `../pickup-enroute-card-live`.

- [ ] **Step 3: Write the container**

Create `hushh-webapp/components/one-location/redesign/pickup-enroute-card-live.tsx`:

```tsx
"use client";

import type { ReactNode } from "react";

import { driveEtaText } from "@/app/one/location/drive-eta";
import type { LatLngLiteral } from "@/lib/one-location/marker-interpolation";
import type { PlainLocationPoint, RouteEta } from "@/lib/one-location/types";

import { PickupEnRouteCard } from "./cards";
import { PickupLiveRouteMap } from "./pickup-live-route-map";
import { usePickupEta } from "./use-pickup-eta";

export interface PickupEnRouteCardLiveProps {
  helperName: string;
  helperPoint: PlainLocationPoint;
  pickupPoint: PlainLocationPoint | null;
  seedEtaSeconds: number | null;
  fetchEta: (origin: LatLngLiteral, dest: LatLngLiteral) => Promise<RouteEta>;
  fallbackPreview: ReactNode;
  onCancel: () => void;
  cancelBusy?: boolean;
}

/**
 * En-route card whose ETA is recomputed on the viewer's side (usePickupEta),
 * keeping the header text and the map badge in sync from a single source. This
 * is what makes the ETA survive a helper-side refresh.
 */
export function PickupEnRouteCardLive({
  helperName,
  helperPoint,
  pickupPoint,
  seedEtaSeconds,
  fetchEta,
  fallbackPreview,
  onCancel,
  cancelBusy,
}: PickupEnRouteCardLiveProps) {
  const { eta, status } = usePickupEta({
    helperPoint,
    pickupPoint,
    seedEtaSeconds,
    fetchEta,
  });

  // Never render "ETA unavailable": show a soft updating label until we have one.
  const etaText = eta ? driveEtaText(eta.etaSeconds) : "ETA updating…";
  // Don't badge the seeded value (its distance is a placeholder 0 km).
  const badgeEta = status === "seeded" ? null : eta;

  return (
    <PickupEnRouteCard helperName={helperName} etaText={etaText} onCancel={onCancel} cancelBusy={cancelBusy}>
      <PickupLiveRouteMap
        helperPoint={helperPoint}
        pickupPoint={pickupPoint}
        eta={badgeEta}
        fallbackPreview={fallbackPreview}
      />
    </PickupEnRouteCard>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/pickup-enroute-card-live.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the container into the hub**

In `hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx`:

(a) Add imports near the other `./` imports (the `deriveEnRouteHelpers` import is at line ~100; `OneLocationService` and `LatLngLiteral` may already be imported — add only what's missing):

```ts
import { PickupEnRouteCardLive } from "./pickup-enroute-card-live";
import { OneLocationService } from "@/lib/one-location/service";
import type { LatLngLiteral } from "@/lib/one-location/marker-interpolation";
```

(b) Just before the `return (` of the hub body (after the `enRouteHelpers` derivation at ~line 584), add a stable `fetchEta` that injects the vault token:

```ts
  const vaultOwnerToken = vm.vaultOwnerToken;
  const fetchPickupEta = useCallback(
    (origin: LatLngLiteral, dest: LatLngLiteral): Promise<RouteEta> => {
      if (!vaultOwnerToken) {
        return Promise.reject(new Error("Vault locked"));
      }
      return OneLocationService.routeEta({
        vaultOwnerToken,
        originLat: origin.lat,
        originLng: origin.lng,
        destLat: dest.lat,
        destLng: dest.lng,
      });
    },
    [vaultOwnerToken],
  );
```

Ensure `useCallback` is in the React import and `RouteEta` is imported from `@/lib/one-location/types` (add to existing type import if missing).

(c) Replace the existing en-route map block (~lines 621–630):

```tsx
      {enRouteHelpers.map(({ key, helperName, point, etaSeconds, outboundGrantId }) => (
        <PickupEnRouteCard
          key={key}
          helperName={helperName}
          etaText={driveEtaText(etaSeconds)}
          onCancel={() => vm.onStopGrant(outboundGrantId)}
        >
          {vm.renderMapPreview(point, false)}
        </PickupEnRouteCard>
      ))}
```

with:

```tsx
      {enRouteHelpers.map(
        ({ key, helperName, point, pickupPoint, etaSeconds, outboundGrantId }) => (
          <PickupEnRouteCardLive
            key={key}
            helperName={helperName}
            helperPoint={point}
            pickupPoint={pickupPoint}
            seedEtaSeconds={etaSeconds}
            fetchEta={fetchPickupEta}
            fallbackPreview={vm.renderMapPreview(point, false)}
            onCancel={() => vm.onStopGrant(outboundGrantId)}
          />
        ),
      )}
```

(d) If `PickupEnRouteCard` and `driveEtaText` are now unused in this file, remove their imports to satisfy `--max-warnings=0` (check with the lint step below; keep them if still referenced elsewhere in the file).

- [ ] **Step 6: Typecheck, lint, and run the touched tests**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no errors.

Run: `cd hushh-webapp && npx eslint components/one-location/redesign/location-redesign-hub.tsx components/one-location/redesign/pickup-enroute-card-live.tsx components/one-location/redesign/pickup-live-route-map.tsx components/one-location/redesign/use-pickup-eta.ts --max-warnings=0`
Expected: clean (0 warnings, 0 errors).

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__`
Expected: PASS (all redesign tests, including the new ones).

- [ ] **Step 7: Commit**

```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research
git add hushh-webapp/components/one-location/redesign/pickup-enroute-card-live.tsx \
        hushh-webapp/components/one-location/redesign/__tests__/pickup-enroute-card-live.test.tsx \
        hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx
git commit -m "feat(one-location): viewer-side recomputing ETA in pickup en-route card

Requester now recomputes the pickup ETA from the helper's streamed position, so
it no longer shows 'ETA unavailable' after a helper-side refresh.

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 6: Full verification

Confirm the whole change is green and exercise it in the real app.

**Files:** none (verification only).

- [ ] **Step 1: Full one-location test sweep**

Run: `cd hushh-webapp && npx vitest run lib/one-location components/one-location`
Expected: PASS (no regressions in the one-location suites).

- [ ] **Step 2: Typecheck + lint the full webapp**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no errors.

Run: `cd hushh-webapp && npm run lint`
Expected: clean under `--max-warnings=0`.

- [ ] **Step 3: Build + launch on the simulator against UAT**

Run: `.claude/skills/run-ios-sim/launch.sh`
Expected: `BUILD SUCCEEDED`, app launches, log shows `consent-protocol` (UAT).

- [ ] **Step 4: Manual two-user check (human-gated)**

This needs two logged-in UAT accounts (login + vault unlock is human-gated; see the run-ios-sim skill). Use both simulators (iPhone 16 + Helper iPhone):
1. Account A requests a pick-me-up from Account B.
2. Account B taps "I'm on my way".
3. On Account A's en-route card, confirm the map shows BOTH markers + a route line and an ETA (e.g. "~N min away"), not "ETA unavailable".
4. Move Account B's simulated location (`xcrun simctl location <UDID> set <lat>,<lng>`) and confirm the ETA recomputes as B approaches.
5. **Reproduce the original bug:** refresh/relaunch Account B's app mid-drive; confirm Account A's ETA keeps updating (no "ETA unavailable").

Record the result in `.claude/skills/mobile-bug-log` per that skill's guidance.

- [ ] **Step 5: Final confirmation**

No code changes in this task. If anything failed, return to the owning task; do not mark the plan complete with a red step.

---

## Self-Review

**Spec coverage:**
- Viewer-side dual-location map → Task 4 (`PickupLiveRouteMap`) + Task 5 wiring. ✓
- Self-recomputing ETA via server `routeEta` → Task 3 (`usePickupEta`) + Task 5 (`fetchPickupEta` injects the token). ✓
- Throttle reuse (60s / 250m) → Task 1 (shared module), consumed in Task 3. ✓
- Requester's own pickup point surfaced → Task 2. ✓
- Replace en-route card preview in place → Task 5 (hub edit). ✓
- Keep last-known ETA on failure; never "unavailable" → Task 3 hook + Task 5 "ETA updating…" label. ✓
- Degrade to single-point when pickup unknown → Task 4 `fallbackPreview`. ✓
- iOS-safe ETA path (server proxy) → Global Constraints + Task 5. ✓
- Tests per spec (seed, recompute-on-move, throttle, retain-on-failure, both-points render, degrade) → Tasks 1–5. ✓
- Out-of-scope surfaces untouched → no tasks modify the token viewer, helper badge, or drive-session store. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test shows real assertions. ✓

**Type consistency:** `PickupEtaState`/`PickupEtaStatus` defined in Task 3 and consumed in Task 5; `PickupLiveRouteMapProps` (Task 4) matches the props passed by `PickupEnRouteCardLive` (Task 5); `fetchEta` signature `(origin: LatLngLiteral, dest: LatLngLiteral) => Promise<RouteEta>` is identical across Tasks 3, 4-container, and 5; `EnRouteHelper.pickupPoint` (Task 2) is consumed in Task 5's `.map(...)`. ✓

**Note on refinement vs. spec:** The spec described one `PickupLiveRouteMap` component owning the hook. During file-structure design this split into three focused units — the pure hook (`usePickupEta`), the presentational map (`PickupLiveRouteMap`), and a thin container (`PickupEnRouteCardLive`) — so the recomputed ETA drives both the card header text and the map badge from a single hook call (hooks can't be called inside the hub's `.map()`). Same behavior, cleaner boundaries.
