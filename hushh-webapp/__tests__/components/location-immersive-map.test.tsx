import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mapHarness = vi.hoisted(() => {
  const map = {
    addMarkers: vi.fn(async (markers: unknown[]) =>
      markers.map((_, index) => `marker-${index}`),
    ),
    destroy: vi.fn(async () => undefined),
    disableTouch: vi.fn(async () => undefined),
    disableClustering: vi.fn(async () => undefined),
    enableTouch: vi.fn(async () => undefined),
    enableClustering: vi.fn(async () => undefined),
    fitBounds: vi.fn(async () => undefined),
    removeMarkers: vi.fn(async () => undefined),
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
  storeEnvelope: vi.fn(),
  updateMapPreferences: vi.fn(),
}));

const navigationHarness = vi.hoisted(() => ({
  beginRouteTransition: vi.fn((_href: string, navigate: () => void) =>
    navigate(),
  ),
  replace: vi.fn(),
}));

vi.mock("@capacitor/google-maps", () => ({
  GoogleMap: { create: mapHarness.create },
  LatLngBounds: class LatLngBounds {
    constructor(public readonly value: unknown) {}
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigationHarness.replace }),
  useSearchParams: () => new URLSearchParams("demo=people"),
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
  isLocationMapDemoEnabled: () => true,
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

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
}));

import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";

beforeEach(() => {
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
  serviceHarness.storeEnvelope.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const value of Object.values(mapHarness.map)) {
    if ("mockReset" in value) value.mockReset();
  }
  mapHarness.create.mockClear();
  navigationHarness.beginRouteTransition.mockClear();
  navigationHarness.replace.mockClear();
  for (const value of Object.values(serviceHarness)) value.mockReset();
});

describe("LocationImmersiveMap demo experience", () => {
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
      height: "168px",
      borderRadius: "1.75rem",
    });
    expect(screen.getByTestId("one-location-map-tray-body")).toHaveClass(
      "translate-y-0",
      "opacity-100",
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
});
