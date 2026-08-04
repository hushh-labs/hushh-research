// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mapsHookMock, mapsStatus } = vi.hoisted(() => ({
  mapsHookMock: vi.fn(),
  mapsStatus: { current: "ready" as "loading" | "ready" | "error" },
}));

vi.mock("@/lib/one-location/use-google-maps", () => ({
  useGoogleMaps: ({ enabled = true }: { enabled?: boolean } = {}) => {
    mapsHookMock({ enabled });
    return { status: enabled ? mapsStatus.current : "loading" };
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

import { LocationPickerMap } from "@/components/one-location/onboarding/location-picker-map";

type MapListener = () => void;

describe("LocationPickerMap", () => {
  let listeners: Map<string, MapListener>;
  let currentCenter: { lat: number; lng: number };
  let mapConstructor: ReturnType<typeof vi.fn>;
  let browserGeocode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mapsStatus.current = "ready";
    listeners = new Map();
    currentCenter = { lat: 28.6139, lng: 77.209 };
    mapConstructor = vi.fn();
    browserGeocode = vi.fn().mockResolvedValue({ results: [] });

    class MockGoogleMap {
      constructor(
        _element: HTMLElement,
        options: { center: { lat: number; lng: number } },
      ) {
        currentCenter = options.center;
        mapConstructor(options);
      }

      addListener(name: string, listener: MapListener) {
        listeners.set(name, listener);
        return { remove: () => listeners.delete(name) };
      }

      getCenter() {
        return {
          lat: () => currentCenter.lat,
          lng: () => currentCenter.lng,
        };
      }

      panTo(point: { lat: number; lng: number }) {
        currentCenter = point;
      }

      setZoom() {}
    }

    class MockGeocoder {
      geocode = browserGeocode;
    }

    Object.defineProperty(globalThis, "google", {
      configurable: true,
      value: {
        maps: {
          Map: MockGoogleMap,
          Geocoder: MockGeocoder,
        },
      },
    });
  });

  it("opens the map directly without a pre-map disclosure step", async () => {
    function Harness() {
      const [accepted] = useState(false);
      return (
        <LocationPickerMap
          initialLatitude={28.6139}
          initialLongitude={77.209}
          initialAddress="New Delhi 110001, India"
          // Even when the legacy disclosure flag is false, the picker now opens
          // the interactive map immediately (the extra disclosure screen was
          // removed) and initializes Google Maps right away.
          rendererDisclosureAccepted={accepted}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      );
    }

    render(<Harness />);

    // The old "Before the map opens" disclosure card is gone.
    expect(screen.queryByTestId("saved-location-map-disclosure")).toBeNull();
    expect(
      screen.queryByText(/Google Maps receives the selected point/i),
    ).toBeNull();

    // The map surface renders and Google Maps initializes immediately.
    expect(screen.getByText(/Pin your entrance on the map/i)).toBeTruthy();
    await waitFor(() => expect(mapConstructor).toHaveBeenCalledTimes(1));
    expect(mapsHookMock).toHaveBeenLastCalledWith({ enabled: true });
  });


  it("blocks confirmation until the moved centre has a matching address", async () => {
    vi.useFakeTimers();
    let resolveAddress: ((value: string | null) => void) | undefined;
    const reverseGeocode = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveAddress = resolve;
        }),
    );
    const onConfirm = vi.fn();
    render(
      <LocationPickerMap
        initialLatitude={28.6139}
        initialLongitude={77.209}
        initialAddress="Old address"
        rendererDisclosureAccepted
        onAcceptRendererDisclosure={vi.fn().mockResolvedValue(undefined)}
        reverseGeocode={reverseGeocode}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await act(async () => undefined);

    currentCenter = { lat: 28.6142, lng: 77.2094 };
    act(() => {
      listeners.get("dragstart")?.();
      listeners.get("idle")?.();
    });

    const confirmButton = screen.getByRole("button", {
      name: "Confirm location",
    });
    expect(confirmButton).toBeDisabled();
    fireEvent.click(confirmButton);
    expect(onConfirm).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(reverseGeocode).toHaveBeenCalledWith(28.6142, 77.2094);
    expect(confirmButton).toBeDisabled();

    await act(async () => {
      resolveAddress?.("Updated address 110001, India");
      await Promise.resolve();
    });
    expect(confirmButton).toBeEnabled();

    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith({
      latitude: 28.6142,
      longitude: 77.2094,
      address: "Updated address 110001, India",
    });
    vi.useRealTimers();
  });

  it("ignores an older reverse-geocode result after the centre moves again", async () => {
    vi.useFakeTimers();
    const resolveAddresses: Array<(value: string | null) => void> = [];
    const reverseGeocode = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveAddresses.push(resolve);
        }),
    );
    const onConfirm = vi.fn();
    render(
      <LocationPickerMap
        initialLatitude={28.6139}
        initialLongitude={77.209}
        initialAddress="Initial address"
        rendererDisclosureAccepted
        onAcceptRendererDisclosure={vi.fn().mockResolvedValue(undefined)}
        reverseGeocode={reverseGeocode}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await act(async () => undefined);

    currentCenter = { lat: 28.6142, lng: 77.2094 };
    act(() => {
      listeners.get("dragstart")?.();
      listeners.get("idle")?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    currentCenter = { lat: 12.9716, lng: 77.5946 };
    act(() => {
      listeners.get("dragstart")?.();
      listeners.get("idle")?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    expect(reverseGeocode).toHaveBeenNthCalledWith(1, 28.6142, 77.2094);
    expect(reverseGeocode).toHaveBeenNthCalledWith(2, 12.9716, 77.5946);

    await act(async () => {
      resolveAddresses[1]?.("Bengaluru address 560001, India");
      await Promise.resolve();
    });
    expect(screen.getByText("Bengaluru address 560001, India")).toBeTruthy();

    await act(async () => {
      resolveAddresses[0]?.("Stale New Delhi address 110001, India");
      await Promise.resolve();
    });
    expect(
      screen.queryByText("Stale New Delhi address 110001, India"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledWith({
      latitude: 12.9716,
      longitude: 77.5946,
      address: "Bengaluru address 560001, India",
    });
    vi.useRealTimers();
  });

  it("lets the owner continue manually when the provider map is unavailable", () => {
    mapsStatus.current = "error";
    const onConfirm = vi.fn();
    render(
      <LocationPickerMap
        initialLatitude={28.6139}
        initialLongitude={77.209}
        initialAddress={null}
        rendererDisclosureAccepted
        onAcceptRendererDisclosure={vi.fn().mockResolvedValue(undefined)}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/interactive map isn't available/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use captured point" }));
    expect(onConfirm).toHaveBeenCalledWith({
      latitude: 28.6139,
      longitude: 77.209,
      address: null,
    });
  });
});
