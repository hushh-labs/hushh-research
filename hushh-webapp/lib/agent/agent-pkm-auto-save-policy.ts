import type { PkmUserConfirmation } from "@/lib/personal-knowledge-model/mutation-plan";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

export const AGENT_PKM_AUTO_SAVE_POLICY_REF =
  "pkm:runtime_secrets.agent_memory.auto_save_policy";

export type AgentPkmAutoSavePolicy = {
  enabled: boolean;
  version: 1;
  enabledAt: string | null;
  source: "product_default" | "owner_choice";
};

export const AGENT_PKM_PRODUCT_DEFAULT_EFFECTIVE_AT = "2026-09-04T00:00:00.000Z";

export const DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY: AgentPkmAutoSavePolicy = {
  enabled: true,
  version: 1,
  enabledAt: null,
  source: "product_default",
};

/** Existing cache events invalidate authority; only a fresh encrypted read re-enables it. */
export function subscribeAgentPkmAutoSavePolicyInvalidation(userId: string, invalidate: () => void) {
  if (typeof window === "undefined") return () => {};
  const onChange = (event: Event) => {
    const detail = (event as CustomEvent<{ userId?: string; domain?: string }>).detail;
    if (detail?.userId === userId && detail.domain === "runtime_secrets") invalidate();
  };
  window.addEventListener("pkm-domain-changed", onChange);
  return () => window.removeEventListener("pkm-domain-changed", onChange);
}

function parsePolicy(value: string | null): AgentPkmAutoSavePolicy {
  if (!value) return DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY;
  try {
    const parsed = JSON.parse(value) as Partial<AgentPkmAutoSavePolicy>;
    return {
      enabled: parsed.enabled === true,
      version: 1,
      enabledAt:
        typeof parsed.enabledAt === "string" && parsed.enabledAt.trim()
          ? parsed.enabledAt
          : null,
      source: "owner_choice",
    };
  } catch {
    // A corrupt stored owner choice is not absence of a choice. Never
    // silently replace it with an enabled product default.
    return { enabled: false, version: 1, enabledAt: null, source: "owner_choice" };
  }
}

export async function loadAgentPkmAutoSavePolicy(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
}): Promise<AgentPkmAutoSavePolicy> {
  const stored = await PersonalKnowledgeModelService.loadRuntimeSecret({
    ...params,
    credentialRef: AGENT_PKM_AUTO_SAVE_POLICY_REF,
  });
  return parsePolicy(stored);
}

export async function saveAgentPkmAutoSavePolicy(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  enabled: boolean;
  confirmation: PkmUserConfirmation;
}): Promise<AgentPkmAutoSavePolicy> {
  const policy: AgentPkmAutoSavePolicy = {
    enabled: params.enabled,
    version: 1,
    enabledAt: params.enabled ? new Date().toISOString() : null,
    source: "owner_choice",
  };
  const result = await PersonalKnowledgeModelService.storeRuntimeSecret({
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    credentialRef: AGENT_PKM_AUTO_SAVE_POLICY_REF,
    secret: JSON.stringify(policy),
    confirmation: params.confirmation,
  });
  if (!result.success) {
    throw new Error(result.message || "Couldn't update automatic memory saving.");
  }
  return policy;
}
