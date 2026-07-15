import { it, expect, vi } from "vitest";
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
