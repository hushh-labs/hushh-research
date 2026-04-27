import { describe, expect, it } from "vitest";

import {
  getVoiceActionManifestById,
  listVoiceActionManifestActions,
  VOICE_ACTION_MANIFEST,
} from "@/lib/voice/voice-action-manifest";
import type { InvestorKaiActionDefinition } from "@/lib/voice/investor-kai-action-registry";
import { INVESTOR_KAI_ACTION_REGISTRY } from "@/lib/voice/investor-kai-action-registry";

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function projectExecutionHint(action: InvestorKaiActionDefinition) {
  if (action.wiring.status === "dead") {
    return {
      status: "dead" as const,
      reason: action.wiring.reason,
    };
  }

  if (action.wiring.status === "unwired") {
    return {
      status: "unwired" as const,
      reason: action.wiring.reason,
      intended_handler: action.wiring.intendedHandler,
    };
  }

  const binding = action.wiring.binding;
  if (binding.kind === "kai_command") {
    const params = binding.params
      ? {
          ...(binding.params.requiresSymbol !== undefined
            ? { requires_symbol: binding.params.requiresSymbol }
            : {}),
          ...(binding.params.tab !== undefined ? { tab: binding.params.tab } : {}),
          ...(binding.params.focus !== undefined ? { focus: binding.params.focus } : {}),
        }
      : undefined;
    return {
      status: "wired" as const,
      path: "kai_command" as const,
      target: binding.command,
      ...(params && Object.keys(params).length > 0 ? { params } : {}),
    };
  }

  if (binding.kind === "voice_tool") {
    return {
      status: "wired" as const,
      path: "voice_tool" as const,
      target: binding.toolName,
    };
  }

  return {
    status: "wired" as const,
    path: "route" as const,
    target: binding.href,
    ...(binding.params ? { params: binding.params } : {}),
  };
}

function projectRegistryAction(action: InvestorKaiActionDefinition) {
  return {
    id: action.id,
    label: action.label,
    meaning: action.meaning,
    speaker_persona: action.speakerPersona,
    scope: {
      routes: unique(action.scope.routes),
      screens: [...action.scope.screens],
      hidden_navigable: action.scope.hiddenNavigable,
      navigation_prerequisites: [...action.scope.navigationPrerequisites],
    },
    guard_ids: action.guards.map((guard) => guard.id),
    risk_level: action.risk.level,
    execution_policy: action.risk.executionPolicy,
    execution_hint: projectExecutionHint(action),
    map_references: [...action.mapReferences],
  };
}

describe("voice-action-manifest", () => {
  it("exposes the checked-in neutral manifest with a stable schema version", () => {
    expect(VOICE_ACTION_MANIFEST.schema_version).toBe("kai.voice_action_manifest.v1");
    expect(VOICE_ACTION_MANIFEST.source_registry).toBe(
      "generated from colocated Kai voice/action contracts"
    );
  });

  it("keeps the neutral manifest aligned with the investor action registry projection", () => {
    expect(listVoiceActionManifestActions()).toEqual(
      INVESTOR_KAI_ACTION_REGISTRY.map((action) => projectRegistryAction(action))
    );
  });

  it("supports action id lookups for canonical planner payloads", () => {
    expect(getVoiceActionManifestById("route.profile")).toEqual(
      projectRegistryAction(
        INVESTOR_KAI_ACTION_REGISTRY.find((action) => action.id === "route.profile")!
      )
    );
    expect(getVoiceActionManifestById("missing.action")).toBeNull();
  });

  it("projects RIA navigation while keeping risky RIA mutations guarded", () => {
    const riaManifestActions = listVoiceActionManifestActions().filter(
      (action) => action.id.includes("ria") || action.scope.screens.some((screen) => screen.startsWith("ria_"))
    );

    expect(riaManifestActions.map((action) => action.id)).toEqual(
      expect.arrayContaining([
        "route.ria_home",
        "route.ria_clients",
        "route.ria_picks",
        "ria.picks.open_source_kai",
        "ria.client_workspace.open_access_tab",
        "ria.client_workspace.request_access",
        "marketplace.ria.request_advisory",
      ])
    );
    expect(getVoiceActionManifestById("route.ria_home")).toEqual({
      id: "route.ria_home",
      label: "Open RIA Home",
      meaning: "Navigates to the RIA workspace home route.",
      speaker_persona: "one",
      scope: {
        routes: ["/ria"],
        screens: ["ria_home"],
        hidden_navigable: true,
        navigation_prerequisites: ["RIA workspace must be available for this account."],
      },
      guard_ids: ["auth_signed_in", "ria_persona_available"],
      risk_level: "medium",
      execution_policy: "allow_direct",
      execution_hint: {
        status: "wired",
        path: "route",
        target: "/ria",
      },
      map_references: [
        "docs/reference/kai/kai-action-gateway-vnext.md",
        "docs/reference/iam/runtime-surface.md",
        "hushh-webapp/app/ria/page.tsx",
      ],
    });
    expect(getVoiceActionManifestById("ria.picks.open_source_kai")?.execution_hint).toEqual({
      status: "wired",
      path: "route",
      target: "/ria/picks?source=kai",
    });
    expect(getVoiceActionManifestById("ria.client_workspace.open_access_tab")?.execution_hint).toEqual({
      status: "wired",
      path: "route",
      target: "/ria/clients/[userId]?tab=access",
      params: {
        requires_client_id: true,
        tab: "access",
      },
    });
    expect(getVoiceActionManifestById("ria.picks.save_package")).toEqual(
      expect.objectContaining({
        risk_level: "high",
        execution_policy: "manual_only",
        execution_hint: expect.objectContaining({
          status: "unwired",
        }),
      })
    );
    expect(getVoiceActionManifestById("marketplace.ria.request_advisory")).toEqual(
      expect.objectContaining({
        risk_level: "high",
        execution_policy: "manual_only",
        execution_hint: expect.objectContaining({
          status: "unwired",
        }),
      })
    );
  });
});
