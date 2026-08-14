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
      autoApproveRequestsEnabled: false,
      autoApproveEnabledAt: null,
      paused: true,
      selfPreviewEnabled: false,
      nearbyPresenceActive: false,
      nearbyCheckedInAt: null,
    });
  });

  it("keeps both settings preferences across route remounts", () => {
    updateOneLocationControlState(userId, (current) => ({
      ...current,
      autoApproveRequestsEnabled: true,
      paused: true,
    }));

    clearOneLocationControlRuntime(userId);

    expect(readOneLocationControlState(userId)).toEqual(
      expect.objectContaining({
        autoApproveRequestsEnabled: true,
        paused: true,
      }),
    );
  });

  describe("auto-approving location requests", () => {
    it("is off until someone turns it on", () => {
      // Approving a location request is consent. A default may not give it.
      expect(readOneLocationControlState(userId)).toEqual(
        expect.objectContaining({
          autoApproveRequestsEnabled: false,
          autoApproveEnabledAt: null,
        }),
      );
    });

    it("records when it was switched on, so earlier requests stay out of scope", () => {
      const before = Date.now();
      const state = updateOneLocationControlState(userId, (current) => ({
        ...current,
        autoApproveRequestsEnabled: true,
      }));

      expect(state.autoApproveEnabledAt).not.toBeNull();
      expect(Date.parse(state.autoApproveEnabledAt ?? "")).toBeGreaterThanOrEqual(
        before,
      );
    });

    it("does not move the watermark when something unrelated changes", () => {
      // Restamping on every write would keep pushing the boundary forward, so
      // a request that arrived a moment ago would fall behind it and never
      // auto-approve -- the setting would look switched on and do nothing.
      const enabled = updateOneLocationControlState(userId, (current) => ({
        ...current,
        autoApproveRequestsEnabled: true,
      }));

      const afterPause = updateOneLocationControlState(userId, (current) => ({
        ...current,
        paused: true,
      }));

      expect(afterPause.autoApproveEnabledAt).toBe(enabled.autoApproveEnabledAt);
    });

    it("drops the watermark when switched off, and takes a fresh one when switched on again", () => {
      // Real time is used deliberately here: back-to-back updates land in the
      // same millisecond, so two genuinely separate switch-ons would produce
      // the same ISO string and the assertion would pass or fail on timing
      // rather than on behaviour.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-08-14T09:00:00.000Z"));
        const first = updateOneLocationControlState(userId, (current) => ({
          ...current,
          autoApproveRequestsEnabled: true,
        }));
        expect(first.autoApproveEnabledAt).toBe("2026-08-14T09:00:00.000Z");

        const off = updateOneLocationControlState(userId, (current) => ({
          ...current,
          autoApproveRequestsEnabled: false,
        }));
        expect(off.autoApproveEnabledAt).toBeNull();

        vi.setSystemTime(new Date("2026-08-14T11:30:00.000Z"));
        const again = updateOneLocationControlState(userId, (current) => ({
          ...current,
          autoApproveRequestsEnabled: true,
        }));
        // A second switch-on is a fresh decision: whoever asked during the gap
        // must not be swept up by it.
        expect(again.autoApproveEnabledAt).toBe("2026-08-14T11:30:00.000Z");
      } finally {
        vi.useRealTimers();
      }
    });

    it("survives a route remount with its watermark intact", () => {
      const enabled = updateOneLocationControlState(userId, (current) => ({
        ...current,
        autoApproveRequestsEnabled: true,
      }));

      clearOneLocationControlRuntime(userId);

      expect(readOneLocationControlState(userId).autoApproveEnabledAt).toBe(
        enabled.autoApproveEnabledAt,
      );
    });
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
