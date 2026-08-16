import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
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
    expect(location?.setupBlurb).toBe("Share where you are, when you want.");
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
    expect(email?.setupBlurb).toBe("One drafts the replies. You approve.");
  });

  it("frames CRM setup as a connection the person approves", () => {
    const connectedSystems = getCapabilitySetupCopy("connected-systems");

    expect(connectedSystems).toMatchObject({
      setupTitle: "Connect your CRM",
      actionLabel: "Set up CRM",
    });
    expect(connectedSystems?.setupBlurb).toBe("One finds your record. You approve.");
  });

  it("keeps every setup row short enough to read at a glance", () => {
    // Long value-first sentences were what made this list feel like work.
    // Nothing a person scans on the hub runs past a single short line.
    for (const id of [
      "gmail",
      "calendar",
      "location",
      "email",
      "finance",
      "ria",
      "connected-systems",
    ]) {
      const copy = getCapabilitySetupCopy(id);
      expect(copy, id).toBeDefined();
      expect(copy!.setupTitle.split(" ").length, `${id} title`).toBeLessThanOrEqual(5);
      expect(copy!.setupBlurb.split(" ").length, `${id} blurb`).toBeLessThanOrEqual(8);
    }
  });
});
