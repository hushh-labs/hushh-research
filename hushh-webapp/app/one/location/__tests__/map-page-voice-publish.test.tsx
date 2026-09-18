import { cleanup, render, screen } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Pin the route's auth-gated voice metadata and its immersive map renderer.
 * PR #6786 made Live voice readiness replace the existing map UI. Voice
 * readiness must not choose a different map or reset its owner-scoped state.
 */

const authHarness = vi.hoisted(() => ({
  loading: false,
  isAuthenticated: true,
  userId: "test-user" as string | null,
}));
const voiceHarness = vi.hoisted(() => ({ enabled: false }));
const mapLifecycle = vi.hoisted(() => ({
  mount: vi.fn(),
  unmount: vi.fn(),
}));
const publishSpy = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-auth", () => ({
  useRequireAuth: () => ({
    loading: authHarness.loading,
    isAuthenticated: authHarness.isAuthenticated,
    userId: authHarness.userId,
  }),
}));

vi.mock("@/lib/one-voice/readiness", () => ({
  useOneVoiceLiveEnabled: () => voiceHarness.enabled,
}));

vi.mock("@/components/one-location/location-immersive-map", () => ({
  LocationImmersiveMap: () => {
    useEffect(() => {
      mapLifecycle.mount();
      return () => {
        mapLifecycle.unmount();
      };
    }, []);
    return createElement("div", { "data-testid": "immersive-your-map" });
  },
}));

vi.mock("@/components/location/map/location-map-screen", () => ({
  LocationMapScreen: () =>
    createElement("div", { "data-testid": "replacement-your-map" }),
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: (metadata: unknown) => publishSpy(metadata),
}));

import OneLocationMapPage from "@/app/one/location/map/page";

describe("Location map page preserves immersive UI and voice metadata", () => {
  afterEach(() => {
    cleanup();
    publishSpy.mockClear();
    mapLifecycle.mount.mockClear();
    mapLifecycle.unmount.mockClear();
    authHarness.loading = false;
    authHarness.isAuthenticated = true;
    authHarness.userId = "test-user";
    voiceHarness.enabled = false;
  });

  it("publishes the one_location_map screen with its derived actions when authenticated", () => {
    render(<OneLocationMapPage />);

    expect(publishSpy).toHaveBeenCalled();
    const metadata = publishSpy.mock.calls.at(-1)?.[0] as {
      screenId: string;
      actions: Array<{ actionId: string }>;
    };
    expect(metadata).not.toBeNull();
    expect(metadata.screenId).toBe("one_location_map");
    const actionIds = metadata.actions.map((action) => action.actionId).sort();
    expect(actionIds).toEqual(
      [
        "location.checkout_nearby",
        "location.confirm_nearby_check_in",
        "location.nearby_check_in",
        "location.open_check_in",
        "location.open_map",
      ].sort(),
    );
  });

  it("publishes nothing while auth is still loading", () => {
    authHarness.loading = true;
    render(<OneLocationMapPage />);

    expect(publishSpy).toHaveBeenCalledWith(null);
  });

  it("publishes nothing when unauthenticated", () => {
    authHarness.isAuthenticated = false;
    render(<OneLocationMapPage />);

    expect(publishSpy).toHaveBeenCalledWith(null);
  });

  it.each([false, true])(
    "renders the existing immersive map when Live voice is %s",
    (enabled) => {
      voiceHarness.enabled = enabled;
      render(<OneLocationMapPage />);

      expect(screen.getByTestId("immersive-your-map")).toBeInTheDocument();
      expect(screen.queryByTestId("replacement-your-map")).not.toBeInTheDocument();
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({ screenId: "one_location_map", title: "Your Map" }),
      );
    },
  );

  it("does not replace or remount the map when voice readiness changes", () => {
    const { rerender } = render(<OneLocationMapPage />);
    const map = screen.getByTestId("immersive-your-map");

    voiceHarness.enabled = true;
    rerender(<OneLocationMapPage />);
    expect(screen.getByTestId("immersive-your-map")).toBe(map);

    voiceHarness.enabled = false;
    rerender(<OneLocationMapPage />);
    expect(screen.getByTestId("immersive-your-map")).toBe(map);
    expect(mapLifecycle.mount).toHaveBeenCalledTimes(1);
    expect(mapLifecycle.unmount).not.toHaveBeenCalled();
  });

  it("still remounts the map when the authenticated owner changes", () => {
    const { rerender } = render(<OneLocationMapPage />);
    const previousMap = screen.getByTestId("immersive-your-map");

    authHarness.userId = "another-user";
    rerender(<OneLocationMapPage />);

    expect(screen.getByTestId("immersive-your-map")).not.toBe(previousMap);
    expect(mapLifecycle.unmount).toHaveBeenCalledTimes(1);
    expect(mapLifecycle.mount).toHaveBeenCalledTimes(2);
  });
});
