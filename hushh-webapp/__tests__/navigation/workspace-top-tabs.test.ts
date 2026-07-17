import { describe, expect, it } from "vitest";

import { resolveWorkspaceTopTabs } from "@/lib/navigation/workspace-top-tabs";
import { ROUTES } from "@/lib/navigation/routes";

describe("workspace top tabs", () => {
  it("keeps Finance workspace controls in the bottom shell", () => {
    expect(resolveWorkspaceTopTabs(ROUTES.KAI_ANALYSIS)).toBeNull();
  });

  it("keeps RIA workspace controls in the bottom shell", () => {
    expect(resolveWorkspaceTopTabs(ROUTES.RIA_PICKS)).toBeNull();
  });

  it("does not add workspace tabs to global utility routes", () => {
    expect(resolveWorkspaceTopTabs(ROUTES.PROFILE)).toBeNull();
    expect(resolveWorkspaceTopTabs(ROUTES.CONNECT)).toBeNull();
  });
});
