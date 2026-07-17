import { describe, expect, it } from "vitest";

import { resolveWorkspaceTopTabs } from "@/lib/navigation/workspace-top-tabs";
import { ROUTES } from "@/lib/navigation/routes";

describe("workspace top tabs", () => {
  it("projects Finance tabs above finance routes without Connect", () => {
    expect(resolveWorkspaceTopTabs(ROUTES.KAI_ANALYSIS)).toMatchObject({
      label: "Finance",
      activeId: "analysis",
      tabs: [
        { id: "market" },
        { id: "dashboard" },
        { id: "analysis" },
      ],
    });
  });

  it("projects RIA tabs above RIA routes without Connect", () => {
    expect(resolveWorkspaceTopTabs(ROUTES.RIA_PICKS)).toMatchObject({
      label: "RIA",
      activeId: "picks",
      tabs: [{ id: "home" }, { id: "clients" }, { id: "picks" }],
    });
  });

  it("does not add workspace tabs to global utility routes", () => {
    expect(resolveWorkspaceTopTabs(ROUTES.PROFILE)).toBeNull();
    expect(resolveWorkspaceTopTabs(ROUTES.CONNECT)).toBeNull();
  });
});
