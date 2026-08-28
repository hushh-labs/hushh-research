import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * app/one/location/map/page.tsx used to be one of two Location routes that
 * never called usePublishVoiceSurfaceMetadata at all -- see the same note in
 * check-in-page-voice-publish.test.tsx. These tests pin the wiring: the
 * right screenId and actions publish once authenticated, nothing publishes
 * before then.
 */

const authHarness = vi.hoisted(() => ({
  loading: false,
  isAuthenticated: true,
  userId: "test-user" as string | null,
}));

const publishSpy = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-auth", () => ({
  useRequireAuth: () => ({
    loading: authHarness.loading,
    isAuthenticated: authHarness.isAuthenticated,
    userId: authHarness.userId,
  }),
}));

vi.mock("@/components/one-location/location-immersive-map", () => ({
  LocationImmersiveMap: () => null,
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: (metadata: unknown) => publishSpy(metadata),
}));

import OneLocationMapPage from "@/app/one/location/map/page";

describe("Location map page publishes voice metadata", () => {
  afterEach(() => {
    publishSpy.mockClear();
    authHarness.loading = false;
    authHarness.isAuthenticated = true;
    authHarness.userId = "test-user";
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
});
