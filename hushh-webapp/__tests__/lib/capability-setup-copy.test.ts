import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import {
  ONE_CAPABILITIES,
  ONE_SETUP_CAPABILITIES,
} from "@/lib/onboarding/one-capabilities";
import { describe, expect, it } from "vitest";

describe("onboarding capability copy", () => {
  it("exposes consent-safe setup copy for Gmail and Calendar", () => {
    expect(getCapabilitySetupCopy("gmail")?.setupTitle).toBe("Connect Gmail");
    expect(getCapabilitySetupCopy("calendar")).toMatchObject({
      setupTitle: "Connect your calendar",
      actionLabel: "Connect Calendar",
      resumeActionLabel: "Finish Calendar",
    });
  });

  it("frames location as a sharing choice the person controls", () => {
    const location = getCapabilitySetupCopy("location");

    expect(location?.setupTitle).toBe("Set up location");
    expect(location?.setupBlurb).toBe("Share only when you choose.");
  });

  it("names the identity-check step in words, not an abbreviation", () => {
    const email = getCapabilitySetupCopy("email");

    // "KYC" survives as the capability id, the route, and the agent lane. It
    // does not survive as the first thing a person reads.
    expect(email).toMatchObject({
      setupTitle: "Identity checks",
      actionLabel: "Set up KYC",
      resumeActionLabel: "Finish KYC",
    });
    expect(email?.setupBlurb).toBe("Verify with your approval.");
  });

  it("omits paused local-only CRM copy from the visible setup catalog", () => {
    expect(getCapabilitySetupCopy("connected-systems")).toBeUndefined();
  });

  it("reuses the same launcher icon and tone registry for setup rows", () => {
    for (const setupCapability of ONE_SETUP_CAPABILITIES) {
      const launcherCapability = ONE_CAPABILITIES.find(
        (candidate) => candidate.id === setupCapability.id,
      );

      expect(launcherCapability, setupCapability.id).toBeDefined();
      expect(setupCapability.icon).toBe(launcherCapability?.icon);
      expect(setupCapability.tone).toBe(launcherCapability?.tone);
    }
  });

  it("keeps every setup row short enough to read at a glance", () => {
    // Long value-first sentences were what made this list feel like work.
    // Nothing a person scans on the hub runs past a single short line.
    for (const { id } of ONE_SETUP_CAPABILITIES) {
      const copy = getCapabilitySetupCopy(id);
      expect(copy, id).toBeDefined();
      expect(
        copy!.setupTitle.split(" ").length,
        `${id} title`,
      ).toBeLessThanOrEqual(5);
      expect(
        copy!.setupBlurb.split(" ").length,
        `${id} blurb`,
      ).toBeLessThanOrEqual(8);
    }
  });
});
