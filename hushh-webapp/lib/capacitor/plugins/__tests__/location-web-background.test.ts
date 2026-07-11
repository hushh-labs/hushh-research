import { describe, expect, it } from "vitest";
import { HushhLocationWeb } from "@/lib/capacitor/plugins/location-web";

describe("HushhLocationWeb background sharing", () => {
  it("reports background sharing as unsupported on web", async () => {
    const web = new HushhLocationWeb();
    const result = await web.startBackgroundShare({
      vaultOwnerToken: "t",
      backendBaseUrl: "https://api.example.com",
      grants: [],
      minMoveMeters: 25,
      minIntervalMs: 8000,
    });
    expect(result).toEqual({ started: false, reason: "unsupported-on-web" });
  });

  it("stopBackgroundShare resolves as a no-op on web", async () => {
    const web = new HushhLocationWeb();
    await expect(web.stopBackgroundShare()).resolves.toBeUndefined();
  });
});
