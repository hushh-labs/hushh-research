import { describe, expect, it } from "vitest";

import {
  INVESTOR_KAI_ACTION_REGISTRY,
  getInvestorKaiActionByKaiCommand,
  getInvestorKaiActionByVoiceToolCall,
  listInvestorKaiActions,
  resolveInvestorKaiActionWiring,
} from "@/lib/voice/investor-kai-action-registry";

describe("investor-kai-action-registry", () => {
  it("enforces unique action ids", () => {
    const ids = INVESTOR_KAI_ACTION_REGISTRY.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("enforces required schema fields for every action", () => {
    for (const action of INVESTOR_KAI_ACTION_REGISTRY) {
      expect(action.id.trim().length).toBeGreaterThan(0);
      expect(action.label.trim().length).toBeGreaterThan(0);
      expect(action.meaning.trim().length).toBeGreaterThan(0);

      expect(action.scope.routes.length).toBeGreaterThan(0);
      expect(action.scope.screens.length).toBeGreaterThan(0);
      if (action.scope.hiddenNavigable) {
        expect(action.scope.navigationPrerequisites.length).toBeGreaterThan(0);
      }

      expect(action.trigger.supported.length).toBeGreaterThan(0);
      expect(action.trigger.supported.includes(action.trigger.primary)).toBe(true);

      expect(action.expectedEffects.stateChanges.length).toBeGreaterThan(0);
      expect(action.mapReferences.length).toBeGreaterThan(0);

      if (action.risk.executionPolicy === "manual_only") {
        expect(["medium", "high"]).toContain(action.risk.level);
      }
    }
  });

  it("resolves all wired actions to known live bindings", () => {
    const unresolvedWired = INVESTOR_KAI_ACTION_REGISTRY.filter(
      (action) => action.wiring.status === "wired"
    )
      .map((action) => ({
        action,
        resolution: resolveInvestorKaiActionWiring(action),
      }))
      .filter((result) => !result.resolution.resolvable);

    expect(unresolvedWired).toEqual([]);
  });

  it("exposes command and voice lookup for wired map entries", () => {
    const commandAction = getInvestorKaiActionByKaiCommand("dashboard");
    expect(commandAction?.id).toBe("nav.kai_dashboard");
    expect(commandAction?.wiring.status).toBe("wired");

    const voiceAction = getInvestorKaiActionByVoiceToolCall({
      tool_name: "resume_active_analysis",
      args: {},
    });
    expect(voiceAction?.id).toBe("analysis.resume_active");
    expect(voiceAction?.wiring.status).toBe("wired");
  });

  it("marks legacy/dead actions explicitly", () => {
    const deadActions = listInvestorKaiActions().filter(
      (action) => action.wiring.status === "dead"
    );
    expect(deadActions.length).toBeGreaterThan(0);
    expect(deadActions.some((action) => action.id === "command.optimize_legacy")).toBe(true);
  });
});
