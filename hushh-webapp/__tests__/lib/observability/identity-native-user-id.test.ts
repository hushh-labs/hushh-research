import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platform: "ios" as "ios" | "android",
  setUserId: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => mocks.platform,
  },
}));

vi.mock("@capacitor-firebase/analytics", () => ({
  FirebaseAnalytics: { setUserId: mocks.setUserId },
}));

vi.mock("@/lib/observability/env", () => ({
  resolveAnalyticsMeasurementId: () => "",
}));

async function loadIdentity() {
  vi.resetModules();
  return import("@/lib/observability/identity");
}

describe.each(["ios", "android"] as const)(
  "%s Firebase analytics User-ID binding",
  (platform) => {
    beforeEach(() => {
      mocks.platform = platform;
      mocks.setUserId.mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("binds the same privacy-safe account identity contract", async () => {
      const { setObservabilityUserId } = await loadIdentity();
      await setObservabilityUserId("shared-firebase-uid");

      expect(mocks.setUserId).toHaveBeenCalledTimes(1);
      expect(mocks.setUserId).toHaveBeenCalledWith({
        userId: expect.stringMatching(/^[0-9a-f]{32}$/),
      });
      expect(mocks.setUserId.mock.calls[0][0].userId).not.toBe(
        "shared-firebase-uid"
      );
    });

    it("clears the bound identity on sign-out", async () => {
      const { setObservabilityUserId } = await loadIdentity();
      await setObservabilityUserId(null);

      expect(mocks.setUserId).toHaveBeenCalledWith({ userId: null });
    });
  }
);
