// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tapping "Use my current location" killed the app on device.
 *
 * The crash report is unambiguous:
 *
 *   libswiftCore.dylib  _assertionFailure(...)
 *   App.debug.dylib     Map.setCamera(config:)
 *   App.debug.dylib     CapacitorGoogleMapsPlugin.setCamera(_:)
 *
 * @capacitor/google-maps declares `var GMapView: GMSMapView!`, so `setCamera`
 * force-unwraps it. Calling it while the native map is being created or
 * destroyed finds nil there and traps, which terminates the process instead of
 * throwing something JavaScript could catch -- the try/catch around the handler
 * never had a chance.
 *
 * The window was real: teardown clears the map ref synchronously but destroys
 * the map asynchronously inside a lock, and the create effect re-runs when the
 * theme resolves. So the fix is to take that same lock and re-read the ref
 * inside it. These tests hold that contract.
 */

const state = vi.hoisted(() => ({
  native: true,
  lockDepth: 0,
  setCameraCalls: [] as Array<{ insideLock: boolean }>,
  mapRefLive: true,
}));

vi.mock("@/lib/capacitor/platform", () => ({
  isNative: () => state.native,
  getPlatform: () => (state.native ? "ios" : "web"),
}));

vi.mock("@/lib/one-location/maps-config", () => ({
  DARK_MAP_STYLES: [],
  getNativeMapsApiKey: () => "test-key",
}));

vi.mock("@/lib/one-location/native-map-lifecycle", () => ({
  claimNativeMap: () => ({ id: 1, release: () => {} }),
  isNativeMapSuperseded: () => false,
  waitForLaidOutBox: async () => true,
  withNativeMapLock: async (_id: string, run: () => Promise<unknown>) => {
    state.lockDepth += 1;
    try {
      return await run();
    } finally {
      state.lockDepth -= 1;
    }
  },
}));

const nativeMap = {
  setCamera: vi.fn(async () => {
    state.setCameraCalls.push({ insideLock: state.lockDepth > 0 });
  }),
  setOnCameraIdleListener: vi.fn(async () => {}),
  setOnCameraMoveStartedListener: vi.fn(async () => {}),
  setOnMapClickListener: vi.fn(async () => {}),
  enableCurrentLocation: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
};

vi.mock("@capacitor/google-maps", () => ({
  GoogleMap: {
    create: vi.fn(async () => (state.mapRefLive ? nativeMap : null)),
  },
}));

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

vi.mock("@/lib/one-location/use-google-maps", () => ({
  useGoogleMaps: () => ({ status: "loading" }),
}));

import { LocationPickerMap } from "@/components/one-location/onboarding/location-picker-map";

describe("locate-me on native", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.native = true;
    state.lockDepth = 0;
    state.setCameraCalls = [];
    state.mapRefLive = true;
  });

  const renderPicker = (onLocateMe: () => Promise<{ latitude: number; longitude: number } | null>) =>
    render(
      <LocationPickerMap
        initialLatitude={28.6139}
        initialLongitude={77.209}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        confirmLabel="Confirm pin"
        cancelLabel="Skip for now"
        onLocateMe={onLocateMe}
        rendererDisclosureAccepted
        onAcceptRendererDisclosure={vi.fn(async () => {})}
      />,
    );

  it("moves the camera only while holding the native map lock", async () => {
    renderPicker(async () => ({ latitude: 12.97, longitude: 77.59 }));

    const button = await screen.findByLabelText("Use my current location");
    fireEvent.click(button);

    await waitFor(() => {
      expect(state.setCameraCalls.length).toBeGreaterThan(0);
    });

    // The whole point: every camera move happened inside the lock, so it can
    // never overlap the create or destroy that leave GMapView nil.
    for (const call of state.setCameraCalls) {
      expect(call.insideLock).toBe(true);
    }
  });

  it("does not crash the flow when the GPS fix fails", async () => {
    renderPicker(async () => null);

    const button = await screen.findByLabelText("Use my current location");
    fireEvent.click(button);

    // No camera move attempted, and the picker is still interactive.
    await waitFor(() => {
      expect(screen.getByLabelText("Use my current location")).toBeEnabled();
    });
    expect(state.setCameraCalls).toHaveLength(0);
  });
});
