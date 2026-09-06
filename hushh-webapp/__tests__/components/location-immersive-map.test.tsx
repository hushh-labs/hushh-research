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
  type CameraListener = (data: unknown) => void;
  // The renderer is the only thing that knows what the camera is showing, and
  // the HTML name pills are positioned from it. Holding the callbacks lets a
  // case drive a real camera report instead of faking the layer's own maths.
  const listeners: {
    boundsChanged?: CameraListener;
    cameraIdle?: CameraListener;
    cameraMoveStarted?: CameraListener;
  } = {};
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
    setOnBoundsChangedListener: vi.fn(async (_callback: CameraListener) => {}),
    setOnCameraIdleListener: vi.fn(async (_callback: CameraListener) => {}),
    setOnCameraMoveStartedListener: vi.fn(
      async (_callback: CameraListener) => {},
    ),
    setPadding: vi.fn(async () => undefined),
  };
  // Re-installed per case: afterEach clears every implementation on this map.
  const resetCameraListeners = () => {
    listeners.boundsChanged = undefined;
    listeners.cameraIdle = undefined;
    listeners.cameraMoveStarted = undefined;
    map.setOnBoundsChangedListener.mockImplementation(async (callback) => {
      listeners.boundsChanged = callback;
    });
    map.setOnCameraIdleListener.mockImplementation(async (callback) => {
      listeners.cameraIdle = callback;
    });
    map.setOnCameraMoveStartedListener.mockImplementation(async (callback) => {
      listeners.cameraMoveStarted = callback;
    });
  };
  return {
    map,
    listeners,
    resetCameraListeners,
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

// The owner's own identity, as the app already holds it. Mutable so a case can
// take the photo away and assert the fallback the rest of the product uses.
const identityHarness = vi.hoisted(() => ({
  displayName: "Ankit Kumar Singh" as string | null,
  avatarUrl: "https://avatars.test/ankit.jpg" as string | null,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: "test-user",
    user: { uid: "test-user", displayName: identityHarness.displayName },
  }),
  useRequireAuth: () => ({
    userId: "test-user",
    user: { uid: "test-user", displayName: identityHarness.displayName },
  }),
}));

vi.mock("@/hooks/use-effective-avatar-url", () => ({
  useEffectiveAvatarUrl: () => identityHarness.avatarUrl,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "in-memory-owner-token" }),
}));

// Mutable so a case can assert the NATIVE branch. `setPadding` is a real
// camera inset on iOS/Android but a zoom-out on the @capacitor/google-maps web
// shim, so the two runtimes have genuinely different contracts here and both
// need covering.
const platformHarness = vi.hoisted(() => ({ native: false }));

vi.mock("@/lib/capacitor/platform", () => ({
  getPlatform: () => (platformHarness.native ? "ios" : "web"),
  isNative: () => platformHarness.native,
}));

// Mutable so a case can assert the build-has-no-Maps-key state, which is the
// one that reaches the map's unavailable placeholder.
const mapsKeyHarness = vi.hoisted(() => ({ present: true }));

vi.mock("@/lib/one-location/maps-config", () => ({
  getBrowserMapsApiKey: () =>
    mapsKeyHarness.present ? "browser-test-key" : "",
  getNativeMapsApiKey: () => (mapsKeyHarness.present ? "native-test-key" : ""),
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

// Only reached by cases that put real (non-demo) markers on the map. Every
// other case leaves `getMapState` returning no markers, so this never runs for
// them.
vi.mock("@/lib/one-location/encryption", () => ({
  decryptLocationEnvelope: vi.fn(
    async ({ envelope }: { envelope: { plainPointForTest: unknown } }) =>
      envelope.plainPointForTest,
  ),
  encryptLocationForRecipient: vi.fn(async () => ({
    id: "envelope-id",
    capturedAt: "2026-07-23T00:00:00.000Z",
  })),
}));

import { toast } from "sonner";

import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";
import {
  MAP_CONSENT_PANEL_BOTTOM_PADDING,
  MAP_CONSENT_PANEL_CLASSNAME,
  MAP_CONSENT_SUPPORTING_LINE,
  MAP_CONSENT_TITLE,
} from "@/components/one-location/map-consent-panel-layout";
import {
  MAP_NEUTRAL_WORLD_LATITUDE,
  neutralWorldCamera,
  outOfWorldBandPx,
} from "@/lib/one-location/map-world-view";
import { beginNearbyPrivateReturn } from "@/lib/one-location/nearby-private-navigation";
import {
  forgetOneLocationControlPreference,
  readOneLocationControlState,
  updateOneLocationControlState,
} from "@/lib/one-location/location-control-state";
import { forgetCachedRendererConsent } from "@/lib/one-location/map-renderer-consent";
import { __resetNativeMapLifecycleForTests } from "@/lib/one-location/native-map-lifecycle";

const DEFAULT_PLACE_FOCUS = { ...experienceHarness.placeFocus };

// jsdom never lays out elements, so the tray's content-measurement effect
// (offsetHeight) would always read 0. Stub a representative expanded-header
// height and a representative populated-tray body height by default;
// individual tests override the body height to prove the sheet's height
// tracks whatever content is actually rendered. The header is a <button>
// and the body a <div>, which is all the stub needs to tell them apart.
let trayHeaderHeightStub = 72;
let trayContentHeightStub = 260;
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    return this.tagName === "BUTTON"
      ? trayHeaderHeightStub
      : trayContentHeightStub;
  },
});

beforeEach(() => {
  platformHarness.native = false;
  mapsKeyHarness.present = true;
  identityHarness.displayName = "Ankit Kumar Singh";
  identityHarness.avatarUrl = "https://avatars.test/ankit.jpg";
  trayHeaderHeightStub = 72;
  trayContentHeightStub = 260;
  mapHarness.resetCameraListeners();
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
  // Radix's Avatar decides whether to show the photo or the fallback by
  // preloading `new window.Image()` and waiting for `onload`. jsdom never
  // fires it, so without this every avatar in every case renders as its
  // fallback and a photo assertion could not fail. Resolving it here is what
  // makes the photo/initials branch testable at all.
  class ImageStub {
    #listeners = new Map<string, Set<() => void>>();
    #src = "";
    referrerPolicy = "";
    crossOrigin: string | null = null;
    addEventListener(type: string, handler: () => void) {
      const set = this.#listeners.get(type) ?? new Set();
      set.add(handler);
      this.#listeners.set(type, set);
    }
    removeEventListener(type: string, handler: () => void) {
      this.#listeners.get(type)?.delete(handler);
    }
    get src() {
      return this.#src;
    }
    set src(value: string) {
      this.#src = value;
      queueMicrotask(() => {
        for (const handler of this.#listeners.get(value ? "load" : "error") ??
          []) {
          handler();
        }
      });
    }
  }
  vi.stubGlobal("Image", ImageStub);
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
  it("anchors the consent panel to the bottom edge on a phone and centres it as a dialog on desktop", () => {
    experienceHarness.demoMode = false;

    render(<LocationImmersiveMap />);

    // Asserted against the shared class string, so the component and
    // `e2e/one-location-map-consent-panel.layout.spec.ts` cannot drift apart.
    // JSDOM proves the classes are rendered; only the browser spec proves what
    // they do.
    expect(screen.getByTestId("one-location-map-disclosure")).toHaveClass(
      ...MAP_CONSENT_PANEL_CLASSNAME.split(" "),
    );
    // The panel touches the bottom edge, so the inset that used to be a gap
    // beneath a floating card is now padding under the primary action.
    expect(screen.getByTestId("one-location-map-disclosure")).toHaveStyle({
      paddingBottom: MAP_CONSENT_PANEL_BOTTOM_PADDING,
    });
  });

  it("says the map is unavailable instead of asking for consent to a renderer that cannot start", async () => {
    // The state that had nothing in it: no Maps key AND consent not yet given.
    // The loading overlay bails on `unavailable` and the fallback used to wait
    // for consent, so neither drew -- a blank canvas with a Continue button
    // floating on it.
    experienceHarness.demoMode = false;
    mapsKeyHarness.present = false;

    render(<LocationImmersiveMap />);

    await waitFor(() => {
      expect(screen.getByText("Maps isn't available")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Nothing is wrong with your location."),
    ).toBeInTheDocument();
    // No decision to make, so nothing asks for one.
    expect(
      screen.queryByTestId("one-location-map-disclosure"),
    ).not.toBeInTheDocument();
    // And the screen is still usable: the way out is still there.
    expect(
      screen.getByTestId("one-location-map-close"),
    ).toBeInTheDocument();
  });

  it("says the title and one short line, and nothing about how the renderer is fed", () => {
    experienceHarness.demoMode = false;

    render(<LocationImmersiveMap />);

    const panel = screen.getByTestId("one-location-map-disclosure");
    expect(
      screen.getByRole("heading", { name: MAP_CONSENT_TITLE }),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent(MAP_CONSENT_SUPPORTING_LINE);

    // The three-sentence paragraph this replaced. Two of its claims were
    // architecture the person cannot act on; the third belongs to Nearby
    // Check-In and is still stated on Location Settings, which is the surface
    // that actually turns Check-In on.
    expect(panel).not.toHaveTextContent(/Google Maps/i);
    expect(panel).not.toHaveTextContent(/Nearby Check-In/i);
    expect(panel).not.toHaveTextContent(/on this device/i);

    // Consent itself is unchanged: this is still the gate, and Continue is
    // still the only thing that writes the renderer consent version.
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
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
    // The Everyone pill is now the incoming row: same control, same test
    // id, a name that says what it frames instead of naming a mode that
    // sat beside Ghost and read as its alternative. Demo puts three people
    // on the map, and narrowing the search must not change that count --
    // the row counts who shares with you, not who survived the filter.
    const framingRows = screen.getAllByTestId(
      "one-location-map-show-everyone",
    );
    expect(framingRows).toHaveLength(1);
    expect(framingRows[0]).toHaveAccessibleName(
      "3 people sharing with you. Fit them all on the map.",
    );
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
        "clamp(56px, 334px, min(29.5rem, calc(100dvh - 6.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))))",
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
  }, 15000);

  it("keeps an empty people tray compact", async () => {
    experienceHarness.demoMode = false;
    // Only the search box and the button grid render with nothing to
    // share and no one nearby -- a short, real content height, not the
    // populated-tray stand-in the other cases use.
    trayContentHeightStub = 96;

    render(<LocationImmersiveMap />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    // Named audience. The header used to read "No one sharing yet" over a
    // subtitle reading "Sharing with 1", which is two true statements about
    // two different audiences stacked as though they were one.
    expect(screen.getByText("No one sharing yet")).toBeInTheDocument();
    // The row below the header is where the audience is named in full.
    expect(
      screen.getByText("No one is sharing their location"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("0 people sharing with you"),
    ).not.toBeInTheDocument();
    // The tray states the count once. The subtitle that used to restate it,
    // the section heading, and the standalone count badge are all gone.
    expect(
      screen.queryByText("People sharing location with you"),
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
          "clamp(56px, 170px, min(29.5rem, calc(100dvh - 6.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))))",
      });
      // Shorter content, shorter sheet -- not the fixed viewport-derived
      // allowance the populated-tray case reaches for.
      expect(
        screen.getByTestId("one-location-map-people-tray"),
      ).not.toHaveStyle({ height: "334px" });
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
      screen.getByRole("button", { name: "Continue" }),
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
      screen.getByRole("button", { name: "Continue" }),
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
    ).toHaveTextContent("500 m around you");
    expect(mapHarness.map.fitBounds).toHaveBeenCalled();

    // The overlay is handed a colour a map can actually paint.
    //
    // Neither renderer resolves CSS custom properties. The web shim passes the
    // string straight to `new google.maps.Circle`, which falls back to its own
    // defaults on anything unparseable — a black ring over a heavy grey disc,
    // which is exactly what shipped — and the iOS plugin does
    // `UIColor(hex:) ?? .blue`. So `"var(--app-accent)"` never once drew in the
    // app's accent, and no `fillOpacity` asked for here reached the fill that
    // was really produced.
    const [[[drawnCircle]]] = mapHarness.map.addCircles.mock.calls as Array<
      [Array<Record<string, unknown>>]
    >;
    for (const key of ["fillColor", "strokeColor"] as const) {
      expect(String(drawnCircle[key])).not.toContain("var(");
      expect(String(drawnCircle[key])).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
    // And it stays subordinate to the map it describes: the radius is a
    // background fact, the two pins inside it are the subject.
    expect(Number(drawnCircle.fillOpacity)).toBeLessThanOrEqual(0.08);
    expect(Number(drawnCircle.strokeOpacity)).toBeLessThanOrEqual(0.4);
    expect(Number(drawnCircle.strokeWeight)).toBeLessThanOrEqual(2);

    fireEvent.click(screen.getByTestId("clear-nearby-search-area"));
    await waitFor(() => {
      expect(mapHarness.map.removeCircles).toHaveBeenCalledWith(["circle-0"]);
    });
    expect(
      screen.queryByTestId("one-location-nearby-search-area-legend"),
    ).not.toBeInTheDocument();
  });

  it("never sends camera padding to the web map renderer", async () => {
    // Regression, QA "uppr gap kyu aa raha hai": on iOS/Android `setPadding` is
    // a true camera inset — same zoom, map still edge to edge. The
    // @capacitor/google-maps WEB shim is `fitBounds(map.getBounds(), padding)`,
    // i.e. it re-fits the visible world into a box shrunk by the padding. That
    // is a zoom-out, and a raster map snaps to a whole integer zoom, so the
    // world stopped filling the container and Google's out-of-world grey showed
    // as a band above and below the map. Web must never make this call.
    platformHarness.native = false;
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;

    render(<LocationImmersiveMap surface="check-in" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    fireEvent.click(screen.getByTestId("publish-nearby-search-area"));
    await waitFor(() => {
      expect(mapHarness.map.addCircles).toHaveBeenCalled();
    });

    expect(mapHarness.map.setPadding).not.toHaveBeenCalled();
    // The container itself is untouched by the fix and still owns the viewport.
    expect(screen.getByTestId("one-location-map").className).toContain(
      "h-[100dvh]",
    );
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
      screen.getByRole("button", { name: "Continue" }),
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
      screen.getByRole("button", { name: "Continue" }),
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
      screen.getByRole("button", { name: "Continue" }),
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
    // Camera padding is a NATIVE-only bridge call, so this case runs native.
    platformHarness.native = true;
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
      screen.getByRole("button", { name: "Continue" }),
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
      screen.getByRole("button", { name: "Continue" }),
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
      screen.getByRole("button", { name: "Continue" }),
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
        name: "Continue",
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
        screen.getByRole("button", { name: "Continue" }),
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
      screen.getByRole("button", { name: "Continue" }),
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
      screen.getByRole("button", { name: "Continue" }),
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

  it("keeps the dedicated Check in header controls and active-share meaning", async () => {
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    experienceHarness.query = "source=map";
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [
        {
          id: "active-location-share",
          ownerUserId: "test-user",
          recipientUserId: "trusted-person",
          recipientDisplayName: "Ankit Kumar Singh",
          recipientKeyId: "trusted-person-key",
          status: "active",
          consentScope: "location",
          capabilityScopes: ["location.read"],
          durationHours: 1,
        },
      ],
    });

    render(<LocationImmersiveMap surface="check-in" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });

    const header = screen.getByRole("banner", {
      name: "Check in map controls",
    });
    expect(header).toContainElement(
      screen.getByTestId("one-location-map-close"),
    );
    expect(screen.getByTestId("one-location-map-close")).toHaveAccessibleName(
      "Back to Location",
    );
    // Check-in's own route opens the sheet on arrival, and while it is open
    // the pill is the one control on screen with nothing to do -- its whole
    // job is getting back INTO the sheet. Dismiss first, then it is here.
    expect(
      screen.queryByTestId("one-location-map-nearby-check-in"),
    ).toBeNull();
    fireEvent.click(screen.getByTestId("dismiss-nearby-check-in"));
    expect(
      screen.getByTestId("one-location-map-nearby-check-in"),
    ).toHaveAccessibleName("Check in nearby");

    expect(screen.getByTestId("one-location-map-locate")).toHaveAccessibleName(
      "Show my location",
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("one-location-map-sharing-status"),
      ).toHaveTextContent("Sharing with 1");
    });
    expect(
      screen.getByTestId("one-location-map-sharing-status"),
    ).toHaveAttribute("type", "button");
    expect(
      screen.getByTestId("one-location-map-sharing-status"),
    ).toHaveAccessibleName(
      "Show who you are sharing your location with. 1 person.",
    );

    fireEvent.click(screen.getByTestId("one-location-map-sharing-status"));

    expect(
      screen.getByRole("list", { name: "People you are sharing with" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ankit Kumar Singh")).toBeInTheDocument();

    fireEvent.scroll(window);

    await waitFor(() => {
      expect(screen.queryByText("Ankit Kumar Singh")).not.toBeInTheDocument();
    });
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

  it("recovers from a failed renderer through its own Try again control, without remounting the screen", async () => {
    // Issue #5921: this placeholder used to say "try again" with nothing on
    // screen that actually did it -- the only way out was Back, then in
    // again. A renderer failure is transient (network, a bad create call),
    // unlike a missing Maps key, so it is the one unavailable reason worth
    // retrying in place.
    mapHarness.create.mockRejectedValueOnce(new Error("bridge unavailable"));

    render(<LocationImmersiveMap />);
    await waitFor(() => {
      expect(screen.getByText("The map could not start")).toBeInTheDocument();
    });
    const retry = screen.getByTestId("one-location-map-unavailable-retry");
    expect(retry).toHaveTextContent("Try again");

    fireEvent.click(retry);

    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });
    expect(
      screen.queryByText("The map could not start"),
    ).not.toBeInTheDocument();
    expect(mapHarness.create).toHaveBeenCalledTimes(2);
  });

  it("offers no Try again for a missing Maps key, since retrying cannot fix a build-time config gap", async () => {
    mapsKeyHarness.present = false;

    render(<LocationImmersiveMap />);
    await waitFor(() => {
      expect(screen.getByText("Maps isn't available")).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("one-location-map-unavailable-retry"),
    ).not.toBeInTheDocument();
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
    // Nothing inside the app sends check-in here any more -- the hub, the
    // breadcrumb back button and the resume href all name the check-in route
    // directly. What is left arriving on `?action=check-in` is links we do not
    // own: notifications, bookmarks, anything already shared. They still work,
    // at the cost of this one bounce.
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
      screen.getByRole("button", { name: "Continue" }),
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

/**
 * The five things QA reported on the shipped Location map, each locked by the
 * behaviour a person actually performs. They are grouped because they share one
 * root: a control that is visible but cannot answer is indistinguishable from a
 * broken one, and every one of these was reported as "it is not working".
 */
describe("LocationImmersiveMap reported map defects", () => {
  const ANKIT = "Ankit Kumar Singh";
  const ABDUL = "Abdul Rashid";

  function activeGrant(recipientDisplayName: string, id: string) {
    return {
      id,
      ownerUserId: "test-user",
      recipientUserId: `${id}-recipient`,
      recipientDisplayName,
      recipientKeyId: `${id}-key`,
      status: "active",
      consentScope: "location",
      capabilityScopes: ["location.read"],
      durationHours: 1,
    };
  }

  /** An incoming pin: someone who shares location back with this account. */
  function incomingMarker(ownerDisplayName: string, lat: number, lng: number) {
    return {
      grant: { id: `${ownerDisplayName}-incoming`, ownerDisplayName },
      envelope: {
        id: `${ownerDisplayName}-envelope`,
        capturedAt: "2026-07-23T00:00:00.000Z",
        plainPointForTest: {
          latitude: lat,
          longitude: lng,
          capturedAt: "2026-07-23T00:00:00.000Z",
          sourcePlatform: "ios",
        },
      },
    };
  }

  async function renderReadyMap(props: { surface?: "map" | "check-in" } = {}) {
    render(<LocationImmersiveMap {...props} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-ready",
        "true",
      );
    });
  }

  beforeEach(() => {
    experienceHarness.demoMode = false;
    experienceHarness.nearbyAvailable = true;
    experienceHarness.query = "source=map";
  });

  it("sends a private share to the person it was written for while Ghost Mode is on", async () => {
    /**
     * The reported defect, from the sharer's end.
     *
     * "Ankit is sharing his location privately with me but i can not see him
     * on my map." Ankit's grant was live, his recipient key was on file, and
     * this screen refused to publish an envelope because his `presenceMode`
     * was "ghost" -- which is the DEFAULT, not something he had chosen. So
     * private sharing quietly did nothing for anyone who had never opened a
     * toggle they had no reason to know existed.
     *
     * A private grant is written for one named person, encrypted to their key,
     * for a duration its owner picked. That IS the decision to be seen by
     * them. Ghost Mode governs the general audience and stops there.
     */
    serviceHarness.getState.mockResolvedValue({
      recipients: [
        {
          userId: "share-ankit-recipient",
          keyId: "share-ankit-key",
          publicKeyJwk: { kty: "EC" },
        },
      ],
      ownerGrants: [activeGrant(ANKIT, "share-ankit")],
    });
    serviceHarness.getMapState.mockResolvedValue({
      markers: [],
      preferences: { presenceMode: "ghost" },
    });

    await renderReadyMap();

    serviceHarness.storeEnvelope.mockClear();
    fireEvent.click(screen.getByTestId("one-location-map-locate"));

    await waitFor(() => {
      expect(serviceHarness.storeEnvelope).toHaveBeenCalledTimes(1);
    });
    const [call] = serviceHarness.storeEnvelope.mock.calls;
    expect(call[0].grantId).toBe("share-ankit");
    // And it is published as map-visible: the recipient's map is the surface
    // this whole path exists to reach.
    expect(call[0].envelope.publicationContext).toBe("foreground_map_visible");
    // Not the old "Ghost Mode is on. Only you can see this." dead end.
    expect(toast.success).toHaveBeenCalledWith(
      "Sent to the people you share with.",
    );
  });

  it("says so instead of claiming a send when Ghost is on and there is nobody to send to", async () => {
    // The other half of removing the early return: with no grants there is
    // genuinely nothing to publish, and "Sent to the people you share with"
    // would be a lie. This is also the one state where Ghost Mode is the
    // relevant fact, because the general audience is all that is left.
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [],
    });
    serviceHarness.getMapState.mockResolvedValue({
      markers: [],
      preferences: { presenceMode: "ghost" },
    });

    await renderReadyMap();

    serviceHarness.storeEnvelope.mockClear();
    vi.mocked(toast.message).mockClear();
    fireEvent.click(screen.getByTestId("one-location-map-locate"));

    await waitFor(() => {
      expect(toast.message).toHaveBeenCalledWith(
        "Ghost Mode is on, and you aren't sharing with anyone yet.",
      );
    });
    expect(serviceHarness.storeEnvelope).not.toHaveBeenCalled();
  });

  it("shows the two audiences and the Ghost switch as three separate controls", async () => {
    /**
     * "This interface gives an illusion of a check-in page and creates a
     * little bit of confusion."
     *
     * It did. The only filled full-width control said "Check in", and above it
     * sat "Ghost | Everyone" as two equal pills -- the shape UI uses for
     * "these are alternatives" -- when one writes a stored visibility
     * preference and the other moves the camera. Three facts about three
     * audiences now get three labelled rows, and check-in is a secondary
     * action because it is a separate one-time share.
     */
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [
        activeGrant(ANKIT, "share-ankit"),
        activeGrant(ABDUL, "share-abdul"),
      ],
    });
    serviceHarness.getMapState.mockResolvedValue({
      markers: [
        incomingMarker(ANKIT, 25.4358, 81.8463),
        incomingMarker(ABDUL, 25.4501, 81.8201),
        incomingMarker("Priya Nair", 25.46, 81.83),
      ],
      preferences: { presenceMode: "ghost" },
    });

    await renderReadyMap();

    // Incoming, outgoing, Ghost -- named, and each saying which audience it is
    // about rather than leaving the reader to infer it from pin count.
    expect(
      await screen.findByText("3 people sharing with you"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Private sharing with 2 people"),
    ).toBeInTheDocument();

    const ghost = screen.getByTestId("one-location-map-ghost-toggle");
    expect(ghost).toHaveAttribute("role", "switch");
    expect(ghost).toHaveAttribute("data-state", "checked");
    // The switch is the whole control now: a name and an on/off state, with
    // no paragraph under it restating what the two rows above already say.
    expect(
      screen.getByTestId("one-location-map-ghost"),
    ).toHaveTextContent(/^Ghost Mode$/);

    // Check-in is still here and still one tap away -- it is just no longer
    // the loudest thing on a sheet that is not about it.
    const checkIn = screen.getByTestId("one-location-map-nearby-check-in");
    expect(checkIn).toBeInTheDocument();
    expect(checkIn.className).toContain("h-11");
    expect(checkIn.className).not.toContain("w-full");
  });

  it("never lets the viewer's own Ghost Mode empty their map", async () => {
    // The incoming row counts grants where this account is the RECIPIENT. Its
    // own presence preference has nothing to do with them, and the empty-state
    // line says so, because "I turned on Ghost and my map went blank" is the
    // confusion the old Ghost/Everyone pair invited.
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [],
    });
    serviceHarness.getMapState.mockResolvedValue({
      markers: [incomingMarker(ANKIT, 25.4358, 81.8463)],
      preferences: { presenceMode: "ghost" },
    });

    await renderReadyMap();

    expect(
      await screen.findByText("1 person sharing with you"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("one-location-map")).toHaveAttribute(
      "data-map-marker-count",
      "1",
    );
  });

  it("expands the private shares in the sheet rather than over the map", async () => {
    // The header chip's popover opens over the map, which is the wrong place
    // to answer a question asked from a row at the bottom of the sheet.
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [activeGrant(ANKIT, "share-ankit")],
    });

    await renderReadyMap();

    const row = await screen.findByTestId("one-location-map-private-shares");
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByTestId("one-location-map-private-share-person"),
    ).not.toBeInTheDocument();

    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-expanded", "true");
    const person = screen.getByTestId("one-location-map-private-share-person");
    expect(person).toHaveAccessibleName(
      `Manage your location share with ${ANKIT}`,
    );
  });

  it("takes you to a person on the map when you tap their name in Sharing with", async () => {
    // The reported flow: tap "Sharing with 2", see the people, tap one. The
    // rows used to be inert <li> text, so the tap answered nothing.
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [activeGrant(ANKIT, "share-ankit")],
    });
    serviceHarness.getMapState.mockResolvedValue({
      // Mutual: Ankit both receives this account's location and shares back, so
      // he has a pin to fly to.
      markers: [incomingMarker(ANKIT, 25.4358, 81.8463)],
      preferences: { presenceMode: "ghost" },
    });

    await renderReadyMap();

    await waitFor(() => {
      expect(
        screen.getByTestId("one-location-map-sharing-status"),
      ).toHaveTextContent("Sharing with 1");
    });
    fireEvent.click(screen.getByTestId("one-location-map-sharing-status"));

    const row = await screen.findByTestId("one-location-map-sharing-person");
    // A real control, not decorated text.
    expect(row.tagName).toBe("BUTTON");
    expect(row).toHaveAttribute("data-has-pin", "true");
    expect(row).toHaveAccessibleName(`Show ${ANKIT} on your map`);

    mapHarness.map.setCamera.mockClear();
    fireEvent.click(row);

    await waitFor(() => {
      expect(mapHarness.map.setCamera).toHaveBeenCalledWith(
        expect.objectContaining({
          coordinate: { lat: 25.4358, lng: 81.8463 },
        }),
      );
    });
  });

  it("sends you to Location to manage a share when that person has no pin", async () => {
    // Sharing with someone does not put them on your map -- that only happens
    // if they share back. Tapping the row still has to go somewhere, or it is
    // the same dead control in a different place.
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [activeGrant(ABDUL, "share-abdul")],
    });
    serviceHarness.getMapState.mockResolvedValue({
      markers: [],
      preferences: { presenceMode: "ghost" },
    });

    await renderReadyMap();

    await waitFor(() => {
      expect(
        screen.getByTestId("one-location-map-sharing-status"),
      ).toHaveTextContent("Sharing with 1");
    });
    fireEvent.click(screen.getByTestId("one-location-map-sharing-status"));

    const row = await screen.findByTestId("one-location-map-sharing-person");
    expect(row).toHaveAttribute("data-has-pin", "false");
    expect(row).toHaveAccessibleName(
      `Manage your location share with ${ABDUL}`,
    );

    navigationHarness.beginRouteTransition.mockClear();
    fireEvent.click(row);

    await waitFor(() => {
      expect(navigationHarness.beginRouteTransition).toHaveBeenCalledWith(
        "/one/location",
        expect.any(Function),
        "tap",
        "full",
      );
    });
  });

  it("gives every Sharing with row a 44px touch target", async () => {
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [
        activeGrant(ANKIT, "share-ankit"),
        activeGrant(ABDUL, "share-abdul"),
      ],
    });

    await renderReadyMap();

    await waitFor(() => {
      expect(
        screen.getByTestId("one-location-map-sharing-status"),
      ).toHaveTextContent("Sharing with 2");
    });
    fireEvent.click(screen.getByTestId("one-location-map-sharing-status"));

    const rows = await screen.findAllByTestId(
      "one-location-map-sharing-person",
    );
    expect(rows).toHaveLength(2);
    // min-h-11 is 44px, the platform minimum. Below it these rows are the kind
    // of target that needs two or three tries on a phone.
    for (const row of rows) expect(row).toHaveClass("min-h-11");
  });

  it("gives Sharing its own row on phone widths", async () => {
    // The break in the report: at 375px the header's symmetric `1fr auto 1fr`
    // made the left column (one 56px X) as wide as the right one, and the
    // squeezed centre could not hold "Sharing with 2".
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [activeGrant(ANKIT, "share-ankit")],
    });

    await renderReadyMap();

    const header = screen.getByRole("banner", {
      name: "Location map controls",
    });
    // Phone: two rows, columns sized to their content. Desktop keeps the
    // true-centre three-column layout.
    expect(header).toHaveClass("grid-cols-[auto_minmax(0,1fr)]");
    expect(header).toHaveClass("sm:grid-cols-[1fr_auto_1fr]");

    await waitFor(() => {
      expect(
        screen.getByTestId("one-location-map-sharing-status"),
      ).toBeInTheDocument();
    });
    const sharingRow = screen.getByTestId("one-location-map-sharing-status")
      .parentElement as HTMLElement;
    expect(sharingRow).toHaveClass("row-start-2", "col-span-2");
    expect(sharingRow).toHaveClass("sm:row-start-1", "sm:col-start-2");
  });

  it("keeps Check in out of Your Map's header and puts it in the tray", async () => {
    // The report: "when i want to view my map, checkin could be shifted below
    // at right place". Check in used to float top-right beside Locate, so the
    // top of a screen whose whole job is showing a map carried two pills and a
    // status. It reads its full label down in the tray, and the header is left
    // with the two controls that act on the map itself.
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [activeGrant(ANKIT, "share-ankit")],
    });

    await renderReadyMap();

    const header = screen.getByRole("banner", {
      name: "Location map controls",
    });
    expect(
      header.querySelector('[data-testid="one-location-map-nearby-check-in"]'),
    ).toBeNull();
    expect(
      header.querySelector('[data-testid="one-location-map-locate"]'),
    ).not.toBeNull();

    const checkIn = screen.getByTestId("one-location-map-nearby-check-in");
    expect(checkIn).toHaveTextContent("Check in");
    expect(checkIn).toHaveAccessibleName("Check in nearby");
    // Inside the tray body, so the sheet's own height math already accounts
    // for it and nothing new has to be measured.
    expect(
      screen.getByTestId("one-location-map-tray-scroll").contains(checkIn),
    ).toBe(true);
  });

  it("hides the Check in pill while the sheet is up, and brings it back on dismiss", async () => {
    /**
     * Reported from the check-in drawer: "Check in ka icon and text, Sharing
     * with 1 ka text, You are here wala block ... yeh sb ek sath dikh rha,
     * bahut hi bheed bhaad jesa lag rha hai." On a phone the sheet takes about
     * three quarters of the screen, and five floating controls were competing
     * for the strip left above it.
     *
     * The pill is the clearest thing to drop: while the sheet is open it is
     * the one control on screen that does nothing, because its only job is
     * getting back IN after a dismiss.
     *
     * Which is why the second half of this matters as much as the first. That
     * surface renders no tray at all, so removing the pill outright would
     * strand somebody on a map with no way back into the sheet.
     */
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [],
    });

    await renderReadyMap({ surface: "check-in" });

    const header = screen.getByRole("banner", {
      name: "Check in map controls",
    });

    // The sheet opens with the route.
    expect(
      screen.getByTestId("nearby-check-in-sheet-mock"),
    ).toHaveAttribute("data-open", "true");
    expect(
      header.querySelector('[data-testid="one-location-map-nearby-check-in"]'),
    ).toBeNull();

    fireEvent.click(screen.getByTestId("dismiss-nearby-check-in"));

    expect(
      header.querySelector('[data-testid="one-location-map-nearby-check-in"]'),
    ).not.toBeNull();
  });

  it("keeps the way out and the search-area legend while the sheet is up", async () => {
    // Decluttering must not take the two things up there that are still doing
    // a job. Close is the way out. The legend is the only explanation of what
    // the blue dot is and how far "nearby" reaches -- the sheet states
    // neither, so cutting it would have tidied the screen by removing the part
    // that was answering a question.
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [],
    });

    await renderReadyMap({ surface: "check-in" });

    expect(screen.getByTestId("one-location-map-close")).toBeInTheDocument();
    expect(screen.getByTestId("one-location-map-locate")).toBeInTheDocument();
  });

  it("answers Everyone instead of sitting disabled when no one shares with you", async () => {
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [],
    });
    serviceHarness.getMapState.mockResolvedValue({
      markers: [],
      preferences: { presenceMode: "ghost" },
    });

    await renderReadyMap();

    const everyone = screen.getByTestId("one-location-map-show-everyone");
    // Never disabled: a disabled control gives no reason, and on a touch screen
    // is indistinguishable from a broken one.
    expect(everyone).not.toBeDisabled();

    vi.mocked(toast.message).mockClear();
    fireEvent.click(everyone);

    await waitFor(() => {
      expect(toast.message).toHaveBeenCalledWith(
        "No one is sharing a live location with you yet.",
      );
    });
  });

  it("frames the people who do share with you when Everyone is pressed", async () => {
    serviceHarness.getState.mockResolvedValue({
      recipients: [],
      ownerGrants: [],
    });
    serviceHarness.getMapState.mockResolvedValue({
      markers: [
        incomingMarker(ANKIT, 25.4358, 81.8463),
        incomingMarker(ABDUL, 25.4501, 81.8201),
      ],
      preferences: { presenceMode: "ghost" },
    });

    await renderReadyMap();

    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-marker-count",
        "2",
      );
    });

    vi.mocked(toast.message).mockClear();
    mapHarness.map.fitBounds.mockClear();
    fireEvent.click(screen.getByTestId("one-location-map-show-everyone"));

    await waitFor(() => {
      expect(mapHarness.map.fitBounds).toHaveBeenCalled();
    });
    // With people to show it frames them and says nothing -- the message is
    // reserved for the empty case it explains.
    expect(toast.message).not.toHaveBeenCalledWith(
      "No one is sharing a live location with you yet.",
    );
  });

  /**
   * jsdom lays nothing out, so every rect is 0x0 and a layer positioned in the
   * map box's own pixels would have no box to be positioned in. These are the
   * measurements a phone actually reports: a full-bleed map, a one-row header,
   * and the collapsed people tray sitting above the home indicator.
   */
  function stubPhoneGeometry() {
    const box = (x: number, y: number, width: number, height: number) =>
      ({
        x,
        y,
        width,
        height,
        top: y,
        left: x,
        right: x + width,
        bottom: y + height,
        toJSON: () => ({}),
      }) as DOMRect;

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this.tagName === "CAPACITOR-GOOGLE-MAP") return box(0, 0, 390, 844);
        if (this.tagName === "HEADER") return box(0, 0, 390, 72);
        if (this.tagName === "SECTION") return box(167, 772, 56, 56);
        return box(0, 0, 0, 0);
      },
    );
  }

  /** One camera report, coalesced into state on the next animation frame. */
  async function reportCamera(overrides: Record<string, unknown> = {}) {
    await act(async () => {
      mapHarness.listeners.cameraIdle?.({
        mapId: "one-location-private-map",
        bounds: {
          northeast: { lat: 25.47, lng: 81.87 },
          southwest: { lat: 25.42, lng: 81.8 },
          center: { lat: 25.445, lng: 81.835 },
        },
        latitude: 25.445,
        longitude: 81.835,
        zoom: 12,
        bearing: 0,
        tilt: 0,
        ...overrides,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }

  it("names each pin by first name, and draws you as your own avatar", async () => {
    // The reported gap: two pins and no way to tell who is who without opening
    // the tray. "Ankit Kumar Singh" is what the tray says; a pill over a pin
    // gets the one word he is called.
    //
    // The owner is the one marker that never needed a name: the product knows
    // who they are, so their pin is their face. Both the renderer's generic pin
    // and the "My location" pill go away with it — three ways of saying "you"
    // on one coordinate is two too many.
    stubPhoneGeometry();
    serviceHarness.captureCurrentPosition.mockResolvedValue({
      latitude: 25.46,
      longitude: 81.85,
      accuracyM: 12,
      capturedAt: "2026-07-23T00:00:00.000Z",
      sourcePlatform: "ios",
    });
    serviceHarness.getMapState.mockResolvedValue({
      markers: [
        incomingMarker(ANKIT, 25.4358, 81.8463),
        incomingMarker(ABDUL, 25.4501, 81.8201),
      ],
      preferences: { presenceMode: "ghost" },
    });

    await renderReadyMap();
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-marker-count",
        "2",
      );
    });

    // Nothing is drawn until the renderer says what it is showing: the pills
    // are positioned from the camera, never guessed.
    expect(screen.getByTestId("one-location-map-name-labels")).toHaveAttribute(
      "data-label-count",
      "0",
    );

    await reportCamera();

    const labels = screen.getAllByTestId("one-location-map-name-label");
    expect(labels.map((label) => label.textContent)).toEqual([
      "Ankit",
      "Abdul",
    ]);
    expect(labels[0]).toHaveAttribute("data-kind", "person");
    expect(
      labels.some((label) => label.getAttribute("data-kind") === "self"),
    ).toBe(false);

    // You, as yourself: the app's existing avatar, at the owner's coordinate.
    const selfMarkerEl = screen.getByTestId("one-location-map-self-avatar");
    expect(selfMarkerEl).toHaveAccessibleName("Your location");
    await waitFor(() => {
      expect(
        screen.getByTestId("one-location-map-self-avatar-photo"),
      ).toHaveAttribute("src", "https://avatars.test/ankit.jpg");
    });

    // And the renderer is no longer asked to draw a pin under it. The last
    // marker write carries the two incoming people and nothing else.
    await waitFor(() => {
      const lastAddMarkers = mapHarness.map.addMarkers.mock.calls.at(-1)?.[0] as
        | Array<{ coordinate: { lat: number; lng: number } }>
        | undefined;
      expect(lastAddMarkers).toHaveLength(2);
      expect(
        lastAddMarkers?.some(
          (marker) => Math.abs(marker.coordinate.lat - 25.46) < 0.0001,
        ),
      ).toBe(false);
    });

    // The boundary the pills are allowed to exist on top of: names are HTML in
    // the WebView, and the renderer is still told nothing but coordinates.
    const markerPayload = JSON.stringify(mapHarness.map.addMarkers.mock.calls);
    expect(markerPayload).not.toContain("Ankit");
    expect(markerPayload).not.toContain("Abdul");
    // The avatar is HTML too. Nothing about who the owner is reaches the
    // renderer either -- not the URL, not the name.
    expect(markerPayload).not.toContain("avatars.test");
  });

  it("falls back to the app's own initials when there is no profile photo", async () => {
    identityHarness.avatarUrl = null;
    stubPhoneGeometry();
    serviceHarness.captureCurrentPosition.mockResolvedValue({
      latitude: 25.46,
      longitude: 81.85,
      accuracyM: 12,
      capturedAt: "2026-07-23T00:00:00.000Z",
      sourcePlatform: "ios",
    });

    await renderReadyMap();
    await reportCamera();

    expect(
      screen.queryByTestId("one-location-map-self-avatar-photo"),
    ).not.toBeInTheDocument();
    // The same two initials the top bar and the profile screen show. No third
    // placeholder system.
    expect(
      screen.getByTestId("one-location-map-self-avatar-fallback"),
    ).toHaveTextContent("AK");
  });

  it("leaves the check-in map's two pins and its colour legend alone", async () => {
    // Check-in asks a different question -- how far am I from the place I am
    // checking in to -- and answers it with two pins, a connector, and a legend
    // whose swatch IS the owner's pin colour. A photo in place of one of those
    // pins breaks the comparison and leaves the legend keying nothing.
    experienceHarness.nearbyAvailable = true;
    stubPhoneGeometry();
    serviceHarness.captureCurrentPosition.mockResolvedValue({
      latitude: 25.46,
      longitude: 81.85,
      accuracyM: 12,
      capturedAt: "2026-07-23T00:00:00.000Z",
      sourcePlatform: "ios",
    });

    await renderReadyMap({ surface: "check-in" });
    await reportCamera();

    expect(
      screen.queryByTestId("one-location-map-self-avatar"),
    ).not.toBeInTheDocument();
    const lastAddMarkers = mapHarness.map.addMarkers.mock.calls.at(-1)?.[0] as
      | Array<{ coordinate: { lat: number; lng: number } }>
      | undefined;
    expect(
      lastAddMarkers?.some(
        (marker) => Math.abs(marker.coordinate.lat - 25.46) < 0.0001,
      ),
    ).toBe(true);
  });

  it("keeps the renderer's own pin when the renderer never reports a camera", async () => {
    // A renderer too old to emit onBoundsChanged/onCameraIdle can project
    // nothing, so the avatar layer has no coordinates to draw at. Losing the
    // owner's marker entirely would be worse than a plain pin, so the pin
    // stays. Both listeners are already wrapped in a try/catch at create; this
    // is the state that leaves behind.
    stubPhoneGeometry();
    serviceHarness.captureCurrentPosition.mockResolvedValue({
      latitude: 25.46,
      longitude: 81.85,
      accuracyM: 12,
      capturedAt: "2026-07-23T00:00:00.000Z",
      sourcePlatform: "ios",
    });

    await renderReadyMap();
    await waitFor(() => {
      expect(mapHarness.map.addMarkers).toHaveBeenCalled();
    });

    // No reportCamera() in this case, on purpose.
    expect(
      screen.queryByTestId("one-location-map-self-avatar"),
    ).not.toBeInTheDocument();
    const lastAddMarkers = mapHarness.map.addMarkers.mock.calls.at(-1)?.[0] as
      | Array<{ coordinate: { lat: number; lng: number } }>
      | undefined;
    expect(
      lastAddMarkers?.some(
        (marker) => Math.abs(marker.coordinate.lat - 25.46) < 0.0001,
      ),
    ).toBe(true);
  });

  it("answers a tap on your avatar the way the renderer answered a tap on your pin", async () => {
    stubPhoneGeometry();
    serviceHarness.captureCurrentPosition.mockResolvedValue({
      latitude: 25.46,
      longitude: 81.85,
      accuracyM: 12,
      capturedAt: "2026-07-23T00:00:00.000Z",
      sourcePlatform: "ios",
    });

    await renderReadyMap();
    await reportCamera();
    mapHarness.map.setCamera.mockClear();

    fireEvent.click(screen.getByTestId("one-location-map-self-avatar"));

    await waitFor(() => {
      expect(mapHarness.map.setCamera).toHaveBeenCalledWith(
        expect.objectContaining({
          coordinate: { lat: 25.46, lng: 81.85 },
          zoom: 15,
          animate: true,
        }),
      );
    });
  });

  it("opens the pre-consent world view on a camera that fills the box it was given", async () => {
    // The blank strip above the map. The container was never wrong
    // (`h-[100dvh]`, renderer `absolute inset-0`); the camera was. A fixed
    // `{ lat: 20, lng: 0 }, zoom: 2` puts a 1024 px world in front of a viewport
    // that can be taller than the 908 px that camera is able to cover, and
    // Google paints its out-of-world backdrop in the difference.
    experienceHarness.demoMode = false;
    stubPhoneGeometry();

    render(<LocationImmersiveMap />);

    await waitFor(() => {
      expect(mapHarness.create).toHaveBeenCalled();
    });
    const config = (
      mapHarness.create.mock.calls.at(-1)?.[0] as unknown as {
        config: { center: { lat: number; lng: number }; zoom: number };
      }
    ).config;

    // stubPhoneGeometry reports the renderer at 390x844 -- an iPhone 15. That
    // box is coverable from latitude 20 at zoom 2, so nothing moves.
    expect(config.zoom).toBe(2);
    expect(config.center.lat).toBe(MAP_NEUTRAL_WORLD_LATITUDE);
    expect(
      outOfWorldBandPx(
        { center: config.center, zoom: config.zoom },
        { width: 390, height: 844 },
      ),
    ).toBe(0);
  });

  it("moves the pre-consent camera off latitude 20 on a box that cannot be covered from there", () => {
    // The same arithmetic, on the devices where the old camera did leak. This
    // is a pure check on purpose: the failure is device geometry, and pinning
    // it to a renderer would make it look like a rendering bug.
    const boxes = [
      { name: "iPhone SE", width: 375, height: 667 },
      { name: "iPhone 15", width: 390, height: 844 },
      { name: "iPhone 15 Pro Max", width: 430, height: 932 },
      { name: "the reported browser window", width: 552, height: 1080 },
      { name: "landscape Pro Max", width: 932, height: 430 },
    ];

    for (const box of boxes) {
      const camera = neutralWorldCamera(box);
      expect(
        outOfWorldBandPx(camera, box),
        `${box.name} (${box.width}x${box.height}) must show no backdrop`,
      ).toBe(0);
      // And the OLD camera is what this replaced: on the two tallest boxes it
      // could not have covered them.
      const previous = { center: { lat: 20, lng: 0 }, zoom: 2 };
      if (box.height > 908) {
        expect(
          outOfWorldBandPx(previous, box),
          `${box.name} is a box the previous fixed camera left a band on`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("draws no name over a rotated map, and none for a pin off screen", async () => {
    stubPhoneGeometry();
    serviceHarness.getMapState.mockResolvedValue({
      markers: [incomingMarker(ANKIT, 25.4358, 81.8463)],
      preferences: { presenceMode: "ghost" },
    });

    await renderReadyMap();
    await waitFor(() => {
      expect(screen.getByTestId("one-location-map")).toHaveAttribute(
        "data-map-marker-count",
        "1",
      );
    });

    await reportCamera();
    expect(screen.getAllByTestId("one-location-map-name-label")).toHaveLength(1);

    // The projection is flat, so under a bearing every name would slide off
    // its own pin. A name over the wrong pin is worse than no name.
    await reportCamera({ bearing: 42 });
    expect(screen.queryAllByTestId("one-location-map-name-label")).toHaveLength(
      0,
    );

    // Panned away: the pin is not on screen, so neither is what it is called.
    await reportCamera({
      bounds: {
        northeast: { lat: 45, lng: 10 },
        southwest: { lat: 44, lng: 9 },
        center: { lat: 44.5, lng: 9.5 },
      },
    });
    expect(screen.queryAllByTestId("one-location-map-name-label")).toHaveLength(
      0,
    );
  });

  it("fades the names out while a native camera is mid-gesture", async () => {
    // iOS and Android report the camera only once it settles. Holding the old
    // positions through a drag would walk every name away from its pin, so the
    // layer says nothing until it knows something again.
    platformHarness.native = true;
    stubPhoneGeometry();
    serviceHarness.getMapState.mockResolvedValue({
      markers: [incomingMarker(ANKIT, 25.4358, 81.8463)],
      preferences: { presenceMode: "ghost" },
    });

    await renderReadyMap();
    await reportCamera();

    const layer = screen.getByTestId("one-location-map-name-labels");
    expect(layer).toHaveClass("opacity-100");

    await act(async () => {
      mapHarness.listeners.cameraMoveStarted?.({
        mapId: "one-location-private-map",
        isGesture: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(layer).toHaveClass("opacity-0");

    // The camera settling is what ends the blackout.
    await reportCamera();
    expect(layer).toHaveClass("opacity-100");
  });
});
