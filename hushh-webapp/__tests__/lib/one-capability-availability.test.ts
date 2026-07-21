import { afterEach, describe, expect, it, vi } from "vitest";

import { getAgentSections } from "@/lib/navigation/agent-sections";
import {
  getOneCapability,
  isOneCapabilityEnabled,
  ONE_SETUP_CAPABILITIES,
} from "@/lib/onboarding/one-capabilities";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("One capability availability", () => {
  it("keeps Gmail enabled through the shared One presentation boundary", () => {
    const gmail = getOneCapability("gmail");

    expect(gmail).toMatchObject({
      agentId: "agent_gmail",
    });
    expect(gmail?.availability).not.toBe("paused");
    expect(isOneCapabilityEnabled(gmail)).toBe(true);
    expect(isOneCapabilityEnabled("gmail")).toBe(true);
  });

  it("includes enabled Gmail in setup and the agent selector", () => {
    expect(ONE_SETUP_CAPABILITIES.map((capability) => capability.id)).toEqual([
      "gmail",
      "location",
      "email",
      "finance",
      "ria",
      "connected-systems",
    ]);
    expect(getAgentSections().map((section) => section.id)).toContain("gmail");
  });

  it("honors the Gmail integration switch at the capability boundary", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_GMAIL_INTEGRATION_ENABLED", "paused");

    const capabilities = await import("@/lib/onboarding/one-capabilities");

    expect(capabilities.isOneCapabilityEnabled("gmail")).toBe(false);
    expect(
      capabilities.ONE_SETUP_CAPABILITIES.map((capability) => capability.id),
    ).not.toContain("gmail");
  });
});
