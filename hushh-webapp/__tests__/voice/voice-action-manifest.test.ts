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
      params: params && Object.keys(params).length > 0 ? params : undefined,
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
  };
}

function projectRegistryAction(action: InvestorKaiActionDefinition) {
  return {
    id: action.id,
    label: action.label,
    meaning: action.meaning,
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
      "hushh-webapp/lib/voice/investor-kai-action-registry.ts"
    );
  });

  it("keeps the neutral manifest aligned with the investor action registry projection", () => {
    expect(listVoiceActionManifestActions()).toEqual(
      INVESTOR_KAI_ACTION_REGISTRY.map((action) => projectRegistryAction(action))
    );
  });

  it("supports action id lookups for canonical planner payloads", () => {
    expect(getVoiceActionManifestById("nav.profile")).toEqual(
      projectRegistryAction(
        INVESTOR_KAI_ACTION_REGISTRY.find((action) => action.id === "nav.profile")!
      )
    );
    expect(getVoiceActionManifestById("missing.action")).toBeNull();
  });
});
