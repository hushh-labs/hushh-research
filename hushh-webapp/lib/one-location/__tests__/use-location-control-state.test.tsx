// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { forgetOneLocationControlPreference } from "@/lib/one-location/location-control-state";
import { useOneLocationControlState } from "@/lib/one-location/use-location-control-state";

const userId = "cross-tab-location-user";

afterEach(() => {
  forgetOneLocationControlPreference(userId);
});

describe("useOneLocationControlState cross-tab sync", () => {
  it("reconciles pause, automatic updates, and background opt-in from storage events", async () => {
    const { result } = renderHook(() => useOneLocationControlState(userId));

    act(() => {
      window.localStorage.setItem(`one_location_auto_share_v1:${userId}`, "0");
      window.localStorage.setItem(
        `one_location_background_share_v1:${userId}`,
        "1",
      );
      window.localStorage.setItem(
        `one_location_updates_paused_v1:${userId}`,
        "1",
      );
      window.dispatchEvent(new StorageEvent("storage"));
    });

    await waitFor(() => {
      expect(result.current).toMatchObject({
        autoShareEnabled: false,
        backgroundShareEnabled: false,
        paused: true,
      });
    });

    act(() => {
      window.localStorage.removeItem(`one_location_auto_share_v1:${userId}`);
      window.localStorage.removeItem(
        `one_location_updates_paused_v1:${userId}`,
      );
      window.localStorage.setItem(
        `one_location_background_share_v1:${userId}`,
        "1",
      );
      window.dispatchEvent(new StorageEvent("storage"));
    });

    await waitFor(() => {
      expect(result.current).toMatchObject({
        autoShareEnabled: true,
        backgroundShareEnabled: true,
        paused: false,
      });
    });
  });
});
