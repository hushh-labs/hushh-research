import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearOneLocationControlRuntime,
  forgetOneLocationControlPreference,
  readOneLocationControlState,
  subscribeOneLocationControlState,
  updateOneLocationControlState,
} from "@/lib/one-location/location-control-state";

const userId = "location-control-user";

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
      autoShareEnabled: true,
      backgroundShareEnabled: false,
      paused: true,
      selfPreviewEnabled: false,
      nearbyPresenceActive: false,
      nearbyCheckedInAt: null,
    });
  });

  it("keeps settings preferences across route remounts", () => {
    updateOneLocationControlState(userId, (current) => ({
      ...current,
      backgroundShareEnabled: true,
    }));

    clearOneLocationControlRuntime(userId);

    expect(readOneLocationControlState(userId)).toEqual(
      expect.objectContaining({
        autoShareEnabled: true,
        backgroundShareEnabled: true,
        paused: false,
      }),
    );
  });

  it("pause and automatic-update off both disable background sharing", () => {
    const enabled = updateOneLocationControlState(userId, (current) => ({
      ...current,
      backgroundShareEnabled: true,
    }));
    expect(enabled.backgroundShareEnabled).toBe(true);

    const paused = updateOneLocationControlState(userId, (current) => ({
      ...current,
      paused: true,
    }));
    expect(paused.backgroundShareEnabled).toBe(false);

    const automaticOff = updateOneLocationControlState(userId, (current) => ({
      ...current,
      paused: false,
      autoShareEnabled: false,
      backgroundShareEnabled: true,
    }));
    expect(automaticOff.backgroundShareEnabled).toBe(false);
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

  it("never retains a nearby timestamp after presence ends", () => {
    const state = updateOneLocationControlState(userId, (current) => ({
      ...current,
      nearbyPresenceActive: false,
      nearbyCheckedInAt: "stale-value",
    }));

    expect(state.nearbyCheckedInAt).toBeNull();
  });
});
