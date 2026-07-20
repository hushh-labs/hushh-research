import { describe, expect, it } from "vitest";

import {
  resolveSetupCapabilityJourneyMode,
  resolveSetupCapabilityReturnTarget,
} from "@/components/onboarding/setup/setup-capability-coordinator";

describe("setup capability journey settlement", () => {
  it("derives root versus individual re-entry only from fresh setup resolution", () => {
    expect(resolveSetupCapabilityJourneyMode("auto", false)).toBe("root");
    expect(resolveSetupCapabilityJourneyMode("auto", true)).toBe("individual");
    expect(resolveSetupCapabilityJourneyMode("root", true)).toBe("root");
    expect(resolveSetupCapabilityJourneyMode("individual", false)).toBe(
      "individual",
    );
  });

  it("returns root setup to the hub and individual setup directly to One", () => {
    expect(
      resolveSetupCapabilityReturnTarget({
        capabilityId: "finance",
        journeyMode: "root",
        hasExplicitIncompleteSetup: true,
      }),
    ).toBe("/one/setup");
    expect(
      resolveSetupCapabilityReturnTarget({
        capabilityId: "finance",
        journeyMode: "individual",
        hasExplicitIncompleteSetup: false,
      }),
    ).toBe("/one");
  });
});
