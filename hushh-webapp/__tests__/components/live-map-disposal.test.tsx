import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlainLocationPoint } from "@/lib/one-location/types";

const mapsHarness = vi.hoisted(() => ({
  status: "ready" as "loading" | "ready" | "error",
}));

vi.mock("@/lib/one-location/use-google-maps", () => ({
  useGoogleMaps: () => ({ status: mapsHarness.status }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

import { LiveMap } from "@/components/one-location/live-map";

const POINT: PlainLocationPoint = {
  latitude: 28.6139,
  longitude: 77.209,
  accuracyM: 12,
  capturedAt: "2026-08-14T12:00:00.000Z",
  sourcePlatform: "web",
} as PlainLocationPoint;

type MarkerStub = {
  setMap: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  getPosition: ReturnType<typeof vi.fn>;
};

let createdMaps: object[] = [];
let createdMarkers: MarkerStub[] = [];
let clearInstanceListeners: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mapsHarness.status = "ready";
  createdMaps = [];
  createdMarkers = [];
  clearInstanceListeners = vi.fn();

  class MapStub {
    constructor() {
      createdMaps.push(this);
    }
    panTo = vi.fn();
    setZoom = vi.fn();
  }

  class MarkerStubImpl {
    setMap = vi.fn();
    setPosition = vi.fn();
    getPosition = vi.fn(() => null);
    constructor() {
      createdMarkers.push(this as unknown as MarkerStub);
    }
  }

  (globalThis as unknown as { google: unknown }).google = {
    maps: {
      Map: MapStub,
      Marker: MarkerStubImpl,
      event: { clearInstanceListeners },
    },
  };
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { google?: unknown }).google;
  vi.restoreAllMocks();
});

describe("LiveMap disposes its Google Maps instances", () => {
  // A Maps instance is not garbage just because the React ref dropped it. It
  // keeps its own listeners, tile requests and resize handlers running, so an
  // undisposed map goes on doing work for the life of the page. On One Location
  // that work lands on the same main thread the back control needs.
  it("detaches the marker and clears listeners on unmount", () => {
    const { unmount } = render(<LiveMap point={POINT} />);

    expect(createdMaps).toHaveLength(1);
    expect(createdMarkers).toHaveLength(1);

    unmount();

    expect(createdMarkers[0].setMap).toHaveBeenCalledWith(null);
    expect(clearInstanceListeners).toHaveBeenCalledWith(createdMarkers[0]);
    expect(clearInstanceListeners).toHaveBeenCalledWith(createdMaps[0]);
  });

  it("does not leave the previous map running when the theme re-keys the container", async () => {
    const themes = await import("next-themes");
    const useTheme = vi.spyOn(themes, "useTheme");

    useTheme.mockReturnValue({
      resolvedTheme: "dark",
    } as ReturnType<typeof themes.useTheme>);
    const { rerender, unmount } = render(<LiveMap point={POINT} />);
    expect(createdMaps).toHaveLength(1);

    useTheme.mockReturnValue({
      resolvedTheme: "light",
    } as ReturnType<typeof themes.useTheme>);
    rerender(<LiveMap point={POINT} />);

    // The scheme flip builds a second map; the first one must have been torn
    // down rather than left animating behind it.
    expect(createdMaps).toHaveLength(2);
    expect(clearInstanceListeners).toHaveBeenCalledWith(createdMaps[0]);
    expect(createdMarkers[0].setMap).toHaveBeenCalledWith(null);

    unmount();
  });
});
