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

  it("uses human drafting copy for the email capability and names the invocation address", () => {
    const email = getCapabilitySetupCopy("email");

    // The user-facing surface must not leak the internal "KYC" term.
    expect(email).toMatchObject({
      setupTitle: "Let One draft for you",
      actionLabel: "Set up drafting",
      resumeActionLabel: "Finish drafting setup",
    });
    expect(email?.setupTitle).not.toContain("KYC");
    expect(email?.actionLabel).not.toContain("KYC");
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
