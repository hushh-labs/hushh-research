import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useCurrentLocation: vi.fn(),
  request: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("lucide-react", () => ({
  MapPin: () => <span data-testid="map-pin-icon" />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/lib/one-location/use-current-location", () => ({
  useCurrentLocation: mocks.useCurrentLocation,
}));

import { RiaLocationMap } from "@/components/ria/profile/ria-location-map";

const ADDRESS = {
  fullStreetAddress: "4050 E. Cotton Center Blvd.",
  areaLocality: "Cotton Center",
  city: "Phoenix",
  pinZip: "85040",
};

const DESTINATION =
  "4050 E. Cotton Center Blvd., Cotton Center, Phoenix, 85040";

function setLocation(
  state: Partial<{
    status: string;
    permission: string | null;
    snapshot: {
      latitude: number;
      longitude: number;
      accuracyM: number | null;
      capturedAt: string;
    } | null;
    error: string | null;
  }> = {},
) {
  mocks.useCurrentLocation.mockReturnValue({
    status: "idle",
    permission: null,
    snapshot: null,
    error: null,
    request: mocks.request,
    refresh: mocks.refresh,
    ...state,
  });
}

describe("RiaLocationMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLocation();
  });

  it("renders the office-only embed while no position is held", () => {
    render(<RiaLocationMap {...ADDRESS} />);

    const office = screen.getByTestId("ria-location-map-office");
    expect(office.getAttribute("src")).toContain("output=embed");
    expect(office.getAttribute("src")).toContain(
      encodeURIComponent(DESTINATION),
    );
    expect(screen.queryByTestId("ria-location-map-route")).toBeNull();
    expect(screen.getByTestId("ria-location-map-show-route")).toBeTruthy();
  });

  it("never asks for location on mount — only from the button", () => {
    render(<RiaLocationMap {...ADDRESS} />);
    expect(mocks.request).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("ria-location-map-show-route"));
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("shows a busy button while locating", () => {
    setLocation({ status: "locating", permission: "granted" });
    render(<RiaLocationMap {...ADDRESS} />);

    const button = screen.getByTestId(
      "ria-location-map-show-route",
    ) as HTMLButtonElement;
    expect(button.textContent).toContain("Locating");
    expect(button.disabled).toBe(true);
  });

  it("renders the directions embed with both endpoints once a position exists", () => {
    setLocation({
      status: "ready",
      permission: "granted",
      snapshot: {
        latitude: 12.9716,
        longitude: 77.5946,
        accuracyM: 12,
        capturedAt: "2026-08-08T00:00:00.000Z",
      },
    });
    render(<RiaLocationMap {...ADDRESS} />);

    const route = screen.getByTestId("ria-location-map-route");
    const src = route.getAttribute("src") ?? "";
    expect(src).toContain("output=embed");
    expect(src).toContain(`saddr=${encodeURIComponent("12.971600,77.594600")}`);
    expect(src).toContain(`daddr=${encodeURIComponent(DESTINATION)}`);
    // The route replaces the office-only view, and the prompt is spent.
    expect(screen.queryByTestId("ria-location-map-office")).toBeNull();
    expect(screen.queryByTestId("ria-location-map-show-route")).toBeNull();
  });

  it("keeps the office map and drops the dead button when permission is denied", () => {
    setLocation({
      status: "denied",
      permission: "denied",
      error: "Location is off for Hussh.",
    });
    render(<RiaLocationMap {...ADDRESS} />);

    expect(screen.getByTestId("ria-location-map-office")).toBeTruthy();
    expect(screen.getByTestId("ria-location-map-denied").textContent).toContain(
      "Location is off — showing the office only.",
    );
    expect(screen.queryByTestId("ria-location-map-show-route")).toBeNull();
  });

  it("treats an unavailable device the same as denied", () => {
    setLocation({ status: "unavailable", permission: "unavailable" });
    render(<RiaLocationMap {...ADDRESS} />);

    expect(screen.getByTestId("ria-location-map-office")).toBeTruthy();
    expect(screen.queryByTestId("ria-location-map-show-route")).toBeNull();
  });

  it("names every missing field instead of hiding the map", () => {
    render(
      <RiaLocationMap
        fullStreetAddress=""
        areaLocality=""
        city=""
        pinZip="   "
      />,
    );

    expect(screen.getByTestId("ria-location-map-missing").textContent).toContain(
      "Location unavailable — missing: street address, area, city, PIN / ZIP",
    );
    expect(screen.queryByTestId("ria-location-map-office")).toBeNull();
    expect(screen.queryByTestId("ria-location-map-route")).toBeNull();
    // Nothing to route to, so no control is offered.
    expect(screen.queryByTestId("ria-location-map-show-route")).toBeNull();
  });

  it("names only the fields actually missing", () => {
    render(
      <RiaLocationMap
        fullStreetAddress=""
        areaLocality=""
        city="Phoenix"
        pinZip="85040"
      />,
    );

    const office = screen.getByTestId("ria-location-map-office");
    expect(office.getAttribute("src")).toContain(
      encodeURIComponent("Phoenix, 85040"),
    );
    expect(screen.queryByTestId("ria-location-map-missing")).toBeNull();
  });

  it("keeps a retryable button when a fix fails but permission is intact", () => {
    setLocation({
      status: "error",
      permission: "granted",
      error: "Could not get your location.",
    });
    render(<RiaLocationMap {...ADDRESS} />);

    expect(screen.getByTestId("ria-location-map-show-route")).toBeTruthy();
    expect(screen.queryByTestId("ria-location-map-denied")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A geocoded office, and a route that would cross an ocean.
//
// "MENDOCINO" is a bare city name that exists on four continents, so the
// embed's own geocoder cannot know which one we mean — and asking Google for
// driving directions from India to California returns no route at all, which
// renders as two pins on a whole-world map.
// ---------------------------------------------------------------------------

const MENDOCINO = {
  fullStreetAddress: "",
  areaLocality: "",
  city: "MENDOCINO",
  pinZip: "",
  latitude: 39.3076744,
  longitude: -123.7994591,
  countryCode: "US",
};

/** Bengaluru — ~13,000 km from the Mendocino office. */
const FAR_AWAY = {
  status: "ready",
  permission: "granted",
  snapshot: {
    latitude: 12.9716,
    longitude: 77.5946,
    accuracyM: 12,
    capturedAt: "2026-08-08T00:00:00.000Z",
  },
};

/** Ukiah — ~50 km from the Mendocino office, an ordinary drive. */
const NEARBY = {
  status: "ready",
  permission: "granted",
  snapshot: {
    latitude: 39.1502,
    longitude: -123.2078,
    accuracyM: 12,
    capturedAt: "2026-08-08T00:00:00.000Z",
  },
};

describe("RiaLocationMap — geocoded office", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLocation();
  });

  it("places the office by its coordinates, not its ambiguous name", () => {
    render(<RiaLocationMap {...MENDOCINO} />);

    const src = screen.getByTestId("ria-location-map-office").getAttribute("src") ?? "";
    expect(src).toContain(encodeURIComponent("39.307674,-123.799459"));
    expect(src).toContain("z=16");
    expect(src).not.toContain("MENDOCINO");
  });

  it("falls back to the address plus its country when no position is stored", () => {
    render(<RiaLocationMap {...MENDOCINO} latitude={null} longitude={null} />);

    const src = screen.getByTestId("ria-location-map-office").getAttribute("src") ?? "";
    expect(src).toContain(encodeURIComponent("MENDOCINO, US"));
  });

  it("shows the office and the real distance instead of a world-spanning route", () => {
    setLocation(FAR_AWAY);
    render(<RiaLocationMap {...MENDOCINO} />);

    expect(screen.queryByTestId("ria-location-map-route")).toBeNull();
    expect(screen.getByTestId("ria-location-map-office")).toBeTruthy();
    expect(screen.getByTestId("ria-location-map-too-far").textContent).toContain("km from you");
  });

  it("still draws the route for a viewer who could actually drive there", () => {
    setLocation(NEARBY);
    render(<RiaLocationMap {...MENDOCINO} />);

    expect(screen.getByTestId("ria-location-map-route")).toBeTruthy();
    expect(screen.queryByTestId("ria-location-map-too-far")).toBeNull();
  });

  it("keeps drawing the route when the office position is unknown", () => {
    // Unmeasurable distance must never suppress behaviour that already worked.
    setLocation(FAR_AWAY);
    render(<RiaLocationMap {...MENDOCINO} latitude={null} longitude={null} />);

    expect(screen.getByTestId("ria-location-map-route")).toBeTruthy();
    expect(screen.queryByTestId("ria-location-map-too-far")).toBeNull();
  });
});
