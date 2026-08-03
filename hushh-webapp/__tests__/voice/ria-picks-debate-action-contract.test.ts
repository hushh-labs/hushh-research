import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard for the Debate config sub-view voice action. The debate view
// is a query-param sub-view of Picks (?view=debate), and its voice action is the
// only contract surface that makes it discoverable via One/Kai. If the action is
// dropped or its target drifts, the debate view silently stops being voice- and
// search-reachable even though the route still renders — this test fails loudly
// before that regression can ship.
const contractPath = resolve(
  process.cwd(),
  "app/ria/picks/page.voice-action-contract.json",
);

interface VoiceAction {
  action_id: string;
  execution_policy?: string;
  risk_level?: string;
  guard_ids?: string[];
  control_ids?: string[];
  aliases?: string[];
  search_keywords?: string[];
  reachability?: { routes?: string[]; active_personas?: string[] };
  execution_target?: { status?: string; path?: string; target?: string };
}

describe("RIA Picks debate voice action contract", () => {
  const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
    surface_id: string;
    actions: VoiceAction[];
  };
  const actions = new Map(
    contract.actions.map((action) => [action.action_id, action]),
  );
  const debate = actions.get("ria.picks.open_view_debate");

  it("belongs to the ria_picks surface", () => {
    expect(contract.surface_id).toBe("ria_picks");
  });

  it("declares the debate sub-view action", () => {
    expect(debate).toBeDefined();
  });

  it("routes the debate action to the ?view=debate sub-view", () => {
    expect(debate?.execution_target).toMatchObject({
      status: "wired",
      path: "route",
      target: "/ria/picks?view=debate",
    });
    expect(debate?.reachability?.routes).toContain("/ria/picks?view=debate");
  });

  it("is a low-risk, directly executable navigation", () => {
    expect(debate?.execution_policy).toBe("allow_direct");
    expect(debate?.risk_level).toBe("low");
  });

  it("is guarded by auth + the RIA persona", () => {
    expect(debate?.guard_ids).toEqual(
      expect.arrayContaining(["auth_signed_in", "ria_persona_available"]),
    );
    expect(debate?.reachability?.active_personas).toContain("ria");
  });

  it("binds the debate route tab control", () => {
    expect(debate?.control_ids).toContain("ria_picks_view_debate");
  });

  it("is discoverable by debate-oriented aliases and keywords", () => {
    const haystack = [
      ...(debate?.aliases ?? []),
      ...(debate?.search_keywords ?? []),
    ]
      .join(" ")
      .toLowerCase();
    expect(haystack).toContain("debate");
  });

  it("keeps debate as the only view-based sub-view action (no duplicates)", () => {
    const viewActions = contract.actions.filter((action) =>
      (action.execution_target?.target ?? "").includes("view=debate"),
    );
    expect(viewActions).toHaveLength(1);
  });
});
