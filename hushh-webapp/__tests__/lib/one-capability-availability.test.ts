import { describe, expect, it } from "vitest";

import { getAgentSections } from "@/lib/navigation/agent-sections";
import {
  getOneCapability,
  isOneCapabilityEnabled,
  ONE_SETUP_CAPABILITIES,
} from "@/lib/onboarding/one-capabilities";

describe("One capability availability", () => {
  it("enables Gmail and Calendar as first-class One agents", () => {
    const gmail = getOneCapability("gmail");
    const calendar = getOneCapability("calendar");

    expect(gmail).toMatchObject({
      agentId: "agent_gmail",
    });
    expect(calendar).toMatchObject({
      agentId: "agent_calendar",
    });
    expect(isOneCapabilityEnabled(gmail)).toBe(true);
    expect(isOneCapabilityEnabled("gmail")).toBe(true);
    expect(isOneCapabilityEnabled(calendar)).toBe(true);
  });

  it("includes Gmail and Calendar in setup and the agent selector", () => {
    expect(ONE_SETUP_CAPABILITIES.map((capability) => capability.id)).toEqual([
      "gmail",
      "calendar",
      "location",
      "email",
      "finance",
      "ria",
      "connected-systems",
    ]);
    expect(getAgentSections().map((section) => section.id)).toEqual(
      expect.arrayContaining(["gmail", "calendar"]),
    );
  });
});
