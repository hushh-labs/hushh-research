# Drive-to Route Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the One Location "Drive to" flow to match the Apple Blue v2 reference and add an interactive Google Map showing the source → destination route with a live traffic-aware ETA badge.

**Architecture:** Backend `route_eta` gains traffic-aware routing and returns a `trafficLevel`. A new `DriveRouteMap` component reuses the existing `useGoogleMaps()` hook to render an interactive map with two markers + a Directions route (straight-polyline fallback), plus a keyless directions-iframe fallback for the iOS WebView. `DriveToFlow` is restyled into the reference single-card layout, drops its duration chips (defaulting to 2 h), and fetches the ETA to feed the badge.

**Tech Stack:** Next.js (App Router) + React 18 + TypeScript, Tailwind, `@googlemaps/js-api-loader`, Vitest + Testing Library (frontend); FastAPI + Google Routes API, pytest (backend).

## Global Constraints

- Two distinct Maps keys: browser `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (JS SDK), backend `GOOGLE_MAPS_API_KEY` (Routes/Places). Do not cross them.
- `DriveSharePayload` (encrypted envelope) is unchanged — `trafficLevel` is preview-only, never persisted.
- Duration chips are removed from **Drive-to only**; other flows are untouched. Drive-to share duration defaults to `"2"` hours.
- Traffic thresholds: `ratio = etaSeconds / staticDuration`; `<1.15` → `light`, `<1.40` → `moderate`, else `heavy`; `null` when `staticDuration` is missing/zero.
- Frontend test runner: `npx vitest run <file>` (run from `hushh-webapp/`). Backend: `python -m pytest <file>` (run from `consent-protocol/`).
- Commits: sign off with `-s`. Do NOT add a Claude co-author trailer.

---

### Task 1: Backend traffic-aware ETA

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/google_maps_service.py` (`route_eta`, lines 120-157; add `_classify_traffic` helper near `_parse_duration_seconds` line 47-54)
- Test: `consent-protocol/tests/services/test_google_maps_service.py` (update `test_route_eta_parses_duration_seconds` line 66-81; add new traffic tests)
- Test: `consent-protocol/tests/test_one_location_maps_routes.py` (update `test_route_eta_route` line 39)

**Interfaces:**
- Produces: `GoogleMapsService.route_eta(...) -> {"etaSeconds": int, "distanceMeters": int, "trafficLevel": "light"|"moderate"|"heavy"|None}`. The `/api/one/location/maps/route-eta` handler already returns `{"eta": <that dict>}` verbatim — no handler change.

- [ ] **Step 1: Update the existing service test + add traffic classification tests**

In `consent-protocol/tests/services/test_google_maps_service.py`, replace `test_route_eta_parses_duration_seconds` (lines 66-81) with the version below and append the new tests after it:

```python
@pytest.mark.asyncio
async def test_route_eta_parses_duration_and_traffic(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        field_mask = request.headers["X-Goog-FieldMask"]
        assert "routes.duration" in field_mask
        assert "routes.staticDuration" in field_mask
        import json as _json
        body = _json.loads(request.content)
        assert body["routingPreference"] == "TRAFFIC_AWARE"
        return httpx.Response(
            200,
            json={
                "routes": [
                    {
                        "duration": "2398s",
                        "staticDuration": "2000s",
                        "distanceMeters": 56902,
                    }
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.route_eta(
        origin_lat=37.77, origin_lng=-122.41, dest_lat=37.42, dest_lng=-122.08
    )
    # 2398 / 2000 = 1.199 -> moderate
    assert out == {
        "etaSeconds": 2398,
        "distanceMeters": 56902,
        "trafficLevel": "moderate",
    }


def test_classify_traffic_boundaries():
    assert gms._classify_traffic(100, 100) == "light"      # ratio 1.0
    assert gms._classify_traffic(114, 100) == "light"      # ratio 1.14
    assert gms._classify_traffic(115, 100) == "moderate"   # ratio 1.15
    assert gms._classify_traffic(139, 100) == "moderate"   # ratio 1.39
    assert gms._classify_traffic(140, 100) == "heavy"      # ratio 1.40
    assert gms._classify_traffic(300, 0) is None           # no baseline
    assert gms._classify_traffic(0, 100) is None           # no eta
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/services/test_google_maps_service.py::test_route_eta_parses_duration_and_traffic tests/services/test_google_maps_service.py::test_classify_traffic_boundaries -v`
Expected: FAIL — `_classify_traffic` does not exist / `trafficLevel` / `routingPreference` / `staticDuration` missing.

- [ ] **Step 3: Add the `_classify_traffic` helper**

In `consent-protocol/hushh_mcp/services/google_maps_service.py`, add this function immediately after `_parse_duration_seconds` (after line 54):

```python
def _classify_traffic(eta_seconds: int, static_seconds: int) -> str | None:
    """Classify congestion from the traffic-aware vs free-flow duration ratio."""
    if static_seconds <= 0 or eta_seconds <= 0:
        return None
    ratio = eta_seconds / static_seconds
    if ratio < 1.15:
        return "light"
    if ratio < 1.40:
        return "moderate"
    return "heavy"
```

- [ ] **Step 4: Make `route_eta` traffic-aware**

In the same file, edit `route_eta`. Add `routingPreference` to `body` (after line 132 `"travelMode": "DRIVE",`):

```python
            "travelMode": "DRIVE",
            "routingPreference": "TRAFFIC_AWARE",
```

Change the field mask (line 141) to:

```python
                        "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters",
```

Replace the return block (lines 153-157) with:

```python
        route = routes[0]
        eta_seconds = _parse_duration_seconds(route.get("duration"))
        static_seconds = _parse_duration_seconds(route.get("staticDuration"))
        return {
            "etaSeconds": eta_seconds,
            "distanceMeters": int(route.get("distanceMeters", 0) or 0),
            "trafficLevel": _classify_traffic(eta_seconds, static_seconds),
        }
```

- [ ] **Step 5: Update the route passthrough test**

In `consent-protocol/tests/test_one_location_maps_routes.py`, update `test_route_eta_route` (around line 39) so the fake returns and asserts `trafficLevel`. Replace its `fake` body and assertion so the returned dict is:

```python
        return {"etaSeconds": 600, "distanceMeters": 4200, "trafficLevel": "light"}
```

and assert the response JSON `data["eta"]["trafficLevel"] == "light"` alongside the existing eta assertions.

- [ ] **Step 6: Run all affected backend tests to verify they pass**

Run: `python -m pytest tests/services/test_google_maps_service.py tests/test_one_location_maps_routes.py -v`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add consent-protocol/hushh_mcp/services/google_maps_service.py consent-protocol/tests/services/test_google_maps_service.py consent-protocol/tests/test_one_location_maps_routes.py
git commit -s -m "feat(one-location): traffic-aware route ETA with trafficLevel"
```

---

### Task 2: Shared types + directions-embed URL + service passthrough

**Files:**
- Modify: `hushh-webapp/lib/one-location/types.ts` (add `TrafficLevel`, `RouteEta` after `DriveDestination`, line 338-343)
- Modify: `hushh-webapp/lib/one-location/maps-urls.ts` (add `googleMapsDirectionsEmbedUrl`)
- Modify: `hushh-webapp/lib/one-location/service.ts` (`routeEta` return type, lines 443-467)
- Test: `hushh-webapp/lib/one-location/__tests__/maps-urls.test.ts` (add a directions-embed case)

**Interfaces:**
- Produces: `type TrafficLevel = "light" | "moderate" | "heavy"`; `type RouteEta = { etaSeconds: number; distanceMeters: number; trafficLevel?: TrafficLevel | null }`.
- Produces: `googleMapsDirectionsEmbedUrl(origin: LatLngLiteral, destination: LatLngLiteral): string` → `https://www.google.com/maps?saddr=<lat,lng>&daddr=<lat,lng>&output=embed`.
- Produces: `OneLocationService.routeEta(...) : Promise<RouteEta>`.

- [ ] **Step 1: Write the failing directions-embed test**

Append to `hushh-webapp/lib/one-location/__tests__/maps-urls.test.ts`:

```typescript
import { googleMapsDirectionsEmbedUrl } from "@/lib/one-location/maps-urls";

describe("googleMapsDirectionsEmbedUrl", () => {
  it("builds a keyless directions embed with saddr and daddr", () => {
    const url = googleMapsDirectionsEmbedUrl(
      { lat: 12.9716, lng: 77.5946 },
      { lat: 28.5562, lng: 77.1 },
    );
    expect(url).toContain("output=embed");
    expect(url).toContain(`saddr=${encodeURIComponent("12.971600,77.594600")}`);
    expect(url).toContain(`daddr=${encodeURIComponent("28.556200,77.100000")}`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/one-location/__tests__/maps-urls.test.ts`
Expected: FAIL — `googleMapsDirectionsEmbedUrl` is not exported.

- [ ] **Step 3: Add the directions-embed helper**

Append to `hushh-webapp/lib/one-location/maps-urls.ts`:

```typescript
export function googleMapsDirectionsEmbedUrl(
  origin: LatLngLiteral,
  destination: LatLngLiteral,
): string {
  const saddr = encodeURIComponent(
    `${formatCoordinate(origin.lat)},${formatCoordinate(origin.lng)}`,
  );
  const daddr = encodeURIComponent(
    `${formatCoordinate(destination.lat)},${formatCoordinate(destination.lng)}`,
  );
  return `https://www.google.com/maps?saddr=${saddr}&daddr=${daddr}&output=embed`;
}
```

(`LatLngLiteral` and `formatCoordinate` already exist at the top of the file.)

- [ ] **Step 4: Add shared types**

In `hushh-webapp/lib/one-location/types.ts`, add immediately after the `DriveDestination` type (after line 343):

```typescript
export type TrafficLevel = "light" | "moderate" | "heavy";

export type RouteEta = {
  etaSeconds: number;
  distanceMeters: number;
  trafficLevel?: TrafficLevel | null;
};
```

- [ ] **Step 5: Widen the service return type**

In `hushh-webapp/lib/one-location/service.ts`, add `RouteEta` to the type import from `@/lib/one-location/types`, then change `routeEta` (lines 443-467) to type its return as `Promise<RouteEta>` and its `apiJson` generic `eta` field as `RouteEta`:

```typescript
  static async routeEta(params: {
    vaultOwnerToken: string;
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
  }): Promise<RouteEta> {
    const response = await apiJson<{ eta: RouteEta }>(
      "/api/one/location/maps/route-eta",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          originLat: params.originLat,
          originLng: params.originLng,
          destLat: params.destLat,
          destLng: params.destLng,
        }),
      },
    );
    return response.eta;
  }
```

- [ ] **Step 6: Run tests + typecheck to verify pass**

Run: `npx vitest run lib/one-location/__tests__/maps-urls.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add hushh-webapp/lib/one-location/types.ts hushh-webapp/lib/one-location/maps-urls.ts hushh-webapp/lib/one-location/service.ts hushh-webapp/lib/one-location/__tests__/maps-urls.test.ts
git commit -s -m "feat(one-location): RouteEta type + directions-embed URL helper"
```

---

### Task 3: `DriveRouteMap` component

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/drive-route-map.tsx`
- Test: `hushh-webapp/components/one-location/redesign/__tests__/drive-route-map.test.tsx`

**Interfaces:**
- Consumes: `useGoogleMaps()` from `@/lib/one-location/use-google-maps`; `googleMapsDirectionsEmbedUrl` (Task 2); `RouteEta`, `DriveDestination` (Task 2/types); `LatLngLiteral` from `@/lib/one-location/marker-interpolation`.
- Produces: `DriveRouteMap({ origin, destination, eta, className })` React component; and exported pure helper `driveBadgeText(eta: RouteEta): { primary: string; secondary: string }`.

- [ ] **Step 1: Write the failing tests**

Create `hushh-webapp/components/one-location/redesign/__tests__/drive-route-map.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DriveDestination } from "@/lib/one-location/types";

const mockStatus = { current: "loading" as "loading" | "ready" | "error" };
vi.mock("@/lib/one-location/use-google-maps", () => ({
  useGoogleMaps: () => ({ status: mockStatus.current }),
}));

import {
  DriveRouteMap,
  driveBadgeText,
} from "@/components/one-location/redesign/drive-route-map";

const origin = { lat: 12.9716, lng: 77.5946 };
const destination: DriveDestination = {
  label: "Indira Gandhi Intl Airport · T3",
  latitude: 28.5562,
  longitude: 77.1,
};

afterEach(() => {
  mockStatus.current = "loading";
  // @ts-expect-error test cleanup
  delete globalThis.google;
  vi.clearAllMocks();
});

describe("driveBadgeText", () => {
  it("formats minutes, km and traffic clause", () => {
    expect(
      driveBadgeText({ etaSeconds: 1080, distanceMeters: 7200, trafficLevel: "light" }),
    ).toEqual({ primary: "18 min", secondary: "7.2 km · light traffic" });
  });

  it("omits the traffic clause when trafficLevel is null", () => {
    expect(
      driveBadgeText({ etaSeconds: 1080, distanceMeters: 7200, trafficLevel: null }),
    ).toEqual({ primary: "18 min", secondary: "7.2 km" });
  });
});

describe("DriveRouteMap", () => {
  it("falls back to a keyless directions iframe when Maps is not ready", () => {
    mockStatus.current = "error";
    render(<DriveRouteMap origin={origin} destination={destination} eta={null} />);
    const iframe = screen.getByTitle("Drive route map preview") as HTMLIFrameElement;
    expect(iframe.src).toContain("output=embed");
    expect(iframe.src).toContain("saddr=");
    expect(iframe.src).toContain("daddr=");
  });

  it("renders the ETA badge over the fallback", () => {
    mockStatus.current = "error";
    render(
      <DriveRouteMap
        origin={origin}
        destination={destination}
        eta={{ etaSeconds: 1080, distanceMeters: 7200, trafficLevel: "light" }}
      />,
    );
    expect(screen.getByText("18 min")).toBeInTheDocument();
    expect(screen.getByText("7.2 km · light traffic")).toBeInTheDocument();
  });

  it("builds an interactive map with two markers + a directions request when ready", () => {
    const routeMock = vi.fn();
    // vitest 4.x: mocks used with `new` must be non-arrow functions.
    const Map = vi.fn(function () {
      return { fitBounds: vi.fn() };
    });
    const Marker = vi.fn(function () {
      return { setMap: vi.fn() };
    });
    const DirectionsRenderer = vi.fn(function () {
      return { setMap: vi.fn(), setDirections: vi.fn() };
    });
    const DirectionsService = vi.fn(function () {
      return { route: routeMock };
    });
    const Polyline = vi.fn(function () {
      return { setMap: vi.fn() };
    });
    const LatLngBounds = vi.fn(function () {
      return { extend: vi.fn() };
    });
    // @ts-expect-error test global
    globalThis.google = {
      maps: {
        Map,
        Marker,
        DirectionsRenderer,
        DirectionsService,
        Polyline,
        LatLngBounds,
        SymbolPath: { CIRCLE: 0 },
        TravelMode: { DRIVING: "DRIVING" },
        DirectionsStatus: { OK: "OK" },
      },
    };
    mockStatus.current = "ready";

    render(<DriveRouteMap origin={origin} destination={destination} eta={null} />);

    expect(Map).toHaveBeenCalledTimes(1);
    expect(Marker).toHaveBeenCalledTimes(2);
    expect(routeMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle("Drive route map preview")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run components/one-location/redesign/__tests__/drive-route-map.test.tsx`
Expected: FAIL — module `drive-route-map` not found.

- [ ] **Step 3: Implement the component**

Create `hushh-webapp/components/one-location/redesign/drive-route-map.tsx`:

```tsx
"use client";

/**
 * One Location redesign — interactive source → destination route map for the
 * Drive To flow. Reuses the shared useGoogleMaps() loader. When the JS SDK is
 * unavailable (iOS App:// WebView, missing key, auth failure) it degrades to a
 * keyless Google Maps directions iframe. Draws the real driving route via the
 * Directions API and falls back to a straight polyline if that request fails.
 */

import { useEffect, useRef } from "react";

import { useGoogleMaps } from "@/lib/one-location/use-google-maps";
import { googleMapsDirectionsEmbedUrl } from "@/lib/one-location/maps-urls";
import type { LatLngLiteral } from "@/lib/one-location/marker-interpolation";
import type { DriveDestination, RouteEta } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

export function driveBadgeText(eta: RouteEta): {
  primary: string;
  secondary: string;
} {
  const mins = Math.max(1, Math.round(eta.etaSeconds / 60));
  const km = (eta.distanceMeters / 1000).toFixed(1);
  const traffic = eta.trafficLevel ? ` · ${eta.trafficLevel} traffic` : "";
  return { primary: `${mins} min`, secondary: `${km} km${traffic}` };
}

function RouteBadge({
  primary,
  secondary,
}: {
  primary: string;
  secondary: string;
}) {
  return (
    <div className="pointer-events-none absolute right-3 top-3 rounded-[11px] bg-white/90 px-3 py-2 shadow-[rgba(0,0,0,0.22)_3px_5px_30px_0px] backdrop-blur">
      <div className="text-[19px] font-semibold leading-tight text-[#1d1d1f]">
        {primary}
      </div>
      <div className="text-xs text-black/50">{secondary}</div>
    </div>
  );
}

export interface DriveRouteMapProps {
  origin: LatLngLiteral;
  destination: DriveDestination;
  eta?: RouteEta | null;
  className?: string;
}

export function DriveRouteMap({
  origin,
  destination,
  eta,
  className,
}: DriveRouteMapProps) {
  const { status } = useGoogleMaps();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const routeRef = useRef<{ setMap: (map: google.maps.Map | null) => void } | null>(
    null,
  );

  const dest: LatLngLiteral = {
    lat: destination.latitude,
    lng: destination.longitude,
  };

  useEffect(() => {
    if (status !== "ready" || !containerRef.current) return;

    const map =
      mapRef.current ??
      new google.maps.Map(containerRef.current, {
        disableDefaultUI: true,
        clickableIcons: false,
        gestureHandling: "greedy",
      });
    mapRef.current = map;

    // Clear any overlays from a previous origin/destination.
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];
    if (routeRef.current) {
      routeRef.current.setMap(null);
      routeRef.current = null;
    }

    const dot = (fill: string) => ({
      path: google.maps.SymbolPath.CIRCLE,
      scale: 7,
      fillColor: fill,
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 2.5,
    });
    markersRef.current.push(
      new google.maps.Marker({ map, position: origin, icon: dot("#007AFF") }),
    );
    markersRef.current.push(
      new google.maps.Marker({ map, position: dest, icon: dot("#1d1d1f") }),
    );

    const bounds = new google.maps.LatLngBounds();
    bounds.extend(origin);
    bounds.extend(dest);
    map.fitBounds(bounds, 48);

    const renderer = new google.maps.DirectionsRenderer({
      map,
      suppressMarkers: true,
      preserveViewport: true,
      polylineOptions: {
        strokeColor: "#007AFF",
        strokeWeight: 4.5,
        strokeOpacity: 1,
      },
    });
    routeRef.current = renderer;
    const service = new google.maps.DirectionsService();
    service.route(
      {
        origin,
        destination: dest,
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (result, dirStatus) => {
        if (dirStatus === google.maps.DirectionsStatus.OK && result) {
          renderer.setDirections(result);
        } else {
          renderer.setMap(null);
          routeRef.current = new google.maps.Polyline({
            map,
            path: [origin, dest],
            strokeColor: "#007AFF",
            strokeWeight: 4.5,
            strokeOpacity: 1,
          });
        }
      },
    );

    return () => {
      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = [];
      if (routeRef.current) {
        routeRef.current.setMap(null);
        routeRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, origin.lat, origin.lng, dest.lat, dest.lng]);

  const badge = eta ? driveBadgeText(eta) : null;

  if (status !== "ready") {
    return (
      <div className={cn("relative", className)}>
        <iframe
          title="Drive route map preview"
          src={googleMapsDirectionsEmbedUrl(origin, dest)}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          className="h-full w-full border-0"
        />
        {badge ? <RouteBadge {...badge} /> : null}
      </div>
    );
  }

  return (
    <div className={cn("relative", className)}>
      <div ref={containerRef} className="h-full w-full" />
      {badge ? <RouteBadge {...badge} /> : null}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run components/one-location/redesign/__tests__/drive-route-map.test.tsx`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/drive-route-map.tsx hushh-webapp/components/one-location/redesign/__tests__/drive-route-map.test.tsx
git commit -s -m "feat(one-location): DriveRouteMap with route + ETA badge"
```

---

### Task 4: Restyle `DriveToFlow` — remove chips, add route card + ETA

**Files:**
- Modify: `hushh-webapp/components/one-location/redesign/drive-to-flow.tsx`
- Test: `hushh-webapp/components/one-location/redesign/__tests__/drive-to-flow.test.tsx`

**Interfaces:**
- Consumes: `DriveRouteMap`, `RouteEta` (Task 3/2); existing `vm.myLocationPoint`, `vm.vaultOwnerToken`, `vm.onDriveTo`, `OneLocationService.routeEta`.
- Produces: no new exports; `onDriveTo(destination, checkedIds, "2")` (duration fixed at 2 h).

- [ ] **Step 1: Update the test file (new expectations)**

Replace `hushh-webapp/components/one-location/redesign/__tests__/drive-to-flow.test.tsx` with:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// DriveRouteMap uses the Maps loader; force the iframe fallback in tests.
vi.mock("@/lib/one-location/use-google-maps", () => ({
  useGoogleMaps: () => ({ status: "loading" }),
}));

import { DriveToFlow } from "@/components/one-location/redesign/drive-to-flow";
import { OneLocationService } from "@/lib/one-location/service";
import type { LocationHubViewModel } from "@/components/one-location/redesign/location-redesign-hub";
import type { DriveDestination, PlainLocationPoint } from "@/lib/one-location/types";

const point: PlainLocationPoint = {
  latitude: 37.7,
  longitude: -122.4,
  capturedAt: new Date("2026-07-07T00:00:00Z").toISOString(),
  sourcePlatform: "web",
};

function makeVm(overrides: Partial<LocationHubViewModel> = {}): LocationHubViewModel {
  return {
    vaultOwnerToken: "token",
    onDriveTo: vi.fn(),
    driveBusy: false,
    recentDestinations: [],
    sosRecipients: [
      {
        userId: "r1",
        displayName: "Carol",
        keyId: "k1",
        publicKeyJwk: {} as JsonWebKey,
        canReceiveLocation: true,
      },
    ],
    isRecipientShareReady: () => true,
    recipientLabel: (r) => r.displayName ?? r.userId,
    recipientSubtitle: () => "Trusted",
    myLocationPoint: point,
    myLocationError: null,
    onShowMyLocation: vi.fn(),
    renderMapPreview: () => <div data-testid="map" />,
    formatDateTime: () => "now",
    busy: null,
    ...overrides,
  } as unknown as LocationHubViewModel;
}

async function pickDestination() {
  vi.spyOn(OneLocationService, "placesAutocomplete").mockResolvedValue([
    { placeId: "p1", text: "Starbucks, Market St" },
  ]);
  vi.spyOn(OneLocationService, "placeDetails").mockResolvedValue({
    placeId: "p1",
    label: "Starbucks, Market St",
    latitude: 37.79,
    longitude: -122.4,
  } as DriveDestination);
  fireEvent.change(screen.getByPlaceholderText(/where are you headed/i), {
    target: { value: "Starbucks" },
  });
  fireEvent.click(await screen.findByText("Starbucks, Market St"));
}

describe("DriveToFlow", () => {
  it("searches destinations and starts a drive share with a 2h default", async () => {
    vi.spyOn(OneLocationService, "routeEta").mockResolvedValue({
      etaSeconds: 1080,
      distanceMeters: 7200,
      trafficLevel: "light",
    });
    const vm = makeVm();
    render(<DriveToFlow vm={vm} onClose={vi.fn()} />);
    await pickDestination();

    fireEvent.click(await screen.findByRole("button", { name: /Carol/i }));
    const startBtn = await screen.findByRole("button", { name: /start sharing/i });
    await waitFor(() => expect(startBtn).not.toBeDisabled());
    fireEvent.click(startBtn);

    await waitFor(() =>
      expect(vm.onDriveTo).toHaveBeenCalledWith(
        expect.objectContaining({ placeId: "p1", latitude: 37.79 }),
        ["r1"],
        "2",
      ),
    );
  });

  it("disables start until a destination is chosen", () => {
    const vm = makeVm();
    render(<DriveToFlow vm={vm} onClose={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /choose a destination/i }),
    ).toBeDisabled();
  });

  it("does not render duration chips", () => {
    const vm = makeVm();
    render(<DriveToFlow vm={vm} onClose={vi.fn()} />);
    expect(screen.queryByText(/share for/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^1 hour$/i })).toBeNull();
  });

  it("shows the route map + ETA badge once a destination is chosen", async () => {
    vi.spyOn(OneLocationService, "routeEta").mockResolvedValue({
      etaSeconds: 1080,
      distanceMeters: 7200,
      trafficLevel: "light",
    });
    const vm = makeVm();
    render(<DriveToFlow vm={vm} onClose={vi.fn()} />);
    await pickDestination();

    expect(
      await screen.findByTitle("Drive route map preview"),
    ).toBeInTheDocument();
    expect(await screen.findByText("18 min")).toBeInTheDocument();
    expect(
      await screen.findByText("7.2 km · light traffic"),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run components/one-location/redesign/__tests__/drive-to-flow.test.tsx`
Expected: FAIL — chips still present, no route map / badge, `onDriveTo` called with `"2"` not yet guaranteed.

- [ ] **Step 3: Edit imports + constants in `drive-to-flow.tsx`**

Change the icon import (line 13) to drop `Clock` (no longer used):

```tsx
import { Car, Check, MapPin, RefreshCw, Search } from "lucide-react";
```

Add `RouteEta` to the types import (line 18):

```tsx
import type { DriveDestination, RouteEta } from "@/lib/one-location/types";
```

Add the new component import after the tokens import (after line 21):

```tsx
import { DriveRouteMap } from "./drive-route-map";
```

Replace the `DRIVE_DURATIONS` constant block (lines 24-28) with:

```tsx
// Drive-to shares default to a 2-hour window (no per-flow duration picker).
const DRIVE_DURATION_HOURS = "2";
```

- [ ] **Step 4: Replace state + add ETA fetch**

In the component body, replace the `durationValue` state line (line 64) — remove it. Then add ETA state next to the other `useState` calls:

```tsx
  const [eta, setEta] = useState<RouteEta | null>(null);
```

Add this effect after the `selectSuggestion`/`selectRecent` helpers (after line 122), before `toggle`:

```tsx
  // Fetch a live ETA whenever both origin and destination are known.
  useEffect(() => {
    const token = vm.vaultOwnerToken;
    const origin = vm.myLocationPoint;
    if (!token || !origin || !destination) {
      setEta(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const result = await OneLocationService.routeEta({
          vaultOwnerToken: token,
          originLat: origin.latitude,
          originLng: origin.longitude,
          destLat: destination.latitude,
          destLng: destination.longitude,
        });
        if (!cancelled) setEta(result);
      } catch {
        if (!cancelled) setEta(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [vm.vaultOwnerToken, vm.myLocationPoint, destination]);
```

- [ ] **Step 5: Fix the start handler to use the fixed duration**

Change the `onDriveTo` call (line 363) to:

```tsx
            destination && vm.onDriveTo(destination, checkedIds, DRIVE_DURATION_HOURS)
```

- [ ] **Step 6: Replace the confirmed-destination chip with the route card**

Replace the confirmed-destination chip block (lines 228-236, the `{destination ? (...) : null}` with the `Car`/`Check` chip inside the search `<section>`) with nothing — delete it. Then, immediately after the closing `</section>` of "WHERE ARE YOU HEADED?" (after line 237), insert the route card:

```tsx
      {/* ROUTE PREVIEW (once destination + origin are known) */}
      {destination && point ? (
        <section className={cn(CARD_SURFACE, "overflow-hidden p-0")}>
          <DriveRouteMap
            origin={{ lat: point.latitude, lng: point.longitude }}
            destination={destination}
            eta={eta}
            className="h-[160px] w-full"
          />
          <div className="px-4">
            <div className="flex items-center gap-3 border-b border-black/5 py-3">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#007aff]" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Starting from</p>
                <p className="truncate text-[15px] font-semibold text-foreground">
                  Live location
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 py-3">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#1d1d1f]" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Heading to</p>
                <p className="truncate text-[15px] font-semibold text-foreground">
                  {destination.label}
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : null}
```

- [ ] **Step 7: Remove the duration chips section**

Delete the entire DURATION `<section>` block (original lines 331-357, the `{/* DURATION */}` comment through its closing `</section>`).

- [ ] **Step 8: Run the component tests to verify pass**

Run: `npx vitest run components/one-location/redesign/__tests__/drive-to-flow.test.tsx`
Expected: PASS (all 4).

- [ ] **Step 9: Typecheck + lint the touched files**

Run: `npx tsc --noEmit`
Expected: no new errors.
Run: `npx eslint components/one-location/redesign/drive-to-flow.tsx components/one-location/redesign/drive-route-map.tsx`
Expected: clean (no unused `Clock`/`durationValue`).

- [ ] **Step 10: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/drive-to-flow.tsx hushh-webapp/components/one-location/redesign/__tests__/drive-to-flow.test.tsx
git commit -s -m "feat(one-location): Drive-to route map layout + live ETA, drop duration chips"
```

---

### Task 5: End-to-end verification in the app

**Files:** none (verification only).

- [ ] **Step 1: Run the full One Location test suites**

Run (from `hushh-webapp/`): `npx vitest run components/one-location lib/one-location`
Expected: PASS.
Run (from `consent-protocol/`): `python -m pytest tests/services/test_google_maps_service.py tests/test_one_location_maps_routes.py`
Expected: PASS.

- [ ] **Step 2: Drive the flow in the iOS simulator**

Use the `run-ios-sim` skill to build + launch the app on the iPhone 16 simulator against UAT. Navigate: One Location → Drive To. Capture location, search a destination (e.g. "Indira Gandhi Intl Airport"), select a recipient. Confirm: the route card shows a map with source + destination and a route line, the ETA badge shows "<min> min · <km> km · <traffic> traffic", no duration chips appear, and "Start sharing drive" starts the share. Screenshot for the record.

- [ ] **Step 3: Note any follow-ups**

If the interactive JS map does not render inside the iOS WebView (expected — it typically falls back), confirm the keyless directions iframe shows the route instead. Record the result in the mobile bug log if anything is off.
