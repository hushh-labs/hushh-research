import { describe, expect, it } from "vitest";

import {
  ONE_SETUP_CAPABILITY_IDS,
  normalizeOneSetupCapabilityId,
} from "@/lib/onboarding/setup-capability-ids";

describe("setup capability identity contract", () => {
  it("keeps one canonical six-capability order", () => {
    expect(ONE_SETUP_CAPABILITY_IDS).toEqual([
      "gmail",
      "location",
      "email",
      "finance",
      "ria",
      "connected-systems",
    ]);
  });

  it("contains stale durable capability values to the setup hub", () => {
    expect(normalizeOneSetupCapabilityId(" gmail ")).toBe("gmail");
    expect(normalizeOneSetupCapabilityId("pkm")).toBeNull();
    expect(normalizeOneSetupCapabilityId("consent")).toBeNull();
    expect(normalizeOneSetupCapabilityId("marketplace")).toBeNull();
    expect(normalizeOneSetupCapabilityId(null)).toBeNull();
  });
});
