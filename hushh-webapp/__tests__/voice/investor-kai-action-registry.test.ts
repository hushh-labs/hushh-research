import { describe, expect, it } from "vitest";

import {
  INVESTOR_KAI_ACTION_REGISTRY,
  getInvestorKaiActionById,
  getInvestorKaiActionByKaiCommand,
  getInvestorKaiActionByVoiceToolCall,
  listInvestorKaiActionsForSurface,
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

  it("keeps route actions out of the legacy command binding while resolving generated voice tools", () => {
    // Finance navigation is a generated route action, not an independently
    // executable command-bar binding.
    expect(getInvestorKaiActionByKaiCommand("dashboard")).toBeNull();
    expect(getInvestorKaiActionById("route.kai_dashboard")?.wiring).toMatchObject({
      status: "wired",
      binding: { kind: "route", href: "/one/kai?tab=portfolio" },
    });

    const voiceAction = getInvestorKaiActionByVoiceToolCall({
      tool_name: "resume_active_analysis",
      args: {},
    });
    expect(voiceAction?.id).toBe("analysis.resume_active");
    expect(voiceAction?.wiring.status).toBe("wired");

    const removedPkmPreviewAction = getInvestorKaiActionByVoiceToolCall({
      tool_name: "capture_pkm_memory",
      args: {
        message: "I prefer quiet hotel rooms away from elevators.",
        mode: "preview",
      },
    });
    expect(removedPkmPreviewAction).toBeNull();

    expect(getInvestorKaiActionById("profile.pkm.save_capture")).toBeNull();
  });

  it("contains no dead action contracts", () => {
    const deadActions = listInvestorKaiActions().filter(
      (action) => action.wiring.status === "dead"
    );
    expect(deadActions).toEqual([]);
  });

  it("keeps paused Gmail out of generated runtime discovery while retaining support effects", () => {
    for (const actionId of [
      "route.profile_receipts",
      "profile.gmail.connect",
      "profile.gmail.sync_now",
      "profile.gmail.disconnect",
      "profile.receipts_memory.preview",
      "profile.receipts_memory.save",
    ]) {
      expect(INVESTOR_KAI_ACTION_REGISTRY.find((action) => action.id === actionId)).toBeUndefined();
    }

    expect(
      INVESTOR_KAI_ACTION_REGISTRY.find((action) => action.id === "profile.support.submit_message")
        ?.expectedEffects.backendEffects
    ).toEqual([
      {
        api: "POST /api/kai/support/message (proxied)",
        effect: "Routes support payload to support_email_service.",
      },
    ]);
  });

  it("keeps Gmail and localhost-only PKM Lab actions out of generated surface discovery", () => {
    const gmailActions = listInvestorKaiActionsForSurface({
      screen: "gmail",
      href: "/one/gmail",
      pathname: "/one/gmail",
    }).map((action) => action.id);

    expect(gmailActions).toEqual([]);

    const pkmActions = listInvestorKaiActionsForSurface({
      screen: "profile_pkm_agent_lab",
      href: "/one/profile/pkm-agent-lab",
      pathname: "/one/profile/pkm-agent-lab",
    }).map((action) => action.id);

    expect(pkmActions).not.toContain("profile.pkm.preview_capture");
    expect(pkmActions).not.toContain("profile.pkm.save_capture");
  });
});
