import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PlainLocationPoint } from "@/lib/one-location/types";

const mockStatus = { current: "loading" as "loading" | "ready" | "error" };
vi.mock("@/lib/one-location/use-google-maps", () => ({
  useGoogleMaps: () => ({ status: mockStatus.current }),
}));

const mockTheme = { current: "light" as "light" | "dark" };
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: mockTheme.current }),
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

  it("uses a marker-free fallback map for an approximate area", () => {
    mockStatus.current = "error";
    render(
      <LiveMap point={point} mode="approximate" approximateRadiusM={1_000} />,
    );

    const iframe = screen.getByTitle(
      "Approximate location area map preview",
    ) as HTMLIFrameElement;
    expect(iframe.src).toContain(
      `ll=${encodeURIComponent("12.971600,77.594600")}`,
    );
    expect(iframe.src).not.toContain("?q=");
  });

  it("keeps the iframe centered until the point moves past the recenter threshold", () => {
    mockStatus.current = "error";
    const iframeSrc = () =>
      (screen.getByTitle("Live location map preview") as HTMLIFrameElement).src;

    const { rerender } = render(<LiveMap point={point} />);
    expect(iframeSrc()).toContain(encodeURIComponent("12.971600,77.594600"));

    // ~11 m north — below the 50 m threshold, embed stays put (no reload).
    rerender(<LiveMap point={{ ...point, latitude: 12.9717 }} />);
    expect(iframeSrc()).toContain(encodeURIComponent("12.971600,77.594600"));

    // ~111 m north — past the threshold, embed recenters.
    rerender(<LiveMap point={{ ...point, latitude: 12.9726 }} />);
    expect(iframeSrc()).toContain(encodeURIComponent("12.972600,77.594600"));
  });

  it("creates an interactive map + marker when ready", () => {
    // vitest 4.x requires non-arrow implementations for mocks called with `new`.
    const Marker = vi.fn(function () {
      return { getPosition: () => null, setPosition: vi.fn() };
    });
    const Map = vi.fn(function () {
      return { panTo: vi.fn() };
    });
    // @ts-expect-error test global
    globalThis.google = { maps: { Map, Marker } };
    mockStatus.current = "ready";

    render(<LiveMap point={point} />);

    expect(Map).toHaveBeenCalledTimes(1);
    expect(Marker).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle("Live location map preview")).toBeNull();
  });

  it("creates only a radius circle for an approximate area", () => {
    const Marker = vi.fn(function () {
      return { getPosition: () => null, setPosition: vi.fn() };
    });
    const setCenter = vi.fn();
    const setRadius = vi.fn();
    const Circle = vi.fn(function () {
      return { setCenter, setRadius };
    });
    const Map = vi.fn(function () {
      return { panTo: vi.fn() };
    });
    // @ts-expect-error test global
    globalThis.google = { maps: { Circle, Map, Marker } };
    mockStatus.current = "ready";

    render(
      <LiveMap point={point} mode="approximate" approximateRadiusM={1_250} />,
    );

    expect(Circle).toHaveBeenCalledWith(
      expect.objectContaining({
        center: { lat: point.latitude, lng: point.longitude },
        radius: 1_250,
      }),
    );
    expect(Marker).not.toHaveBeenCalled();
  });

  it("constructs a quiet preview map with the app theme's color scheme", () => {
    const Marker = vi.fn(function () {
      return { getPosition: () => null, setPosition: vi.fn() };
    });
    const Map = vi.fn(function () {
      return { panTo: vi.fn() };
    });
    // @ts-expect-error test global
    globalThis.google = { maps: { Map, Marker } };
    mockStatus.current = "ready";
    mockTheme.current = "dark";

    render(<LiveMap point={point} />);

    expect(Map).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        colorScheme: "DARK",
        disableDefaultUI: true,
        keyboardShortcuts: false,
      }),
    );
    mockTheme.current = "light";
  });

  it("applies a dark filter to the iframe fallback so it cannot glow white", () => {
    mockStatus.current = "error";
    render(<LiveMap point={point} />);
    const iframe = screen.getByTitle("Live location map preview");
    expect(iframe.className).toContain("dark:[filter:");
  });

  describe("marker animation", () => {
    // Shared mutable state for the stateful Marker mock.
    let markerInternalPos: { lat: number; lng: number } | null;
    let markerSetPositionSpy: ReturnType<typeof vi.fn>;
    let mapPanToSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      markerInternalPos = null;
      mapPanToSpy = vi.fn();
      markerSetPositionSpy = vi.fn((pos: { lat: number; lng: number }) => {
        markerInternalPos = pos;
      });

      // Stateful Marker: stores position from constructor opts and from setPosition().
      // vitest 4.x requires non-arrow function expressions for mocks called with `new`.
      const Marker = vi.fn(function (opts: {
        map: unknown;
        position: { lat: number; lng: number };
      }) {
        markerInternalPos = opts.position ?? null;
        return {
          getPosition: () =>
            markerInternalPos !== null
              ? {
                  lat: () => markerInternalPos!.lat,
                  lng: () => markerInternalPos!.lng,
                }
              : null,
          setPosition: markerSetPositionSpy,
        };
      });

      const Map = vi.fn(function () {
        return { panTo: mapPanToSpy };
      });

      // @ts-expect-error test global
      globalThis.google = { maps: { Map, Marker } };
      mockStatus.current = "ready";

      // Fix performance.now() so `start` is always 0 for deterministic t calculation.
      vi.stubGlobal("performance", { now: () => 0 });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("glides the marker to a nearby point (small movement < 2 km)", () => {
      // Drive the animation synchronously: rAF immediately fires the callback at
      // time=1200ms so that t = (1200 - 0) / 1200 = 1 and the animation completes
      // in one step.
      const rafStub = vi.fn((cb: (time: number) => void) => {
        cb(1200);
        return 1;
      });
      vi.stubGlobal("requestAnimationFrame", rafStub);

      const pointA: PlainLocationPoint = {
        latitude: 12.9716,
        longitude: 77.5946,
        capturedAt: "2026-07-08T00:00:00.000Z",
        sourcePlatform: "web",
      };
      // ~15 m from A — well below the 2 km snap threshold.
      const pointB: PlainLocationPoint = {
        latitude: 12.9717,
        longitude: 77.5947,
        capturedAt: "2026-07-08T00:01:00.000Z",
        sourcePlatform: "web",
      };

      const { rerender } = render(<LiveMap point={pointA} />);

      // Clear call history from the initial A→A glide; markerInternalPos stays = A.
      markerSetPositionSpy.mockClear();
      mapPanToSpy.mockClear();
      rafStub.mockClear();

      rerender(<LiveMap point={pointB} />);
      expect(rafStub).toHaveBeenCalled();

      // lerpLatLng(A, B, easeInOutQuad(1)) = lerpLatLng(A, B, 1) = B.
      const calls = markerSetPositionSpy.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const lastSetPos = calls.at(-1)![0] as { lat: number; lng: number };
      expect(lastSetPos.lat).toBeCloseTo(pointB.latitude, 5);
      expect(lastSetPos.lng).toBeCloseTo(pointB.longitude, 5);

      // panTo(target) is called when the animation step reaches t = 1.
      expect(mapPanToSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          lat: pointB.latitude,
          lng: pointB.longitude,
        }),
      );
    });

    it("snaps the marker immediately on a large jump (> 2 km), no rAF", () => {
      const rafStub = vi.fn((cb: (time: number) => void) => {
        cb(1200);
        return 1;
      });
      vi.stubGlobal("requestAnimationFrame", rafStub);

      const pointA: PlainLocationPoint = {
        latitude: 12.9716,
        longitude: 77.5946,
        capturedAt: "2026-07-08T00:00:00.000Z",
        sourcePlatform: "web",
      };
      // Tokyo — ~6 500 km from Bangalore, far beyond the 2 km snap threshold.
      const pointFar: PlainLocationPoint = {
        latitude: 35.6762,
        longitude: 139.6503,
        capturedAt: "2026-07-08T00:01:00.000Z",
        sourcePlatform: "web",
      };

      const { rerender } = render(<LiveMap point={pointA} />);

      // Reset call history; markerInternalPos stays = A so the snap distance is real.
      markerSetPositionSpy.mockClear();
      mapPanToSpy.mockClear();
      rafStub.mockClear();

      rerender(<LiveMap point={pointFar} />);

      // Snap path: setPosition called immediately with the far point.
      expect(markerSetPositionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          lat: pointFar.latitude,
          lng: pointFar.longitude,
        }),
      );
      // panTo called immediately with the far point.
      expect(mapPanToSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          lat: pointFar.latitude,
          lng: pointFar.longitude,
        }),
      );
      // No animation frame scheduled — the snap path returns early.
      expect(rafStub).not.toHaveBeenCalled();
    });
  });
});
