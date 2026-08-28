import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * app/one/location/check-in/page.tsx used to be one of two Location routes
 * that never called usePublishVoiceSurfaceMetadata at all -- voice offered
 * zero proactively-offered actions here even though
 * NearbyCheckInSheet's handlers were live on this screen. These tests pin
 * the wiring: the right screenId and actions publish when the screen is
 * genuinely showing, and nothing publishes when it isn't (matches the
 * page's own render gate, which returns null in the same cases).
 */

const authHarness = vi.hoisted(() => ({
  loading: false,
  isAuthenticated: true,
  userId: "test-user" as string | null,
}));

const nearbyAvailableHarness = vi.hoisted(() => ({ value: true }));

const publishSpy = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-auth", () => ({
  useRequireAuth: () => ({
    loading: authHarness.loading,
    isAuthenticated: authHarness.isAuthenticated,
    userId: authHarness.userId,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: vi.fn() }),
}));

vi.mock("@/lib/one-location/nearby-check-in-availability", () => ({
  isOneLocationNearbyCheckInAvailable: () => nearbyAvailableHarness.value,
}));

vi.mock("@/components/one-location/location-immersive-map", () => ({
  LocationImmersiveMap: () => null,
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: (metadata: unknown) => publishSpy(metadata),
}));

import OneLocationCheckInPage from "@/app/one/location/check-in/page";

describe("Location check-in page publishes voice metadata", () => {
  afterEach(() => {
    publishSpy.mockClear();
    routerReplace.mockClear();
    authHarness.loading = false;
    authHarness.isAuthenticated = true;
    authHarness.userId = "test-user";
    nearbyAvailableHarness.value = true;
  });

  it("publishes the one_location_check_in screen with its derived actions when authenticated and available", () => {
    render(<OneLocationCheckInPage />);

    expect(publishSpy).toHaveBeenCalled();
    const metadata = publishSpy.mock.calls.at(-1)?.[0] as {
      screenId: string;
      actions: Array<{ actionId: string }>;
    };
    expect(metadata).not.toBeNull();
    expect(metadata.screenId).toBe("one_location_check_in");
    const actionIds = metadata.actions.map((action) => action.actionId).sort();
    expect(actionIds).toEqual([
      "location.checkout_nearby",
      "location.confirm_nearby_check_in",
      "location.nearby_check_in",
    ]);
  });

  it("publishes nothing while auth is still loading", () => {
    authHarness.loading = true;
    render(<OneLocationCheckInPage />);

    expect(publishSpy).toHaveBeenCalledWith(null);
  });

  it("publishes nothing when unauthenticated", () => {
    authHarness.isAuthenticated = false;
    render(<OneLocationCheckInPage />);

    expect(publishSpy).toHaveBeenCalledWith(null);
  });

  it("publishes nothing when nearby check-in is unavailable -- the screen redirects away instead", () => {
    nearbyAvailableHarness.value = false;
    render(<OneLocationCheckInPage />);

    expect(publishSpy).toHaveBeenCalledWith(null);
    expect(routerReplace).toHaveBeenCalledWith(
      "/one/location?action=check-in",
      { scroll: false },
    );
  });
});
