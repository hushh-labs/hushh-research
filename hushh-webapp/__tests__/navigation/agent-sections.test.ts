import { describe, expect, it } from "vitest";

import {
  getAgentSection,
  getAgentSections,
  resolveAgentSectionForPath,
} from "@/lib/navigation/agent-sections";
import { ROUTES } from "@/lib/navigation/routes";

describe("agent sections", () => {
  it("lists One first while preserving the internal root action id", () => {
    const sections = getAgentSections();

    expect(sections[0]).toMatchObject({
      id: "agents",
      label: "One",
      href: ROUTES.ONE_HOME,
      voiceRouteActionId: "route.one_agents",
    });
    expect(resolveAgentSectionForPath(ROUTES.ONE_HOME)?.label).toBe("One");
  });

  it("exposes Finance and RIA as standalone adjacent top-level agents", () => {
    const sections = getAgentSections();
    const ids = sections.map((section) => section.id);

    expect(ids).toContain("finance");
    expect(ids).toContain("ria");

    // The two finance personas stay adjacent but standalone (Kai is internal
    // naming only, never a surfaced product agent).
    expect(ids.indexOf("ria")).toBe(ids.indexOf("finance") + 1);

    expect(getAgentSection("finance")?.label).toBe("Finance");
    expect(getAgentSection("ria")?.label).toBe("RIA");
  });

  it("routes the RIA agent to the RIA workspace with the ria nav scope", () => {
    const ria = getAgentSection("ria");
    expect(ria).not.toBeNull();
    expect(ria?.href).toBe(ROUTES.RIA_HOME);
    expect(ria?.bottomNavScope).toBe("ria");
    expect(ria?.routeFamily).toBe("ria");
    expect(ria?.voiceRouteActionId).toBe("route.ria_home");
  });

  it("resolves RIA workspace paths back to the RIA agent", () => {
    expect(resolveAgentSectionForPath(ROUTES.RIA_HOME)?.id).toBe("ria");
    expect(resolveAgentSectionForPath(`${ROUTES.RIA_PICKS}`)?.id).toBe("ria");
  });

  it("keeps the Finance agent on the Kai home route (internal naming)", () => {
    const finance = getAgentSection("finance");
    expect(finance?.href).toBe(ROUTES.KAI_HOME);
    expect(finance?.bottomNavScope).toBe("investor");
    expect(finance?.label).toBe("Finance");
  });

  it("keeps Finance selected throughout its onboarding workspace", () => {
    expect(resolveAgentSectionForPath(ROUTES.ONE_SETUP_FINANCE)?.id).toBe("finance");
    expect(resolveAgentSectionForPath(ROUTES.ONE_SETUP_FINANCE_IMPORT)?.id).toBe("finance");
    expect(resolveAgentSectionForPath(ROUTES.KAI_PLAID_OAUTH_RETURN)?.id).toBe("finance");
  });
});
