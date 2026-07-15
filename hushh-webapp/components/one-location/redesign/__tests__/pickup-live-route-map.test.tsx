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

describe("PickupLiveRouteMap", () => {
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
});
