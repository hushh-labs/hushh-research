import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mapHarness = vi.hoisted(() => {
  const map = {
    addCircles: vi.fn(async (_circles: unknown[]) => ["circle-0"]),
    addMarkers: vi.fn(async (markers: unknown[]) =>
      markers.map((_, index) => `marker-${index}`),
    ),
    addPolylines: vi.fn(async (_lines: unknown[]) => ["polyline-0"]),
    removePolylines: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    disableTouch: vi.fn(async () => undefined),
    disableClustering: vi.fn(async () => undefined),
    enableTouch: vi.fn(async () => undefined),
    enableClustering: vi.fn(async () => undefined),
    fitBounds: vi.fn(async () => undefined),
    removeMarkers: vi.fn(async () => undefined),
    removeCircles: vi.fn(async () => undefined),
    setCamera: vi.fn(async () => undefined),
    setOnMarkerClickListener: vi.fn(async () => undefined),
    setPadding: vi.fn(async () => undefined),
  };
  return {
    map,
    create: vi.fn(async () => map),
  };
});

const serviceHarness = vi.hoisted(() => ({
  captureCurrentPosition: vi.fn(async () => ({
    latitude: 37.776,
    longitude: -122.418,
    accuracyM: 12,
    capturedAt: "2026-07-23T00:00:00.000Z",
    sourcePlatform: "ios" as const,
  })),
  getMapState: vi.fn(),
  getState: vi.fn(),
  requestNearbyConnection: vi.fn(),
  storeEnvelope: vi.fn(),
  updateMapPreferences: vi.fn(),
}));

const navigationHarness = vi.hoisted(() => ({
  beginRouteTransition: vi.fn((_href: string, navigate: () => void) =>
    navigate(),
  ),
  push: vi.fn(),
  replace: vi.fn(),
}));

const experienceHarness = vi.hoisted(() => ({
  demoMode: true,
  nearbyAvailable: false,
  query: "demo=people",
  searchPoint: {
    latitude: 37.776,
    longitude: -122.418,
    accuracyM: 12,
    capturedAt: "2026-07-23T00:00:00.000Z",
    sourcePlatform: "web" as const,
  },
  placeFocus: {
    placeId: "hotel-two",
    label: "Hotel Two",
    // ~180 m north-east of the search point: the everyday case where the
    // owner's position and their check-in place are not the same spot.
    latitude: 37.7775,
    longitude: -122.4172,
    distanceMeters: 180,
    active: false,
  } as {
    placeId: string;
    label: string;
    latitude: number;
    longitude: number;
    distanceMeters: number | null;
    active: boolean;
  },
}));

vi.mock("@capacitor/google-maps", () => ({
  GoogleMap: { create: mapHarness.create },
  LatLngBounds: class LatLngBounds {
    constructor(public readonly value: unknown) {}
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: navigationHarness.push,
    replace: navigationHarness.replace,
  }),
  useSearchParams: () => new URLSearchParams(experienceHarness.query),
}));

vi.mock("@/lib/morphy-ux/hooks/use-route-transition", () => ({
  beginRouteTransition: navigationHarness.beginRouteTransition,
}));

vi.mock("@/hooks/use-auth", () => ({
  useRequireAuth: () => ({ userId: "test-user" }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "in-memory-owner-token" }),
}));

vi.mock("@/lib/capacitor/platform", () => ({
  getPlatform: () => "web",
  isNative: () => false,
}));

vi.mock("@/lib/one-location/maps-config", () => ({
  getBrowserMapsApiKey: () => "browser-test-key",
  getNativeMapsApiKey: () => "native-test-key",
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: serviceHarness,
}));

vi.mock("@/lib/testing/location-map-demo", () => ({
  isLocationMapDemoAvailable: () => true,
  isLocationMapDemoEnabled: () => experienceHarness.demoMode,
  locationMapDemoPeople: () => [
    {
      key: "demo-maya",
      label: "Maya Chen",
      point: {
        latitude: 37.7793,
        longitude: -122.4192,
        capturedAt: "2026-07-23T00:00:00.000Z",
        sourcePlatform: "web",
      },
      tint: { r: 0, g: 122, b: 255, a: 255 },
    },
    {
      key: "demo-jordan",
      label: "Jordan Lee",
      point: {
        latitude: 37.7694,
        longitude: -122.4862,
        capturedAt: "2026-07-23T00:00:00.000Z",
        sourcePlatform: "web",
      },
      tint: { r: 52, g: 199, b: 89, a: 255 },
    },
    {
      key: "demo-sam",
      label: "Sam Rivera",
      point: {
        latitude: 37.8021,
        longitude: -122.4058,
        capturedAt: "2026-07-23T00:00:00.000Z",
        sourcePlatform: "web",
      },
      tint: { r: 255, g: 149, b: 0, a: 255 },
    },
  ],
}));

vi.mock("@/lib/one-location/nearby-check-in-availability", () => ({
  isOneLocationNearbyCheckInAvailable: () => experienceHarness.nearbyAvailable,
}));

vi.mock(
  "@/components/one-location/nearby-check-in/nearby-check-in-sheet",
  () => ({
    NearbyCheckInSheet: ({
      open,
      onOpenChange,
      onStateChange,
      onSearchAreaChange,
      onPlaceFocusChange,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      onStateChange: (state: unknown) => void;
      onSearchAreaChange: (point: unknown) => void;
      onPlaceFocusChange: (focus: unknown) => void;
    }) => (
      <div
        data-testid="nearby-check-in-sheet-mock"
        data-one-location-nearby-check-in-sheet=""
        data-open={open ? "true" : "false"}
      >
        <button
          type="button"
          data-testid="dismiss-nearby-check-in"
          onClick={() => onOpenChange(false)}
        >
          Dismiss check-in
        </button>
        <button
          type="button"
          data-testid="publish-nearby-state"
          onClick={() =>
            onStateChange({
              presence: {
                status: "active",
                audience: "all_opted_in",
                radiusMeters: 500,
                allowConnectionRequests: true,
                consentVersion: "one-location-nearby-presence-v3",
                checkedInAt: "2026-07-31T00:00:00.000Z",
                expiresAt: "2026-07-31T01:00:00.000Z",
                placeLabel: "Event venue",
              },
              attendees: [
                {
                  participantAlias: "rotating-neelesh",
                  displayName: "Neelesh Meena",
                  relationship: "connected",
                  canConnect: false,
                },
                {
                  participantAlias: "rotating-aarav",
                  displayName: "Aarav Shah",
                  relationship: "none",
                  canConnect: true,
                },
              ],
            })
          }
        >
          Publish nearby state
        </button>
        <button
          type="button"
          data-testid="publish-nearby-search-area"
          onClick={() => onSearchAreaChange(experienceHarness.searchPoint)}
        >
          Publish search area
        </button>
        <button
          type="button"
          data-testid="clear-nearby-search-area"
          onClick={() => onSearchAreaChange(null)}
        >
          Clear search area
        </button>
        <button
          type="button"
          data-testid="publish-nearby-place-focus"
          onClick={() => onPlaceFocusChange(experienceHarness.placeFocus)}
        >
          Publish place focus
        </button>
        <button
          type="button"
          data-testid="clear-nearby-place-focus"
          onClick={() => onPlaceFocusChange(null)}
        >
          Clear place focus
        </button>
      </div>
    ),
  }),
);

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
}));

import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";
import { beginNearbyPrivateReturn } from "@/lib/one-location/nearby-private-navigation";
import {
  forgetOneLocationControlPreference,
  readOneLocationControlState,
  updateOneLocationControlState,
} from "@/lib/one-location/location-control-state";
import { forgetCachedRendererConsent } from "@/lib/one-location/map-renderer-consent";
import { __resetNativeMapLifecycleForTests } from "@/lib/one-location/native-map-lifecycle";

const DEFAULT_PLACE_FOCUS = { ...experienceHarness.placeFocus };

beforeEach(() => {
  // Lanes are module state: without this a superseded claim or a queued
  // teardown from an earlier case leaks into the next one.
  __resetNativeMapLifecycleForTests();
  experienceHarness.placeFocus = { ...DEFAULT_PLACE_FOCUS };
  forgetOneLocationControlPreference("test-user");
  forgetCachedRendererConsent("test-user");
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/one/location/map");
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 768,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  experienceHarness.demoMode = true;
  experienceHarness.nearbyAvailable = false;
  experienceHarness.query = "demo=people";
  experienceHarness.searchPoint = {
    latitude: 37.776,
    longitude: -122.418,
    accuracyM: 12,
    capturedAt: "2026-07-23T00:00:00.000Z",
    sourcePlatform: "web",
  };
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  serviceHarness.getMapState.mockResolvedValue({
    markers: [],
    preferences: { presenceMode: "ghost" },
  });
  serviceHarness.captureCurrentPosition.mockResolvedValue({
    latitude: 37.776,
    longitude: -122.418,
    accuracyM: 12,
    capturedAt: "2026-07-23T00:00:00.000Z",
    sourcePlatform: "ios",
  });
  serviceHarness.getState.mockResolvedValue({
    recipients: [],
    ownerGrants: [],
  });
  serviceHarness.requestNearbyConnection.mockResolvedValue({
    relationship: "pending_outgoing",
  });
  serviceHarness.storeEnvelope.mockResolvedValue(undefined);
  serviceHarness.updateMapPreferences.mockResolvedValue({
    presenceMode: "ghost",
    rendererConsentVersion: "google-maps-renderer-v1",
  });
});

afterEach(() => {
  forgetOneLocationControlPreference("test-user");
  forgetCachedRendererConsent("test-user");
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const value of Object.values(mapHarness.map)) {
    if ("mockClear" in value) value.mockClear();
  }
  mapHarness.create.mockClear();
  // Restored explicitly: the lifecycle cases below swap in their own
  // implementation, and vi.restoreAllMocks() only rolls back spies.
  mapHarness.create.mockImplementation(async () => mapHarness.map);
  navigationHarness.beginRouteTransition.mockClear();
  navigationHarness.push.mockClear();
  navigationHarness.replace.mockClear();
  for (const value of Object.values(serviceHarness)) value.mockReset();
});

describe("LocationImmersiveMap demo experience", () => {
  it("uses a full-width mobile disclosure and a bounded desktop reading measure", () => {
    experienceHarness.demoMode = false;

    render(<LocationImmersiveMap />);

    expect(screen.getByTestId("one-location-map-disclosure")).toHaveClass(
      "inset-x-0",
      "md:left-1/2",
      "md:w-[min(52rem,calc(100%-4rem))]",
      "md:-translate-x-1/2",
    );
  });

  it("frames demo people, searches locally, focuses, locates, and exits without writes", async () => {
    render(<LocationImmersiveMap />);

    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });
    expect(screen.getAllByTestId("one-location-map-person")).toHaveLength(3);
    expect(screen.getByTestId("one-location-map-demo-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("one-location-map-demo-toggle")).toHaveClass(
      "bg-[var(--app-accent)]",
      "text-[var(--app-accent-fg)]",
    );
    expect(screen.getByTestId("one-location-map-close")).toHaveClass(
      "!bg-[var(--app-accent-surface)]",
      "!text-[var(--app-accent-deep)]",
    );
    await waitFor(() => {
      expect(serviceHarness.captureCurrentPosition).toHaveBeenCalledTimes(1);
      expect(mapHarness.map.setCamera).toHaveBeenCalledWith({
        coordinate: { lat: 37.776, lng: -122.418 },
        zoom: 16,
        animate: true,
      });
    });
    expect(mapHarness.map.fitBounds).not.toHaveBeenCalled();
    expect(serviceHarness.getMapState).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("one-location-map-search"), {
      target: { value: "Jordan" },
    });
    expect(screen.getAllByTestId("one-location-map-person")).toHaveLength(1);
    const jordanButton = screen.getByRole("button", {
      name: "Show Jordan Lee on the map",
    });
    expect(screen.getAllByRole("button", { name: /everyone/i })).toHaveLength(1);
    fireEvent.click(jordanButton);
    expect(jordanButton).toHaveClass(
      "bg-[var(--app-accent)]",
      "text-[var(--app-accent-fg)]",
    );
    await waitFor(() => {
      expect(mapHarness.map.setCamera).toHaveBeenCalledWith(
        expect.objectContaining({
          coordinate: { lat: 37.7694, lng: -122.4862 },
          zoom: 15,
          animate: true,
        }),
      );
    });
    expect(screen.getByTestId("one-location-map-tray-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByTestId("one-location-map-people-tray")).toHaveStyle({
      width: "3.5rem",
      height: "3.5rem",
      borderRadius: "999px",
    });
    expect(screen.getByTestId("one-location-map-tray-body")).toHaveClass(
      "pointer-events-none",
      "translate-y-2",
      "opacity-0",
    );
    fireEvent.click(screen.getByTestId("one-location-map-tray-toggle"));
    expect(screen.getByTestId("one-location-map-tray-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("one-location-map-people-tray")).toHaveStyle({
      width:
        "min(34rem, calc(100vw - 1.5rem - env(safe-area-inset-left) - env(safe-area-inset-right)))",
      height:
        "clamp(10rem, calc(100dvh - 6.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom)), 29.5rem)",
      borderRadius: "1.75rem",
    });
    expect(screen.getByTestId("one-location-map-tray-body")).toHaveClass(
      "min-h-0",
      "flex-1",
      "translate-y-0",
      "opacity-100",
    );
    expect(screen.getByTestId("one-location-map-tray-scroll")).toHaveClass(
      "h-full",
      "min-h-0",
      "overflow-y-auto",
      "overscroll-contain",
    );

    fireEvent.click(screen.getByTestId("one-location-map-locate"));
    await waitFor(() => {
      expect(serviceHarness.captureCurrentPosition).toHaveBeenCalledTimes(2);
      expect(mapHarness.map.setCamera).toHaveBeenCalledWith(
        expect.objectContaining({
          coordinate: { lat: 37.776, lng: -122.418 },
          zoom: 16,
          animate: true,
        }),
      );
    });
    expect(serviceHarness.updateMapPreferences).not.toHaveBeenCalled();
    expect(serviceHarness.storeEnvelope).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("one-location-map-demo-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).not.toHaveAttribute(
        "data-map-demo",
      );
    });
    fireEvent.click(screen.getByTestId("one-location-map-demo-preview"));
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-demo",
        "true",
      );
      expect(screen.getAllByTestId("one-location-map-person")).toHaveLength(3);
    });

    fireEvent.pointerUp(screen.getByTestId("one-location-map-close"), {
      pointerType: "touch",
    });
    fireEvent.click(screen.getByTestId("one-location-map-close"));
    expect(navigationHarness.beginRouteTransition).toHaveBeenCalledTimes(1);
    expect(navigationHarness.beginRouteTransition).toHaveBeenCalledWith(
      "/one/location",
      expect.any(Function),
      "tap",
      "full",
    );
    expect(navigationHarness.replace).toHaveBeenCalledTimes(1);
    expect(navigationHarness.replace).toHaveBeenCalledWith("/one/location", {
      scroll: false,
    });
  });

  it("keeps an empty people tray compact", async () => {
    experienceHarness.demoMode = false;

    render(<LocationImmersiveMap />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    expect(screen.getByText("No one sharing yet")).toBeInTheDocument();
    expect(
      screen.queryByText("0 people sharing with you"),
    ).not.toBeInTheDocument();
    // The tray states the count once. The subtitle that used to restate it,
    // the section heading, and the standalone count badge are all gone.
    expect(
      screen.queryByText("People sharing their location with you"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Live locations shared with you"),
    ).not.toBeInTheDocument();

    const trayToggle = screen.getByTestId("one-location-map-tray-toggle");
    if (trayToggle.getAttribute("aria-expanded") === "false") {
      fireEvent.click(trayToggle);
    }
    await waitFor(() => {
      expect(trayToggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("one-location-map-people-tray")).toHaveStyle({
        height:
          "min(22rem, calc(100dvh - 6.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom)))",
      });
    });
  });

  it("shows nearby attendees in the map drawer without creating peer markers", async () => {
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    experienceHarness.query = "";
    updateOneLocationControlState("test-user", (current) => ({
      ...current,
      paused: true,
    }));

    render(<LocationImmersiveMap />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    expect(screen.getByTestId("nearby-check-in-sheet-mock")).toHaveAttribute(
      "data-open",
      "false",
    );
    fireEvent.click(screen.getByTestId("one-location-map-nearby-check-in"));
    expect(navigationHarness.push).toHaveBeenCalledWith(
      "/one/location/check-in",
      { scroll: false },
    );

    fireEvent.click(screen.getByTestId("publish-nearby-state"));

    expect(readOneLocationControlState("test-user")).toEqual(
      expect.objectContaining({
        paused: false,
        nearbyPresenceActive: true,
        nearbyCheckedInAt: "2026-07-31T00:00:00.000Z",
      }),
    );

    const nearbyRoster = await screen.findByTestId(
      "one-location-map-nearby-people",
    );
    expect(nearbyRoster).not.toHaveClass(
      "bg-emerald-500/[0.08]",
      "border-emerald-500/20",
    );
    expect(nearbyRoster).not.toHaveTextContent("Checked in nearby");
    expect(screen.getByText("Neelesh Meena")).toBeInTheDocument();
    expect(screen.getByText("Aarav Shah")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(
      screen.getByText(/Within 500 m.*exact spots stay private/i),
    ).toBeInTheDocument();
    expect(JSON.stringify(mapHarness.map.addMarkers.mock.calls)).not.toContain(
      "Neelesh Meena",
    );

    fireEvent.click(screen.getByTestId("one-location-map-tray-toggle"));
    const connectButton = screen.getByRole("button", {
      name: "Connect with Aarav Shah",
    });
    expect(connectButton).toHaveClass("shrink-0");
    expect(
      screen.getByRole("button", {
        name: "Open nearby actions for Aarav Shah",
      }),
    ).toHaveClass("min-w-0", "flex-1");
    fireEvent.click(connectButton);
    await waitFor(() => {
      expect(serviceHarness.requestNearbyConnection).toHaveBeenCalledWith({
        vaultOwnerToken: "in-memory-owner-token",
        participantAlias: "rotating-aarav",
      });
    });
    expect(screen.getByText("Requested")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open nearby actions for Neelesh Meena",
      }),
    );
    expect(navigationHarness.push).toHaveBeenCalledWith(
      "/one/location/check-in",
      { scroll: false },
    );
  });

  it("renders and clears the transient 500 m check-in search circle", async () => {
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    // Check-in is its own destination now; the legacy `?action=check-in`
    // entry redirects here instead of opening over Your Map.

    render(<LocationImmersiveMap surface="check-in" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    fireEvent.click(screen.getByTestId("publish-nearby-search-area"));
    await waitFor(() => {
      expect(mapHarness.map.addCircles).toHaveBeenCalledWith([
        expect.objectContaining({
          center: { lat: 37.776, lng: -122.418 },
          radius: 500,
          clickable: false,
        }),
      ]);
    });
    expect(
      screen.getByTestId("one-location-nearby-search-area-legend"),
    ).toHaveTextContent("500 m search area");
    expect(mapHarness.map.fitBounds).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("clear-nearby-search-area"));
    await waitFor(() => {
      expect(mapHarness.map.removeCircles).toHaveBeenCalledWith(["circle-0"]);
    });
    expect(
      screen.queryByTestId("one-location-nearby-search-area-legend"),
    ).not.toBeInTheDocument();
  });

  it("never strands markers when the set changes mid-write", async () => {
    // Regression: a second "Your location" pin sat on the map where the device
    // used to be. `addMarkers` is awaited, and a run superseded during that
    // await returned without recording its ids -- so its markers stayed on the
    // map with nothing able to remove them. Every place selection and presence
    // poll changes the marker set, so this accumulated.
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    // Check-in is its own destination now; the legacy `?action=check-in`
    // entry redirects here instead of opening over Your Map.

    const added: string[][] = [];
    const removed: string[][] = [];
    let seq = 0;
    mapHarness.map.addMarkers.mockImplementation(async (markers: unknown[]) => {
      // Stall so the next render supersedes this call while it is in flight.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const ids = (markers as unknown[]).map(() => `m-${seq++}`);
      added.push(ids);
      return ids;
    });
    mapHarness.map.removeMarkers.mockImplementation(async (ids: string[]) => {
      removed.push(ids);
    });

    render(<LocationImmersiveMap surface="check-in" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    // Churn the marker set faster than addMarkers resolves.
    fireEvent.click(screen.getByTestId("publish-nearby-place-focus"));
    fireEvent.click(screen.getByTestId("clear-nearby-place-focus"));
    fireEvent.click(screen.getByTestId("publish-nearby-place-focus"));

    await waitFor(() => {
      expect(added.length).toBeGreaterThan(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const live = new Set(added.flat());
    for (const id of removed.flat()) live.delete(id);
    // Exactly one batch may remain on the map: the current one.
    expect(live.size).toBe(added.at(-1)?.length ?? 0);
  });

  it("pins the check-in place alongside the owner and names both", async () => {
    // The owner's position and the venue they check in to are routinely a
    // street apart. Showing only one of them left the map unable to say where
    // a check-in actually was.
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    // Check-in is its own destination now; the legacy `?action=check-in`
    // entry redirects here instead of opening over Your Map.

    render(<LocationImmersiveMap surface="check-in" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    fireEvent.click(screen.getByTestId("publish-nearby-search-area"));
    fireEvent.click(screen.getByTestId("publish-nearby-place-focus"));

    await waitFor(() => {
      const drawn = mapHarness.map.addMarkers.mock.calls.at(-1)?.[0] as Array<{
        coordinate: { lat: number; lng: number };
        title?: string;
        zIndex?: number;
      }>;
      // The place pin and the owner's pin are separate coordinates.
      expect(
        drawn.some(
          (marker) =>
            marker.coordinate.lat === 37.7775 &&
            marker.coordinate.lng === -122.4172,
        ),
      ).toBe(true);
      expect(
        drawn.some(
          (marker) =>
            marker.coordinate.lat === 37.776 &&
            marker.coordinate.lng === -122.418,
        ),
      ).toBe(true);
      // On web the renderer paints `title` as the pin's glyph, so a title here
      // becomes a caption smeared across the map -- a place name plus its full
      // postal address in the worst case. Titles belong to native info windows.
      expect(drawn.every((marker) => marker.title === undefined)).toBe(true);
    });

    // A connector makes the gap readable rather than leaving two loose pins.
    await waitFor(() => {
      expect(mapHarness.map.addPolylines).toHaveBeenCalledWith([
        expect.objectContaining({
          path: [
            { lat: 37.776, lng: -122.418 },
            { lat: 37.7775, lng: -122.4172 },
          ],
        }),
      ]);
    });

    const legend = screen.getByTestId("one-location-nearby-search-area-legend");
    expect(legend).toHaveTextContent("You are here");
    expect(legend).toHaveTextContent("Checking in at Hotel Two");
    expect(legend).toHaveTextContent("180 m from you");

    fireEvent.click(screen.getByTestId("clear-nearby-place-focus"));
    await waitFor(() => {
      expect(mapHarness.map.removePolylines).toHaveBeenCalledWith([
        "polyline-0",
      ]);
    });
    expect(
      screen.queryByTestId("one-location-nearby-place-legend"),
    ).not.toBeInTheDocument();
  });

  it("anchors the match circle on the place once a check-in is live", async () => {
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    // Check-in is its own destination now; the legacy `?action=check-in`
    // entry redirects here instead of opening over Your Map.
    experienceHarness.placeFocus = {
      ...experienceHarness.placeFocus,
      active: true,
    };

    render(<LocationImmersiveMap surface="check-in" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    mapHarness.map.addCircles.mockClear();
    fireEvent.click(screen.getByTestId("publish-nearby-search-area"));
    fireEvent.click(screen.getByTestId("publish-nearby-place-focus"));

    // Co-presence is matched against the place, so that is what the 500 m ring
    // has to describe -- not wherever the owner has since wandered.
    await waitFor(() => {
      expect(mapHarness.map.addCircles).toHaveBeenLastCalledWith([
        expect.objectContaining({
          center: { lat: 37.7775, lng: -122.4172 },
          radius: 500,
        }),
      ]);
    });
    expect(
      screen.getByTestId("one-location-nearby-search-area-legend"),
    ).toHaveTextContent("Checked in at Hotel Two");
  });

  it("keeps the full search circle in the visible mobile viewport above the sheet", async () => {
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    // Check-in is its own destination now; the legacy `?action=check-in`
    // entry redirects here instead of opening over Your Map.
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("max-width: 767px"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect() {
        const isCheckInSheet = this.hasAttribute(
          "data-one-location-nearby-check-in-sheet",
        );
        const isPeopleTray =
          this.getAttribute("data-testid") === "one-location-map-people-tray";
        const top = isCheckInSheet ? 280 : isPeopleTray ? 732 : 0;
        const bottom = isCheckInSheet ? 800 : isPeopleTray ? 788 : 56;
        return {
          x: 0,
          y: top,
          top,
          right: 390,
          bottom,
          left: 0,
          width: 390,
          height: bottom - top,
          toJSON: () => ({}),
        };
      },
    );

    render(<LocationImmersiveMap surface="check-in" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });
    fireEvent.click(screen.getByTestId("publish-nearby-search-area"));

    await waitFor(() => {
      expect(mapHarness.map.setPadding).toHaveBeenCalledWith(
        expect.objectContaining({
          right: 20,
          bottom: 532,
        }),
      );
      expect(mapHarness.map.fitBounds).toHaveBeenCalled();
    });
  });

  it("frames a 500 m circle correctly across the antimeridian", async () => {
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    // Check-in is its own destination now; the legacy `?action=check-in`
    // entry redirects here instead of opening over Your Map.
    experienceHarness.searchPoint = {
      ...experienceHarness.searchPoint,
      latitude: 0,
      longitude: 179.999,
    };

    render(<LocationImmersiveMap surface="check-in" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });
    fireEvent.click(screen.getByTestId("publish-nearby-search-area"));

    await waitFor(() => expect(mapHarness.map.fitBounds).toHaveBeenCalled());
    const bounds = mapHarness.map.fitBounds.mock.calls.at(-1)?.[0] as {
      value: {
        southwest: { lng: number };
        northeast: { lng: number };
        center: { lng: number };
      };
    };
    expect(bounds.value.center.lng).toBe(179.999);
    expect(bounds.value.southwest.lng).toBeGreaterThan(
      bounds.value.northeast.lng,
    );
  });

  it("serializes circle framing so a stale fit cannot win a location race", async () => {
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    // Check-in is its own destination now; the legacy `?action=check-in`
    // entry redirects here instead of opening over Your Map.
    let resolveFirstFit: (() => void) | null = null;
    mapHarness.map.fitBounds
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstFit = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    render(<LocationImmersiveMap surface="check-in" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });
    fireEvent.click(screen.getByTestId("publish-nearby-search-area"));
    await waitFor(() => expect(mapHarness.map.fitBounds).toHaveBeenCalledTimes(1));

    experienceHarness.searchPoint = {
      ...experienceHarness.searchPoint,
      latitude: 37.79,
      longitude: -122.4,
    };
    fireEvent.click(screen.getByTestId("publish-nearby-search-area"));
    expect(mapHarness.map.fitBounds).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirstFit?.());
    await waitFor(() => expect(mapHarness.map.fitBounds).toHaveBeenCalledTimes(2));
    const latestBounds = mapHarness.map.fitBounds.mock.calls.at(-1)?.[0] as {
      value: { center: { lat: number; lng: number } };
    };
    expect(latestBounds.value.center).toEqual({ lat: 37.79, lng: -122.4 });
  });

  it("sends the legacy ?action=check-in link to the check-in route", async () => {
    // The hub, breadcrumbs, notification deep links and anything already
    // shared still point at the old query. One redirect keeps them working and
    // stops the map rendering check-in over Your Map ever again.
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    experienceHarness.query = "action=check-in";

    render(<LocationImmersiveMap />);

    await waitFor(() => {
      expect(navigationHarness.replace).toHaveBeenCalledWith(
        "/one/location/check-in",
        { scroll: false },
      );
    });
  });

  it("keeps Your Map's people tray off the check-in screen", async () => {
    // The tray lists the people who already share with you -- Your Map's
    // question. Rendering it behind check-in is part of what made the two
    // screens look like one feature to QA. Both directions are asserted so a
    // wrong testid cannot make this pass vacuously.
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    experienceHarness.query = "";

    const openMap = async () => {
      // The second render below reuses the consent this test's first render
      // already gave -- accepting is now cached, so the disclosure is
      // correctly skipped on remount within the same session. Click it only
      // when it's actually there.
      const continueButton = screen.queryByRole("button", {
        name: "Continue to Your Map",
      });
      if (continueButton) fireEvent.click(continueButton);
      await waitFor(() => {
        expect(screen.getByTestId("one-location-map")).toHaveAttribute(
          "data-map-ready",
          "true",
        );
      });
    };

    const mapView = render(<LocationImmersiveMap />);
    await openMap();
    expect(screen.getByTestId("one-location-map-people-tray")).toBeTruthy();
    mapView.unmount();

    render(<LocationImmersiveMap surface="check-in" />);
    await openMap();
    expect(screen.queryByTestId("one-location-map-people-tray")).toBeNull();
  });

  // The reported bug, in both of its lives: dismissing the sheet on check-in's
  // own route navigated away -- first to the Location hub for everyone, then to
  // whichever screen a `?source=` param claimed had opened the flow. Someone who
  // has just checked in and closed the sheet is asking for the sheet to be gone,
  // not for the screen behind it to be replaced. Every entry point is covered
  // here because dismiss no longer consults where the person came from; if it
  // ever starts again, the `query: ""` case is the one that regresses first.
  const CHECK_IN_ENTRIES = [
    { name: "Your Map", query: "source=map" },
    { name: "the Location hub", query: "" },
    { name: "a legacy deep link", query: "demo=people" },
  ] as const;

  for (const entry of CHECK_IN_ENTRIES) {
    it(`closes the sheet without navigating when opened from ${entry.name}`, async () => {
      experienceHarness.demoMode = false;
      experienceHarness.nearbyAvailable = true;
      experienceHarness.query = entry.query;

      render(<LocationImmersiveMap surface="check-in" />);
      fireEvent.click(
        screen.getByRole("button", { name: "Continue to Your Map" }),
      );
      await waitFor(() => {
        expect(
          screen.getByTestId("nearby-check-in-sheet-mock"),
        ).toHaveAttribute("data-open", "true");
      });
      navigationHarness.push.mockClear();
      navigationHarness.replace.mockClear();

      fireEvent.click(screen.getByTestId("dismiss-nearby-check-in"));

      await waitFor(() => {
        expect(
          screen.getByTestId("nearby-check-in-sheet-mock"),
        ).toHaveAttribute("data-open", "false");
      });
      // The map itself is what stays behind, so nothing routes anywhere.
      expect(navigationHarness.push).not.toHaveBeenCalled();
      expect(navigationHarness.replace).not.toHaveBeenCalled();
    });
  }

  it("keeps the sheet dismissed while the route re-renders", async () => {
    // The dismissal is a ref rather than URL state, and the effect that syncs
    // the sheet to the route re-runs on every fresh `searchParams` object. If
    // that effect stops respecting the ref, the sheet springs back open a paint
    // after the person closes it.
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    experienceHarness.query = "source=map";

    const view = render(<LocationImmersiveMap surface="check-in" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("nearby-check-in-sheet-mock")).toHaveAttribute(
        "data-open",
        "true",
      );
    });

    fireEvent.click(screen.getByTestId("dismiss-nearby-check-in"));
    view.rerender(<LocationImmersiveMap surface="check-in" />);

    await waitFor(() => {
      expect(screen.getByTestId("nearby-check-in-sheet-mock")).toHaveAttribute(
        "data-open",
        "false",
      );
    });
  });

  it("re-opens check-in from the map's own pill after a dismiss", async () => {
    // Dismissing leaves the check-in map standing, so there has to be a way
    // back in from it. The pill is that way, and on this route it must toggle
    // the sheet rather than push the route it is already on.
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    experienceHarness.query = "source=map";

    render(<LocationImmersiveMap surface="check-in" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("nearby-check-in-sheet-mock")).toHaveAttribute(
        "data-open",
        "true",
      );
    });
    fireEvent.click(screen.getByTestId("dismiss-nearby-check-in"));
    await waitFor(() => {
      expect(screen.getByTestId("nearby-check-in-sheet-mock")).toHaveAttribute(
        "data-open",
        "false",
      );
    });
    navigationHarness.push.mockClear();

    fireEvent.click(screen.getByTestId("one-location-map-nearby-check-in"));

    await waitFor(() => {
      expect(screen.getByTestId("nearby-check-in-sheet-mock")).toHaveAttribute(
        "data-open",
        "true",
      );
    });
    expect(navigationHarness.push).not.toHaveBeenCalled();
  });

  it("does not build a synthetic history boundary on the check-in route", async () => {
    // The sheet used to have no URL of its own, so it faked a history entry to
    // make Back close it. A real route already is one; re-creating the boundary
    // would cost a second Back press to escape. The resume token is still
    // consumed and stripped so a refresh cannot replay it.
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    const returnToken = beginNearbyPrivateReturn();
    experienceHarness.query = `resume=${returnToken}`;
    window.history.replaceState(
      {},
      "",
      `/one/location/check-in?resume=${returnToken}`,
    );
    const pushState = vi.spyOn(window.history, "pushState");

    render(<LocationImmersiveMap surface="check-in" />);

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(pushState).not.toHaveBeenCalled();
  });

  it("shows a loading spinner on the Locate button while the position resolves", async () => {
    render(<LocationImmersiveMap />);

    const locate = await screen.findByTestId("one-location-map-locate");
    // Any mount-time capture settles first, so the control starts idle.
    await waitFor(() =>
      expect(locate).not.toHaveAttribute("aria-busy", "true"),
    );

    let resolveCapture: (() => void) | undefined;
    serviceHarness.captureCurrentPosition.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCapture = () =>
            resolve({
              latitude: 37.776,
              longitude: -122.418,
              accuracyM: 12,
              capturedAt: "2026-07-23T00:00:00.000Z",
              sourcePlatform: "ios" as const,
            });
        }),
    );

    fireEvent.click(locate);

    // Immediate feedback: the button disables, reports busy, and swaps the
    // icon for an animated spinner while the lookup is in flight.
    await waitFor(() => {
      expect(locate).toBeDisabled();
      expect(locate).toHaveAttribute("aria-busy", "true");
    });
    expect(locate.querySelector(".animate-spin")).not.toBeNull();

    await act(async () => {
      resolveCapture?.();
      await Promise.resolve();
    });

    // Resolution clears the loading state cleanly.
    await waitFor(() =>
      expect(locate).toHaveAttribute("aria-busy", "false"),
    );
    expect(locate.querySelector(".animate-spin")).toBeNull();
  });
});

/**
 * The QA report was "Your Map is blank the first time, fine after that": map
 * chrome and the people tray drawn over a blank native canvas, with no error
 * and no loading state, because the component genuinely believed it was ready.
 *
 * @capacitor/google-maps makes that reachable. `GoogleMap.create()` cannot be
 * cancelled -- it waits ~200 ms before the native view is registered, longer
 * while the container still measures zero -- and `destroy()` addresses the map
 * by its string id alone (`maps.removeValue(forKey: id)` on iOS and Android,
 * with no check that the caller is the instance that registered it).
 *
 * So any unmount inside a create window (the owner-scoped `key={userId}` on
 * both map routes, the `?action=check-in` redirect from the Location hub, a
 * quick back-and-forth between Your Map and check-in) left an abandoned create
 * running. It registered its map anyway, and its cancelled branch then
 * destroyed the id -- which by then belonged to the map the NEXT mount had
 * created.
 *
 * The stub below reproduces that by keeping the bridge's two phases apart, the
 * way the device does: `land()` is the native call arriving (registering the
 * id, honouring forceCreate), `settle()` is the JS promise resolving after it,
 * which is the only moment the component gets to react. Collapsing the two --
 * resolving creates one at a time -- hides the bug entirely.
 */
describe("LocationImmersiveMap native map lifecycle", () => {
  const NATIVE_MAP_ID = "one-location-private-map";

  type PendingCreate = {
    instance: number;
    map: Record<string, ReturnType<typeof vi.fn>>;
    land: () => void;
    settle: () => void;
    settled: boolean;
  };

  function stubNativeBridge() {
    // Whatever native currently holds the id, exactly one entry deep.
    const registry = new Map<string, number>();
    const events: string[] = [];
    const pending: PendingCreate[] = [];
    let instances = 0;

    mapHarness.create.mockImplementation((options: { id: string }) => {
      const instance = ++instances;
      events.push(`create:${instance}`);
      const map = {
        ...mapHarness.map,
        destroy: vi.fn(async () => {
          // `destroy()` awaits its listener teardown before the native call
          // lands, so a destroy fired alongside a create does not win the
          // race by virtue of being called first.
          await Promise.resolve();
          await Promise.resolve();
          // Keyed by id, never by identity -- the native contract.
          registry.delete(options.id);
          events.push(`destroyed:${instance}`);
        }),
      };
      const entry: PendingCreate = {
        instance,
        map,
        settled: false,
        land: () => {
          // forceCreate: true -- a later create tears down whatever holds the
          // id before taking it.
          registry.set(options.id, instance);
        },
        settle: () => undefined,
      };
      pending.push(entry);
      return new Promise((resolve) => {
        entry.settle = () => {
          entry.settled = true;
          resolve(map);
        };
      });
    });

    /**
     * Advance the bridge until nothing is outstanding. Within a round every
     * outstanding native call lands before any JS promise settles, which is
     * the real interleaving: the plugin's 200 ms create timers fire close
     * together, while a destroy only reaches native after `destroy()` has
     * awaited its listener teardown.
     */
    async function pump() {
      for (let round = 0; round < 8; round += 1) {
        // Let effects run and the lock hand over first: with creates
        // serialized, `GoogleMap.create` is invoked a microtask after the
        // effect, so reading `pending` straight after render sees nothing.
        await act(async () => {
          for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
        });
        const outstanding = pending.filter((entry) => !entry.settled);
        if (outstanding.length === 0) return;
        await act(async () => {
          for (const entry of outstanding) entry.land();
          for (const entry of outstanding) entry.settle();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
      }
    }

    return { registry, events, pending, pump };
  }

  it("keeps a live native map when a mount is superseded mid-create", async () => {
    const { registry, pending, pump } = stubNativeBridge();

    const first = render(<LocationImmersiveMap />);
    await waitFor(() => expect(mapHarness.create).toHaveBeenCalledTimes(1));

    // Unmount while create() is still in flight, then mount again: the exact
    // window nothing can call the plugin back out of.
    first.unmount();
    render(<LocationImmersiveMap />);

    await pump();

    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    // The screen says it is ready, so a native map has to actually be
    // registered under this id. Blank-first-view was this expectation failing
    // while every other assertion on the screen still passed.
    expect(registry.has(NATIVE_MAP_ID)).toBe(true);
    const live = registry.get(NATIVE_MAP_ID);
    const owner = pending.find((entry) => entry.instance === live);
    expect(owner?.map.destroy).not.toHaveBeenCalled();
  });

  it("finishes destroying the outgoing map before creating the next one", async () => {
    const { events, pump } = stubNativeBridge();

    const first = render(<LocationImmersiveMap />);
    await pump();
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    first.unmount();
    render(<LocationImmersiveMap />);
    await pump();

    // Teardown has to *complete* before the next create is issued. Firing the
    // destroy and the create back to back leaves them interleaving on one id,
    // which is how a live map got torn down behind a ready screen.
    expect(events).toEqual([
      "create:1",
      "destroyed:1",
      "create:2",
    ]);
  });
});

/**
 * Time-to-map is a latency budget, not a feeling. These cases pin the cost of
 * opening Your Map in bridge round-trips and scheduler turns so a regression
 * shows up here rather than in someone's hand on a device.
 */
describe("LocationImmersiveMap open latency", () => {
  it("issues the native create without waiting on any timer", async () => {
    render(<LocationImmersiveMap />);

    // Drain microtasks only -- never advance a timer. Reaching the bridge here
    // proves nothing on the open path is gated on a scheduled delay: not the
    // layout wait, which short-circuits on an already-measured container, and
    // not the lane, which is free. A regression that puts either behind a
    // timer fails right here rather than showing up as a slow map on a device.
    await act(async () => {
      for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
    });
    expect(mapHarness.create).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    // One native create per open. A second would mean the map is built twice
    // on the way in -- the cost the serialization exists to avoid, not add.
    expect(mapHarness.create).toHaveBeenCalledTimes(1);
    expect(mapHarness.map.destroy).not.toHaveBeenCalled();
  });

  it("costs the live map one teardown, not an unbounded wait, when a mount is superseded", async () => {
    const first = render(<LocationImmersiveMap />);
    await waitFor(() => expect(mapHarness.create).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<LocationImmersiveMap />);
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    // Exactly two creates and one destroy: the outgoing map is torn down once
    // and the incoming one is built once. Serializing must not turn a remount
    // into a retry loop.
    expect(mapHarness.create).toHaveBeenCalledTimes(2);
    expect(mapHarness.map.destroy).toHaveBeenCalledTimes(1);
  });

  it("still opens after a create fails, instead of hanging behind it", async () => {
    // A poisoned lane would leave every later open on a spinner that never
    // resolves -- a worse outcome than the blank map this all started with.
    mapHarness.create.mockRejectedValueOnce(new Error("bridge unavailable"));

    const failed = render(<LocationImmersiveMap />);
    await waitFor(() => {
      expect(
        screen.getByTestId("one-location-map"),
      ).toHaveAttribute("data-map-ready", "false");
    });
    failed.unmount();

    render(<LocationImmersiveMap />);
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });
  });
});

/**
 * The paths that actually put a second mount inside a create window. Each one
 * is ordinary navigation, not an edge case, which is why the blank map was
 * reproducible enough for QA to file it.
 */
describe("LocationImmersiveMap remount triggers", () => {
  it("survives the owner-scoped remount both map routes perform", async () => {
    // /one/location/map and /one/location/check-in both render this component
    // under key={auth.userId ?? "anonymous"}. When the owner id arrives the key
    // changes, React throws the mount away and builds a fresh one -- straight
    // through an in-flight create.
    const first = render(<LocationImmersiveMap key="anonymous" />);
    await waitFor(() => expect(mapHarness.create).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<LocationImmersiveMap key="test-user" />);
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });
    expect(mapHarness.map.destroy).toHaveBeenCalledTimes(1);
  });

  it("redirects the legacy check-in entry point off the map route", async () => {
    // The Location hub still pushes /one/location/map?action=check-in, and the
    // map route bounces it to the check-in route. That bounce is a second
    // mount of this same component on the same native map id.
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    experienceHarness.query = "action=check-in";

    render(<LocationImmersiveMap />);

    await waitFor(() => {
      expect(navigationHarness.replace).toHaveBeenCalledWith(
        "/one/location/check-in",
        { scroll: false },
      );
    });
  });

  it("leaves a usable map behind when check-in is opened and dismissed", async () => {
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    experienceHarness.query = "";

    render(<LocationImmersiveMap surface="check-in" />);
    // Renderer consent gates the sheet and the marker refresh alike.
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Your Map" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    fireEvent.click(screen.getByTestId("dismiss-nearby-check-in"));

    // Dismissing the sheet is not leaving the screen: the map underneath has
    // to still be there, and still be the one this mount created.
    await waitFor(() => {
      expect(screen.getByTestId("nearby-check-in-sheet-mock")).toHaveAttribute(
        "data-open",
        "false",
      );
    });
    expect(screen.getByTestId("one-location-map")).toHaveAttribute(
      "data-map-ready",
      "true",
    );
    expect(mapHarness.map.destroy).not.toHaveBeenCalled();
  });
});
