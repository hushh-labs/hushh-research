import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import { describe, expect, it } from "vitest";

describe("onboarding capability copy", () => {
  it("exposes setup copy for Gmail when the capability is enabled", () => {
    expect(getCapabilitySetupCopy("gmail")).toMatchObject({
      setupTitle: "Connect Gmail",
      actionLabel: "Connect Gmail",
      resumeActionLabel: "Finish Gmail",
    });
  });

  it("frames location as a trusted-person sharing choice", () => {
    const location = getCapabilitySetupCopy("location");

    expect(location?.setupTitle).toBe("Set up location");
    expect(location?.setupBlurb).toContain("trusted people you choose");
  });

  it("frames KYC as a simple drafting toggle", () => {
    const email = getCapabilitySetupCopy("email");

    expect(email).toMatchObject({
      setupTitle: "KYC",
      actionLabel: "Set up KYC",
      resumeActionLabel: "Finish KYC",
    });
    expect(email?.setupBlurb).toContain("one@hushh.ai");
  });

  it("uses the canonical CRM name for record setup", () => {
    const connectedSystems = getCapabilitySetupCopy("connected-systems");

    expect(connectedSystems).toMatchObject({
      setupTitle: "CRM",
      actionLabel: "Set up CRM",
    });
    expect(connectedSystems?.setupBlurb).toContain("verified identity");
  });
});
