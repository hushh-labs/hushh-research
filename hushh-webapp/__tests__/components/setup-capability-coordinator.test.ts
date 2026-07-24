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

  it("keeps a finished Location setup on the hub while overall setup is still incomplete", () => {
    // The master "Finish setup" (which requires Connections) is not done yet,
    // so finishing Location must return the user to /one/setup — not jump
    // straight into the Location workspace.
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "root",
        hasExplicitIncompleteSetup: true,
        kind: "finish",
      }),
    ).toBe("/one/setup");
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "root",
        hasExplicitIncompleteSetup: true,
        kind: "skip",
      }),
    ).toBe("/one/setup");
  });

  it("lands a finished Location setup on its workspace once overall setup is resolved", () => {
    // Overall setup is complete (Finish setup done), so finishing Location may
    // hand off directly to the Location workspace.
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "root",
        hasExplicitIncompleteSetup: false,
        kind: "finish",
      }),
    ).toBe("/one/location");
    // Skip never widens into the workspace shortcut.
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "root",
        hasExplicitIncompleteSetup: false,
        kind: "skip",
      }),
    ).toBe("/one/location");
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

