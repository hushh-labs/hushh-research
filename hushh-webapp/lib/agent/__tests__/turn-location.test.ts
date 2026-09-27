import { beforeEach, describe, expect, it, vi } from "vitest";

const bus = vi.hoisted(() => ({
  syncPermission: vi.fn(),
  getState: vi.fn(),
  ensure: vi.fn(),
}));

vi.mock("@/lib/one-location/location-bus", () => ({ LocationBus: bus }));

import { resolveTurnLocation } from "@/lib/agent/turn-location";

const PRECISE = { latitude: 37.774929, longitude: -122.419416, accuracyM: 5 };

describe("resolveTurnLocation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    bus.getState.mockReturnValue({ snapshot: null });
  });

  it("sends only a ~1 km position, and only when permission is already granted", async () => {
    bus.syncPermission.mockResolvedValue("granted");
    bus.getState.mockReturnValue({
      snapshot: { ...PRECISE, capturedAt: new Date().toISOString() },
    });

    expect(await resolveTurnLocation()).toEqual({
      status: "available",
      latitude: 37.77,
      longitude: -122.42,
    });
    expect(bus.ensure).not.toHaveBeenCalled();
  });

  it.each([
    ["denied", "denied"],
    ["restricted", "denied"],
    ["prompt", "not_granted"],
    ["unavailable", "unavailable"],
    [null, "unavailable"],
  ])("never reads a position or prompts when permission is %s", async (permission, status) => {
    bus.syncPermission.mockResolvedValue(permission);

    expect(await resolveTurnLocation()).toEqual({ status });
    expect(bus.ensure).not.toHaveBeenCalled();
  });
});
