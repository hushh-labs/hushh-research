import { describe, expect, it } from "vitest";

import {
  resolveSetupCapabilityJourneyMode,
  resolveSetupCapabilityReturnTarget,
  resolveSetupCapabilityTerminalScreen,
  resolveSetupCapabilityTerminalTarget,
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

  it("lands a finished Location setup on its workspace without widening skip", () => {
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "root",
        hasExplicitIncompleteSetup: true,
        kind: "finish",
      }),
    ).toBe("/one/location");
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "root",
        hasExplicitIncompleteSetup: true,
        kind: "skip",
      }),
    ).toBe("/one/setup");
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "individual",
        hasExplicitIncompleteSetup: false,
        kind: "finish",
      }),
    ).toBe("/one");
    expect(resolveSetupCapabilityTerminalScreen("/one/location")).toBe(
      "one_location",
    );
    expect(resolveSetupCapabilityTerminalScreen("/one/setup")).toBe(
      "one_setup_hub",
    );
  });
});
