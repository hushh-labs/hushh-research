import type { PkmUserConfirmation } from "@/lib/personal-knowledge-model/mutation-plan";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

export const AGENT_PKM_AUTO_SAVE_POLICY_REF =
  "pkm:runtime_secrets.agent_memory.auto_save_policy";

export type AgentPkmAutoSavePolicy = {
  enabled: boolean;
  version: 1;
  enabledAt: string | null;
};

export const DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY: AgentPkmAutoSavePolicy = {
  enabled: false,
  version: 1,
  enabledAt: null,
};

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
    };
  } catch {
    return DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY;
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
