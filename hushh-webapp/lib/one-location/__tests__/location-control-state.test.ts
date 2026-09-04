import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearOneLocationControlRuntime,
  forgetOneLocationControlPreference,
  readOneLocationControlState,
  subscribeOneLocationControlState,
  updateOneLocationControlState,
} from "@/lib/one-location/location-control-state";

const userId = "location-control-user";
const autoApproveKey = `one_location_auto_approve_requests_v1:${userId}`;

afterEach(() => {
  forgetOneLocationControlPreference(userId);
});

describe("One Location control state", () => {
  it("keeps pause durable while runtime activity remains memory-only", () => {
    updateOneLocationControlState(userId, (current) => ({
      ...current,
      paused: true,
      selfPreviewEnabled: true,
      nearbyPresenceActive: true,
      nearbyCheckedInAt: "2026-07-31T00:00:00.000Z",
    }));

    clearOneLocationControlRuntime(userId);

    expect(readOneLocationControlState(userId)).toEqual({
      autoApproveRequestsEnabled: false,
      autoApproveEnabledAt: null,
      autoApproveScope: null,
      paused: true,
      selfPreviewEnabled: false,
      nearbyPresenceActive: false,
      nearbyCheckedInAt: null,
    });
  });

  it("keeps pause across remounts but never restores browser auto-approve", () => {
    window.localStorage.setItem(
      autoApproveKey,
      JSON.stringify({
        enabledAt: "2026-08-14T09:00:00.000Z",
        scope: { kind: "all_contacts" },
      }),
    );
    updateOneLocationControlState(userId, (current) => ({
      ...current,
      autoApproveRequestsEnabled: true,
      autoApproveScope: { kind: "all_contacts" },
      paused: true,
    }));

    clearOneLocationControlRuntime(userId);

    expect(readOneLocationControlState(userId)).toEqual(
      expect.objectContaining({
        autoApproveRequestsEnabled: false,
        autoApproveEnabledAt: null,
        autoApproveScope: null,
        paused: true,
      }),
    );
  });

  it("refuses to make browser state a standing-consent authority", () => {
    const state = updateOneLocationControlState(userId, (current) => ({
      ...current,
      autoApproveRequestsEnabled: true,
      autoApproveEnabledAt: "2026-08-14T09:00:00.000Z",
      autoApproveScope: { kind: "circle", circleId: "circle_family" },
    }));

    expect(state).toEqual(
      expect.objectContaining({
        autoApproveRequestsEnabled: false,
        autoApproveEnabledAt: null,
        autoApproveScope: null,
      }),
    );
  });

  it("notifies every mounted surface from one update", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOneLocationControlState(userId, listener);

    updateOneLocationControlState(userId, (current) => ({
      ...current,
      paused: false,
      nearbyPresenceActive: true,
      nearbyCheckedInAt: "2026-07-31T00:00:00.000Z",
    }));

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        nearbyPresenceActive: true,
        nearbyCheckedInAt: "2026-07-31T00:00:00.000Z",
      }),
    );
    unsubscribe();
  });

  it("applies Pause changes made in another tab", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOneLocationControlState(userId, listener);
    updateOneLocationControlState(userId, (current) => ({
      ...current,
      selfPreviewEnabled: true,
      nearbyPresenceActive: true,
      nearbyCheckedInAt: "2026-07-31T00:00:00.000Z",
    }));
    listener.mockClear();

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `one_location_updates_paused_v1:${userId}`,
        newValue: "1",
      }),
    );

    expect(readOneLocationControlState(userId)).toEqual(
      expect.objectContaining({
        paused: true,
        selfPreviewEnabled: false,
        nearbyPresenceActive: false,
        nearbyCheckedInAt: null,
      }),
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ paused: true }),
    );
    unsubscribe();
  });

  it("never retains a nearby timestamp after presence ends", () => {
    const state = updateOneLocationControlState(userId, (current) => ({
      ...current,
      nearbyPresenceActive: false,
      nearbyCheckedInAt: "stale-value",
    }));

    expect(state.nearbyCheckedInAt).toBeNull();
  });
});
