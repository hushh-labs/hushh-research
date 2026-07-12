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
