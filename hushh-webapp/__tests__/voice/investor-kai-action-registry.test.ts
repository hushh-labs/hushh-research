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

  it("exposes command and voice lookup for wired map entries", () => {
    const commandAction = getInvestorKaiActionByKaiCommand("dashboard");
    expect(commandAction?.id).toBe("route.kai_dashboard");
    expect(commandAction?.wiring.status).toBe("wired");

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

  it("marks legacy/dead actions explicitly", () => {
    const deadActions = listInvestorKaiActions().filter(
      (action) => action.wiring.status === "dead"
    );
    expect(deadActions.length).toBeGreaterThan(0);
    expect(deadActions.some((action) => action.id === "analysis.open_transcript_tab_legacy")).toBe(
      true
    );
  });

  it("keeps Gmail and support backend effect paths aligned with live profile APIs", () => {
    expect(
      INVESTOR_KAI_ACTION_REGISTRY.find((action) => action.id === "route.profile_receipts")
        ?.expectedEffects.backendEffects
    ).toEqual([
      {
        api: "GET /api/kai/gmail/status/{user_id} (proxied)",
        effect: "Reads Gmail connector status on mount.",
      },
      {
        api: "GET /api/kai/gmail/receipts/{user_id} (proxied)",
        effect: "Reads paginated receipt items.",
      },
    ]);

    expect(
      INVESTOR_KAI_ACTION_REGISTRY.find((action) => action.id === "profile.gmail.connect")
        ?.expectedEffects.backendEffects
    ).toEqual([
      {
        api: "POST /api/kai/gmail/connect/start (proxied)",
        effect: "Generates OAuth authorize URL and state nonce.",
      },
    ]);

    expect(
      INVESTOR_KAI_ACTION_REGISTRY.find((action) => action.id === "profile.gmail.sync_now")
        ?.expectedEffects.backendEffects
    ).toEqual([
      {
        api: "POST /api/kai/gmail/sync (proxied)",
        effect: "Queues sync job.",
      },
      {
        api: "GET /api/kai/gmail/sync/{run_id} (proxied)",
        effect: "Polls sync run status.",
      },
    ]);

    expect(
      INVESTOR_KAI_ACTION_REGISTRY.find((action) => action.id === "profile.receipts_memory.preview")
    ).toBeUndefined();
    expect(
      INVESTOR_KAI_ACTION_REGISTRY.find((action) => action.id === "profile.receipts_memory.save")
    ).toBeUndefined();

    expect(
      INVESTOR_KAI_ACTION_REGISTRY.find((action) => action.id === "profile.gmail.disconnect")
        ?.expectedEffects.backendEffects
    ).toEqual([
      {
        api: "POST /api/kai/gmail/disconnect (proxied)",
        effect: "Revokes connector state in backend.",
      },
    ]);

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

  it("lists Gmail actions without exposing localhost-only PKM Lab actions", () => {
    const gmailActions = listInvestorKaiActionsForSurface({
      screen: "gmail",
      href: "/one/gmail",
      pathname: "/one/gmail",
    }).map((action) => action.id);

    expect(gmailActions).toEqual(
      expect.arrayContaining([
        "profile.gmail.connect",
        "profile.gmail.sync_now",
        "profile.gmail.disconnect",
      ])
    );

    const pkmActions = listInvestorKaiActionsForSurface({
      screen: "profile_pkm_agent_lab",
      href: "/profile/pkm-agent-lab",
      pathname: "/profile/pkm-agent-lab",
    }).map((action) => action.id);

    expect(pkmActions).not.toContain("profile.pkm.preview_capture");
    expect(pkmActions).not.toContain("profile.pkm.save_capture");
  });
});
