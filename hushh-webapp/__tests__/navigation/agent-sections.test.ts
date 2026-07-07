import { describe, expect, it } from "vitest";

import {
  getAgentSection,
  getAgentSections,
  resolveAgentSectionForPath,
} from "@/lib/navigation/agent-sections";
import { ROUTES } from "@/lib/navigation/routes";

describe("agent sections", () => {
  it("exposes Investor and RIA as standalone adjacent top-level agents", () => {
    const sections = getAgentSections();
    const ids = sections.map((section) => section.id);

    expect(ids).toContain("finance");
    expect(ids).toContain("ria");

    // The two finance personas stay adjacent but standalone (Kai is internal
    // naming only, never a surfaced product agent).
    expect(ids.indexOf("ria")).toBe(ids.indexOf("finance") + 1);

    expect(getAgentSection("finance")?.label).toBe("Investor");
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

  it("keeps the Investor agent on the Kai home route (internal naming)", () => {
    const finance = getAgentSection("finance");
    expect(finance?.href).toBe(ROUTES.KAI_HOME);
    expect(finance?.bottomNavScope).toBe("investor");
    expect(finance?.label).toBe("Investor");
  });
});
