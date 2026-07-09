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
});
