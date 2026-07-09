import { describe, expect, it, vi, beforeEach } from "vitest";

const start = vi.fn().mockResolvedValue({ started: true });
const stop = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/capacitor", () => ({
  HushhLocation: {
    startBackgroundShare: (s: unknown) => start(s),
    stopBackgroundShare: () => stop(),
  },
}));

import { syncBackgroundShare } from "@/lib/one-location/background-share-runtime";

describe("syncBackgroundShare", () => {
  beforeEach(() => {
    start.mockClear();
    stop.mockClear();
  });

  it("stops native sharing when the toggle is off", async () => {
    await syncBackgroundShare({ enabled: false, session: null });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("stops native sharing when enabled but no grants remain", async () => {
    await syncBackgroundShare({
      enabled: true,
      session: {
        vaultOwnerToken: "t",
        backendBaseUrl: "https://api",
        grants: [],
        minMoveMeters: 25,
        minIntervalMs: 8000,
      },
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("starts native sharing when enabled with grants", async () => {
    const session = {
      vaultOwnerToken: "t",
      backendBaseUrl: "https://api",
      grants: [
        { grantId: "g1", recipientKeyId: "k1", recipientPublicKeyJwk: {} },
      ],
      minMoveMeters: 25,
      minIntervalMs: 8000,
    };
    await syncBackgroundShare({ enabled: true, session });
    expect(start).toHaveBeenCalledWith(session);
    expect(stop).not.toHaveBeenCalled();
  });
});
