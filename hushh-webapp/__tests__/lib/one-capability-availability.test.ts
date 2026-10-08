import { afterEach, describe, expect, it, vi } from "vitest";

import { getAgentSections } from "@/lib/navigation/agent-sections";
import {
  getOneCapability,
  isOneCapabilityEnabled,
  ONE_SETUP_CAPABILITIES,
} from "@/lib/onboarding/one-capabilities";

describe("One capability availability", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["development", "uat", "production"])(
    "matches Files discovery to its authored development-only rollout in %s",
    (environment) => {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", environment);
      expect(getOneCapability("files")).toMatchObject({
        agentId: "agent_files",
        href: "/one/files",
        requiresVault: true,
      });
      expect(isOneCapabilityEnabled("files")).toBe(environment === "development");
      const sections = getAgentSections().filter((section) => section.id === "files");
      expect(sections).toHaveLength(environment === "development" ? 1 : 0);
      if (environment === "development") {
        expect(sections[0]).toMatchObject({
          screenId: "one_files",
          controlId: "top_agent_section_files",
          href: "/one/files",
        });
      }
    },
  );

  it("enables Gmail and Calendar as first-class One agents", () => {
    const gmail = getOneCapability("gmail");
    const calendar = getOneCapability("calendar");

    expect(gmail).toMatchObject({
      agentId: "agent_email",
    });
    expect(calendar).toMatchObject({
      agentId: "agent_calendar",
    });
    expect(isOneCapabilityEnabled(gmail)).toBe(true);
    expect(isOneCapabilityEnabled("gmail")).toBe(true);
    expect(isOneCapabilityEnabled(calendar)).toBe(true);
  });

  it("keeps Gmail and Calendar visible while hiding standalone KYC and local-only CRM", () => {
    expect(ONE_SETUP_CAPABILITIES.map((capability) => capability.id)).toEqual([
      "gmail",
      "calendar",
      "location",
      "email",
      "finance",
      "ria",
    ]);
    expect(getAgentSections().map((section) => section.id)).toEqual(
      expect.arrayContaining(["gmail", "calendar"]),
    );
    expect(getOneCapability("email")).toMatchObject({
      agentId: "agent_kyc",
      isVisibleOnRoster: false,
    });
    expect(getAgentSections().map((section) => section.id)).not.toContain(
      "email",
    );
    expect(getAgentSections().map((section) => section.id)).not.toContain(
      "connected-systems",
    );
  });
});
