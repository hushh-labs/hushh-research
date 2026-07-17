import { describe, expect, it } from "vitest";

import { getAgentSections } from "@/lib/navigation/agent-sections";
import {
  getOneCapability,
  isOneCapabilityEnabled,
  ONE_SETUP_CAPABILITIES,
} from "@/lib/onboarding/one-capabilities";

describe("One capability availability", () => {
  it("pauses Gmail only at the One presentation boundary", () => {
    const gmail = getOneCapability("gmail");

    expect(gmail).toMatchObject({
      agentId: "agent_gmail",
      availability: "paused",
    });
    expect(isOneCapabilityEnabled(gmail)).toBe(false);
    expect(isOneCapabilityEnabled("gmail")).toBe(false);
  });

  it("excludes paused capabilities from setup and the agent selector", () => {
    expect(ONE_SETUP_CAPABILITIES.map((capability) => capability.id)).toEqual([
      "location",
      "email",
      "finance",
      "ria",
      "connected-systems",
    ]);
    expect(getAgentSections().map((section) => section.id)).not.toContain("gmail");
  });
});
