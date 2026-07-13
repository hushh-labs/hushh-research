import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import { describe, expect, it } from "vitest";

describe("onboarding capability copy", () => {
  it("explains Gmail's affinity and recent-interaction memory purpose", () => {
    const gmail = getCapabilitySetupCopy("gmail");

    expect(gmail?.setupBlurb).toContain("brands you care about");
    expect(gmail?.setupBlurb).toContain("recent interactions");
  });

  it("frames location as a trusted-person sharing choice", () => {
    const location = getCapabilitySetupCopy("location");

    expect(location?.setupTitle).toBe("Set up location");
    expect(location?.setupBlurb).toContain("trusted people you choose");
  });

  it("uses KYC for the email capability and names the invocation address", () => {
    const email = getCapabilitySetupCopy("email");

    expect(email).toMatchObject({
      setupTitle: "KYC",
      actionLabel: "Set up KYC",
      resumeActionLabel: "Finish KYC",
    });
    expect(email?.setupBlurb).toContain("one@hushh.ai");
  });

  it("frames connected systems as a record-linking decision", () => {
    const connectedSystems = getCapabilitySetupCopy("connected-systems");

    expect(connectedSystems).toMatchObject({
      setupTitle: "Link your record to external systems",
      actionLabel: "Link your record",
    });
    expect(connectedSystems?.setupBlurb).toContain("your approval");
  });
});
