# Seamless Live-Location Map (Gliding Marker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the reloading Google Maps iframe in the in-app One Location view with an interactive Google Maps JavaScript map whose marker glides to each newly polled coordinate, so watching a live share feels near-live.

**Architecture:** Frontend-only. A new `<LiveMap>` component loads the Maps JS API via `@googlemaps/js-api-loader` (singleton hook), renders a real marker, and animates it between two real fetched points with `requestAnimationFrame`. The recipient poll drops from 20s to 5s. No key exposed beyond a new referrer-restricted browser key; if that key is absent or the script fails, the component transparently falls back to today's iframe. The backend, DB, encryption path, and sender publish cadence are untouched.

**Tech Stack:** Next.js/React (client components), TypeScript, `@googlemaps/js-api-loader`, Google Maps JavaScript API, Vitest + @testing-library/react.

## Global Constraints

- New browser key is named exactly `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and is **separate** from the server-side `GOOGLE_MAPS_API_KEY`. Never read or expose the server-side key in browser code.
- Do **not** modify `consent-protocol` (backend), any DB migration, the encryption/decryption path, the sender publish heartbeat (`LIVE_LOCATION_UPDATE_INTERVAL_MS`), or the movement `watchPosition`. Only the **recipient** poll cadence changes.
- Behavior must degrade gracefully: no key or Maps-JS load failure → existing iframe embed. No regression when the key is unset.
- Scope is in-app surfaces only (`app/one/location/page.tsx` → `LocalMapPreview`). Do **not** touch the public `invite/[token]` or `request/[token]` pages.
- All work happens in `hushh-webapp/`. New tests live under `lib/one-location/__tests__/` or `components/one-location/__tests__/` (per `vitest.config.ts` include globs).
- Quality gates for every task: `npm run typecheck` (`tsc --noEmit`) and `npm run lint` (`eslint . --max-warnings=0`) must pass — lint has **zero** warning tolerance, so no unused symbols.
- Commits use DCO sign-off (`git commit -s`) and must **not** include a `Co-Authored-By: Claude` trailer.

---

### Task 1: Marker interpolation helpers (pure)

Pure, dependency-free math used by `<LiveMap>` to glide the marker. Fully unit-testable.

**Files:**
- Create: `hushh-webapp/lib/one-location/marker-interpolation.ts`
- Test: `hushh-webapp/lib/one-location/__tests__/marker-interpolation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface LatLngLiteral { lat: number; lng: number }`
  - `lerpLatLng(from: LatLngLiteral, to: LatLngLiteral, t: number): LatLngLiteral` (t clamped to [0,1])
  - `easeInOutQuad(t: number): number`
  - `haversineMeters(a: LatLngLiteral, b: LatLngLiteral): number`
  - `SNAP_DISTANCE_METERS: number` (= 2000)
  - `shouldSnap(from: LatLngLiteral, to: LatLngLiteral): boolean`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/lib/one-location/__tests__/marker-interpolation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  easeInOutQuad,
  haversineMeters,
  lerpLatLng,
  shouldSnap,
  SNAP_DISTANCE_METERS,
} from "@/lib/one-location/marker-interpolation";

describe("lerpLatLng", () => {
  it("returns the midpoint at t=0.5", () => {
    const mid = lerpLatLng({ lat: 0, lng: 0 }, { lat: 10, lng: 20 }, 0.5);
    expect(mid.lat).toBeCloseTo(5);
    expect(mid.lng).toBeCloseTo(10);
  });

  it("clamps t below 0 and above 1", () => {
    const from = { lat: 1, lng: 1 };
    const to = { lat: 3, lng: 3 };
    expect(lerpLatLng(from, to, -1)).toEqual(from);
    expect(lerpLatLng(from, to, 5)).toEqual(to);
  });
});

describe("easeInOutQuad", () => {
  it("maps endpoints to themselves and stays within [0,1]", () => {
    expect(easeInOutQuad(0)).toBe(0);
    expect(easeInOutQuad(1)).toBe(1);
    const mid = easeInOutQuad(0.5);
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(mid).toBeLessThanOrEqual(1);
  });
});

describe("haversineMeters", () => {
  it("is ~0 for identical points", () => {
    expect(
      haversineMeters({ lat: 12.9, lng: 77.6 }, { lat: 12.9, lng: 77.6 }),
    ).toBeCloseTo(0);
  });
});

describe("shouldSnap", () => {
  it("snaps when the jump exceeds the threshold", () => {
    expect(shouldSnap({ lat: 0, lng: 0 }, { lat: 40, lng: 20 })).toBe(true);
  });

  it("animates small movements", () => {
    expect(
      shouldSnap({ lat: 1.0, lng: 1.0 }, { lat: 1.00001, lng: 1.00001 }),
    ).toBe(false);
  });

  it("exposes a 2km threshold constant", () => {
    expect(SNAP_DISTANCE_METERS).toBe(2000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/marker-interpolation.test.ts`
Expected: FAIL — cannot resolve `@/lib/one-location/marker-interpolation`.

- [ ] **Step 3: Write minimal implementation**

Create `hushh-webapp/lib/one-location/marker-interpolation.ts`:

```ts
export interface LatLngLiteral {
  lat: number;
  lng: number;
}

function clamp01(t: number): number {
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/** Linear interpolation between two coordinates. `t` is clamped to [0,1]. */
export function lerpLatLng(
  from: LatLngLiteral,
  to: LatLngLiteral,
  t: number,
): LatLngLiteral {
  const k = clamp01(t);
  return {
    lat: from.lat + (to.lat - from.lat) * k,
    lng: from.lng + (to.lng - from.lng) * k,
  };
}

/** Ease-in-out so the marker accelerates then settles. In/out in [0,1]. */
export function easeInOutQuad(t: number): number {
  const k = clamp01(t);
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}

/** Great-circle distance in metres between two coordinates. */
export function haversineMeters(a: LatLngLiteral, b: LatLngLiteral): number {
  const R = 6_371_000; // Earth radius (m)
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Jumps larger than this (metres) are treated as a teleport / first GPS fix and
 * snapped instantly rather than animated across the map.
 */
export const SNAP_DISTANCE_METERS = 2000;

export function shouldSnap(from: LatLngLiteral, to: LatLngLiteral): boolean {
  return haversineMeters(from, to) > SNAP_DISTANCE_METERS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/marker-interpolation.test.ts`
Expected: PASS (4 suites, all green).

- [ ] **Step 5: Typecheck + lint**

Run: `cd hushh-webapp && npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd hushh-webapp
git add lib/one-location/marker-interpolation.ts lib/one-location/__tests__/marker-interpolation.test.ts
git commit -s -m "feat(one-location): marker interpolation helpers for live map"
```

---

### Task 2: Browser Maps key config + Maps JS loader hook

Adds the dependency, a small env accessor (separate browser key), and a singleton React hook that loads the Maps JS API once.

**Files:**
- Modify: `hushh-webapp/package.json` (add deps)
- Create: `hushh-webapp/lib/one-location/maps-config.ts`
- Create: `hushh-webapp/lib/one-location/use-google-maps.ts`
- Modify: `hushh-webapp/.env.example`
- Test: `hushh-webapp/lib/one-location/__tests__/maps-config.test.ts`
- Test: `hushh-webapp/lib/one-location/__tests__/use-google-maps.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `getBrowserMapsApiKey(): string`
  - `isBrowserMapsConfigured(): boolean`
  - `type MapsLoadStatus = "loading" | "ready" | "error"`
  - `useGoogleMaps(): { status: MapsLoadStatus }`
  - `__resetGoogleMapsLoaderForTests(): void` (test-only singleton reset)

- [ ] **Step 1: Install the dependency**

Run:
```bash
cd hushh-webapp
npm install @googlemaps/js-api-loader
npm install -D @types/google.maps
```
Expected: `@googlemaps/js-api-loader` in `dependencies`, `@types/google.maps` in `devDependencies` of `package.json`.

- [ ] **Step 2: Write the failing config test**

Create `hushh-webapp/lib/one-location/__tests__/maps-config.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserMapsApiKey,
  isBrowserMapsConfigured,
} from "@/lib/one-location/maps-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("maps-config", () => {
  it("reports not configured when the env var is empty", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "");
    expect(isBrowserMapsConfigured()).toBe(false);
    expect(getBrowserMapsApiKey()).toBe("");
  });

  it("trims and returns the key when present", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "  browser-key  ");
    expect(getBrowserMapsApiKey()).toBe("browser-key");
    expect(isBrowserMapsConfigured()).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/maps-config.test.ts`
Expected: FAIL — cannot resolve `@/lib/one-location/maps-config`.

- [ ] **Step 4: Implement maps-config**

Create `hushh-webapp/lib/one-location/maps-config.ts`:

```ts
/**
 * Browser-side Google Maps key. This is a SEPARATE, referrer-restricted key
 * (Maps JavaScript API only) — never the server-side GOOGLE_MAPS_API_KEY used
 * by the backend Places/Routes proxy. When absent, callers fall back to the
 * iframe embed.
 */
export function getBrowserMapsApiKey(): string {
  return (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "").trim();
}

export function isBrowserMapsConfigured(): boolean {
  return getBrowserMapsApiKey().length > 0;
}
```

- [ ] **Step 5: Run config test to verify it passes**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/maps-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing loader-hook test**

Create `hushh-webapp/lib/one-location/__tests__/use-google-maps.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const importLibrary = vi.fn().mockResolvedValue({});
vi.mock("@googlemaps/js-api-loader", () => ({
  Loader: class {
    importLibrary = importLibrary;
  },
}));

import {
  __resetGoogleMapsLoaderForTests,
  useGoogleMaps,
} from "@/lib/one-location/use-google-maps";

afterEach(() => {
  vi.unstubAllEnvs();
  __resetGoogleMapsLoaderForTests();
  importLibrary.mockClear();
});

describe("useGoogleMaps", () => {
  it("reports error when no browser key is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "");
    const { result } = renderHook(() => useGoogleMaps());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(importLibrary).not.toHaveBeenCalled();
  });

  it("reports ready when the loader resolves", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "browser-key");
    const { result } = renderHook(() => useGoogleMaps());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(importLibrary).toHaveBeenCalledWith("maps");
    expect(importLibrary).toHaveBeenCalledWith("marker");
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/use-google-maps.test.ts`
Expected: FAIL — cannot resolve `@/lib/one-location/use-google-maps`.

- [ ] **Step 8: Implement the loader hook**

Create `hushh-webapp/lib/one-location/use-google-maps.ts`:

```ts
"use client";

import { useEffect, useState } from "react";
import { Loader } from "@googlemaps/js-api-loader";

import { getBrowserMapsApiKey } from "@/lib/one-location/maps-config";

export type MapsLoadStatus = "loading" | "ready" | "error";

// Module-level singleton so the Maps script is requested at most once per page,
// no matter how many <LiveMap> instances mount.
let loadPromise: Promise<void> | null = null;

function loadGoogleMaps(): Promise<void> {
  if (loadPromise) return loadPromise;
  const apiKey = getBrowserMapsApiKey();
  if (!apiKey) {
    loadPromise = Promise.reject(new Error("maps-not-configured"));
    return loadPromise;
  }
  const loader = new Loader({ apiKey, version: "weekly" });
  loadPromise = Promise.all([
    loader.importLibrary("maps"),
    loader.importLibrary("marker"),
  ]).then(() => undefined);
  return loadPromise;
}

export function useGoogleMaps(): { status: MapsLoadStatus } {
  const [status, setStatus] = useState<MapsLoadStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (!cancelled) setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { status };
}

/** Test-only: clears the module singleton so each case starts fresh. */
export function __resetGoogleMapsLoaderForTests(): void {
  loadPromise = null;
}
```

- [ ] **Step 9: Run loader-hook test to verify it passes**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/use-google-maps.test.ts`
Expected: PASS (both cases).

- [ ] **Step 10: Document the env var**

Append to `hushh-webapp/.env.example`:

```bash
# Browser-side Google Maps key for the One Location live map (Maps JavaScript API only).
# SEPARATE from the backend GOOGLE_MAPS_API_KEY. Must be HTTP-referrer restricted to
# Hushh domains. If unset, the live map falls back to the static iframe embed.
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
```

- [ ] **Step 11: Typecheck + lint**

Run: `cd hushh-webapp && npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
cd hushh-webapp
git add package.json package-lock.json .env.example lib/one-location/maps-config.ts lib/one-location/use-google-maps.ts lib/one-location/__tests__/maps-config.test.ts lib/one-location/__tests__/use-google-maps.test.ts
git commit -s -m "feat(one-location): Maps JS loader hook + browser key config"
```

---

### Task 3: Shared Google Maps URL helpers

Small pure module for the coordinate query, embed URL (iframe fallback), and directions URL. Lets `<LiveMap>` build its own fallback without importing from the huge `page.tsx`.

**Files:**
- Create: `hushh-webapp/lib/one-location/maps-urls.ts`
- Test: `hushh-webapp/lib/one-location/__tests__/maps-urls.test.ts`

**Interfaces:**
- Consumes: `LatLngLiteral` from `@/lib/one-location/marker-interpolation` (Task 1); `PlainLocationPoint` from `@/lib/one-location/types` (existing: fields `latitude`, `longitude`, `accuracyM?`, `capturedAt`, `sourcePlatform`, `drive?`).
- Produces:
  - `locationLatLng(point: PlainLocationPoint): LatLngLiteral`
  - `locationCoordinateQuery(point: PlainLocationPoint): string`
  - `googleMapsLocationEmbedUrl(point: PlainLocationPoint): string`
  - `googleMapsDirectionsUrl(point: PlainLocationPoint): string`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/lib/one-location/__tests__/maps-urls.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import {
  googleMapsDirectionsUrl,
  googleMapsLocationEmbedUrl,
  locationCoordinateQuery,
  locationLatLng,
} from "@/lib/one-location/maps-urls";

const point: PlainLocationPoint = {
  latitude: 12.9716,
  longitude: 77.5946,
  capturedAt: "2026-07-08T00:00:00.000Z",
  sourcePlatform: "web",
};

describe("maps-urls", () => {
  it("returns a lat/lng literal", () => {
    expect(locationLatLng(point)).toEqual({ lat: 12.9716, lng: 77.5946 });
  });

  it("formats the coordinate query to 6 decimals", () => {
    expect(locationCoordinateQuery(point)).toBe("12.971600,77.594600");
  });

  it("builds an embeddable maps url", () => {
    const url = googleMapsLocationEmbedUrl(point);
    expect(url).toContain("output=embed");
    expect(url).toContain(encodeURIComponent("12.971600,77.594600"));
  });

  it("builds a driving directions url", () => {
    const url = googleMapsDirectionsUrl(point);
    expect(url).toContain("dir/?api=1");
    expect(url).toContain("travelmode=driving");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/maps-urls.test.ts`
Expected: FAIL — cannot resolve `@/lib/one-location/maps-urls`.

- [ ] **Step 3: Implement the helpers**

Create `hushh-webapp/lib/one-location/maps-urls.ts`:

```ts
import type { LatLngLiteral } from "@/lib/one-location/marker-interpolation";
import type { PlainLocationPoint } from "@/lib/one-location/types";

function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : "0.000000";
}

export function locationLatLng(point: PlainLocationPoint): LatLngLiteral {
  return { lat: point.latitude, lng: point.longitude };
}

export function locationCoordinateQuery(point: PlainLocationPoint): string {
  return [
    formatCoordinate(point.latitude),
    formatCoordinate(point.longitude),
  ].join(",");
}

export function googleMapsLocationEmbedUrl(point: PlainLocationPoint): string {
  const query = encodeURIComponent(locationCoordinateQuery(point));
  return `https://www.google.com/maps?q=${query}&z=16&output=embed`;
}

export function googleMapsDirectionsUrl(point: PlainLocationPoint): string {
  const destination = encodeURIComponent(locationCoordinateQuery(point));
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/maps-urls.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `cd hushh-webapp && npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd hushh-webapp
git add lib/one-location/maps-urls.ts lib/one-location/__tests__/maps-urls.test.ts
git commit -s -m "feat(one-location): shared google maps url helpers"
```

---

### Task 4: `<LiveMap>` component

The interactive map. Renders the map canvas only (parent card unchanged). Glides the marker between points; falls back to the iframe when not ready.

**Files:**
- Create: `hushh-webapp/components/one-location/live-map.tsx`
- Test: `hushh-webapp/components/one-location/__tests__/live-map.test.tsx`

**Interfaces:**
- Consumes: `useGoogleMaps` (Task 2); `easeInOutQuad`, `lerpLatLng`, `shouldSnap`, `LatLngLiteral` (Task 1); `googleMapsLocationEmbedUrl`, `locationLatLng` (Task 3); `PlainLocationPoint` from `@/lib/one-location/types`; `cn` from `@/lib/utils`.
- Produces:
  - `interface LiveMapProps { point: PlainLocationPoint; className?: string }`
  - `LiveMap(props: LiveMapProps): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/components/one-location/__tests__/live-map.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PlainLocationPoint } from "@/lib/one-location/types";

const mockStatus = { current: "loading" as "loading" | "ready" | "error" };
vi.mock("@/lib/one-location/use-google-maps", () => ({
  useGoogleMaps: () => ({ status: mockStatus.current }),
}));

import { LiveMap } from "@/components/one-location/live-map";

const point: PlainLocationPoint = {
  latitude: 12.9716,
  longitude: 77.5946,
  capturedAt: "2026-07-08T00:00:00.000Z",
  sourcePlatform: "web",
};

afterEach(() => {
  mockStatus.current = "loading";
  // @ts-expect-error test cleanup
  delete globalThis.google;
  vi.clearAllMocks();
});

describe("LiveMap", () => {
  it("falls back to the iframe embed when Maps is not ready", () => {
    mockStatus.current = "error";
    render(<LiveMap point={point} />);
    const iframe = screen.getByTitle(
      "Live location map preview",
    ) as HTMLIFrameElement;
    expect(iframe.src).toContain("output=embed");
    expect(iframe.src).toContain(encodeURIComponent("12.971600,77.594600"));
  });

  it("creates an interactive map + marker when ready", () => {
    const Marker = vi.fn(() => ({
      getPosition: () => null,
      setPosition: vi.fn(),
    }));
    const Map = vi.fn(() => ({ panTo: vi.fn() }));
    // @ts-expect-error test global
    globalThis.google = { maps: { Map, Marker } };
    mockStatus.current = "ready";

    render(<LiveMap point={point} />);

    expect(Map).toHaveBeenCalledTimes(1);
    expect(Marker).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle("Live location map preview")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd hushh-webapp && npx vitest run components/one-location/__tests__/live-map.test.tsx`
Expected: FAIL — cannot resolve `@/components/one-location/live-map`.

- [ ] **Step 3: Implement the component**

Create `hushh-webapp/components/one-location/live-map.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";

import {
  easeInOutQuad,
  lerpLatLng,
  shouldSnap,
  type LatLngLiteral,
} from "@/lib/one-location/marker-interpolation";
import {
  googleMapsLocationEmbedUrl,
  locationLatLng,
} from "@/lib/one-location/maps-urls";
import { useGoogleMaps } from "@/lib/one-location/use-google-maps";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

// One glide should finish before the next ~5s poll lands.
const MARKER_ANIMATION_MS = 1200;

export interface LiveMapProps {
  point: PlainLocationPoint;
  className?: string;
}

export function LiveMap({ point, className }: LiveMapProps) {
  const { status } = useGoogleMaps();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const frameRef = useRef<number | null>(null);

  const target: LatLngLiteral = locationLatLng(point);

  // Create the map + marker once the API is ready and the container exists.
  useEffect(() => {
    if (status !== "ready" || !containerRef.current || mapRef.current) return;
    const map = new google.maps.Map(containerRef.current, {
      center: target,
      zoom: 16,
      disableDefaultUI: true,
      clickableIcons: false,
    });
    mapRef.current = map;
    markerRef.current = new google.maps.Marker({ map, position: target });
    // Created once; subsequent movement handled by the glide effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Glide the marker to each new point.
  useEffect(() => {
    if (status !== "ready") return;
    const marker = markerRef.current;
    const map = mapRef.current;
    if (!marker || !map) return;

    const current = marker.getPosition();
    const from: LatLngLiteral = current
      ? { lat: current.lat(), lng: current.lng() }
      : target;

    if (shouldSnap(from, target)) {
      marker.setPosition(target);
      map.panTo(target);
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / MARKER_ANIMATION_MS);
      marker.setPosition(lerpLatLng(from, target, easeInOutQuad(t)));
      if (t < 1) {
        frameRef.current = requestAnimationFrame(step);
      }
    };
    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.lat, target.lng, status]);

  // Not ready (loading or error / no key) -> keep today's iframe embed.
  if (status !== "ready") {
    return (
      <iframe
        title="Live location map preview"
        src={googleMapsLocationEmbedUrl(point)}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        allowFullScreen
        className={cn("h-full w-full border-0", className)}
      />
    );
  }

  return <div ref={containerRef} className={cn("h-full w-full", className)} />;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run components/one-location/__tests__/live-map.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck + lint**

Run: `cd hushh-webapp && npm run typecheck && npm run lint`
Expected: no errors. (If lint flags the `google.maps` global type, confirm `@types/google.maps` from Task 2 is installed.)

- [ ] **Step 6: Commit**

```bash
cd hushh-webapp
git add components/one-location/live-map.tsx components/one-location/__tests__/live-map.test.tsx
git commit -s -m "feat(one-location): LiveMap component with gliding marker + iframe fallback"
```

---

### Task 5: Wire `<LiveMap>` into `LocalMapPreview` and speed up the recipient poll

Swap the iframe for `<LiveMap>` in the in-app preview, remove the now-unused local embed helper, and drop the recipient poll interval to 5s. No unit test: `page.tsx` is a ~5000-line client component that is not unit-testable in isolation — this task is verified by typecheck, lint, the full existing suite, and manual/device testing (Task 6).

**Files:**
- Modify: `hushh-webapp/app/one/location/page.tsx`

**Interfaces:**
- Consumes: `LiveMap` from `@/components/one-location/live-map` (Task 4).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the LiveMap import**

In `hushh-webapp/app/one/location/page.tsx`, add near the existing component imports (e.g. just after the `cn` import on line 189):

```tsx
import { LiveMap } from "@/components/one-location/live-map";
```

- [ ] **Step 2: Add the recipient refresh interval constant**

Find the constants block (around line 200):

```tsx
const LIVE_LOCATION_UPDATE_INTERVAL_MS = 20_000;
```

Add immediately below it:

```tsx
// Recipients poll faster than the owner's publish heartbeat so the shared dot
// stays fresh; the LiveMap marker interpolates between these reads.
const LIVE_VIEW_REFRESH_INTERVAL_MS = 5_000;
```

- [ ] **Step 3: Replace the iframe with `<LiveMap>` inside `LocalMapPreview`**

In `LocalMapPreview`, delete the line that computes the embed URL:

```tsx
  const embedUrl = googleMapsLocationEmbedUrl(point);
```

Then replace this block:

```tsx
        <iframe
          title="Live location map preview"
          src={embedUrl}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
          className="h-full w-full border-0"
        />
```

with:

```tsx
        <LiveMap point={point} />
```

- [ ] **Step 4: Delete the now-unused local embed helper**

The local `googleMapsLocationEmbedUrl` function (around line 782) is now unused (its only caller was removed in Step 3), which will fail `--max-warnings=0` lint. Delete exactly this function:

```tsx
function googleMapsLocationEmbedUrl(point: PlainLocationPoint): string {
  const query = encodeURIComponent(locationCoordinateQuery(point));
  return `https://www.google.com/maps?q=${query}&z=16&output=embed`;
}
```

Leave `locationCoordinateQuery`, `formatLocationCoordinate`, and `googleMapsDirectionsUrl` in place — they still back the "Directions" button.

- [ ] **Step 5: Point the recipient poll loop at the faster interval**

Find the recipient live-view interval (the one calling `refreshVisibleGrants`, around line 3533):

```tsx
    void refreshVisibleGrants();
    const interval = window.setInterval(
      () => void refreshVisibleGrants(),
      LIVE_LOCATION_UPDATE_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [activeVisibleReceivedGrants, busy, viewGrantEnvelope]);
```

Change only the interval argument:

```tsx
    void refreshVisibleGrants();
    const interval = window.setInterval(
      () => void refreshVisibleGrants(),
      LIVE_VIEW_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [activeVisibleReceivedGrants, busy, viewGrantEnvelope]);
```

Do **not** change the other interval that calls `publishActiveGrants` (the owner publish heartbeat) — it must stay on `LIVE_LOCATION_UPDATE_INTERVAL_MS`.

- [ ] **Step 6: Typecheck + lint**

Run: `cd hushh-webapp && npm run typecheck && npm run lint`
Expected: no errors (in particular, no "unused variable" for the removed embed helper / `embedUrl`).

- [ ] **Step 7: Run the full One Location suite (regression)**

Run: `cd hushh-webapp && npx vitest run lib/one-location components/one-location`
Expected: all green, including the pre-existing one-location tests plus the new files.

- [ ] **Step 8: Commit**

```bash
cd hushh-webapp
git add app/one/location/page.tsx
git commit -s -m "feat(one-location): use LiveMap in preview + 5s recipient poll"
```

---

### Task 6: Rollout — key provisioning + device verification (human)

Non-code checklist. The code degrades to the iframe until the key exists, so it is safe to merge before this is done.

**Files:** none.

- [ ] **Step 1: Provision the browser key (human, in GCP)**

Create a Google Maps Platform API key with:
- **API restriction:** Maps JavaScript API only.
- **Application restriction:** HTTP referrers → Hushh production domains, UAT hosts, and `http://localhost:*` for local dev.

- [ ] **Step 2: Set the env var**

Add `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=<the browser key>` to the `hushh-webapp` environment for **UAT first**, then **prod** (same mechanism used for other `NEXT_PUBLIC_*` vars / how PR #4343 wired the backend key). Redeploy the webapp.

- [ ] **Step 3: Verify on UAT (browser)**

Open a live share as recipient on UAT. Confirm: the map is interactive (drag/zoom) rather than a static iframe, and the marker glides as the sender moves rather than the map reloading. If the key is missing/misconfigured, confirm it still shows the iframe (no error/blank).

- [ ] **Step 4: Device verification + recording (once TestFlight access restored)**

On a real device, share live location between two accounts and confirm the recipient sees a smoothly moving dot at ~5s freshness. Capture a screen recording for the founder update.

---

## Self-Review

**Spec coverage:**
- Map rendering via Maps JS API + `@googlemaps/js-api-loader` → Tasks 2, 4. ✓
- Gliding marker / interpolation → Tasks 1, 4. ✓
- Recipient poll 20s → 5s (owner cadence + watchPosition unchanged) → Task 5. ✓
- Separate referrer-restricted `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`; server key untouched → Tasks 2, 6; enforced in Global Constraints. ✓
- In-app surfaces only (`LocalMapPreview`); public token pages untouched → Task 5 + Global Constraints. ✓
- Graceful fallback to iframe → Task 4 (`status !== "ready"`), verified in tests. ✓
- Testing (unit interpolation, component fallback + ready) → Tasks 1, 3, 4; regression → Task 5. ✓
- Rollout ordering (ship code → provision key) → Task 6. ✓
- Out of scope (SSE, token pages, native background, route polyline) → not planned. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code and exact commands. ✓

**Type consistency:** `MapsLoadStatus` ("loading"|"ready"|"error"), `LatLngLiteral`, `useGoogleMaps().status`, `LiveMapProps`, and the `PlainLocationPoint` fields (`latitude`/`longitude`/`capturedAt`/`sourcePlatform`) are used identically across Tasks 1–5. Marker API (`getPosition()`/`setPosition()`/`panTo()`) and `google.maps.Map`/`google.maps.Marker` match between the component (Task 4) and its test mocks. ✓
