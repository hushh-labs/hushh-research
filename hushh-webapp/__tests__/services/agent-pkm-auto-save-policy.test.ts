import { beforeEach, describe, expect, it, vi } from "vitest";

const loadRuntimeSecretMock = vi.fn();
const storeRuntimeSecretMock = vi.fn();

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    loadRuntimeSecret: (...args: unknown[]) => loadRuntimeSecretMock(...args),
    storeRuntimeSecret: (...args: unknown[]) => storeRuntimeSecretMock(...args),
  },
}));

import {
  AGENT_PKM_PRODUCT_DEFAULT_EFFECTIVE_AT,
  DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY,
  loadAgentPkmAutoSavePolicy,
  saveAgentPkmAutoSavePolicy,
} from "@/lib/agent/agent-pkm-auto-save-policy";

const vault = {
  userId: "owner_1",
  vaultKey: "vault_key",
  vaultOwnerToken: "vault_owner_token",
};

describe("agent PKM automatic-save policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables the product default only when no owner preference exists", async () => {
    loadRuntimeSecretMock.mockResolvedValue(null);

    await expect(loadAgentPkmAutoSavePolicy(vault)).resolves.toEqual(
      DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY,
    );
    expect(DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY).toMatchObject({
      enabled: true,
      source: "product_default",
      enabledAt: null,
    });
    expect(AGENT_PKM_PRODUCT_DEFAULT_EFFECTIVE_AT).toMatch(/^2026-09-04T/);
  });

  it("honors an explicit owner opt-out", async () => {
    loadRuntimeSecretMock.mockResolvedValue(
      JSON.stringify({ enabled: false, version: 1, enabledAt: null }),
    );

    await expect(loadAgentPkmAutoSavePolicy(vault)).resolves.toEqual({
      enabled: false,
      version: 1,
      enabledAt: null,
      source: "owner_choice",
    });
  });

  it("records an owner setting separately from the product default", async () => {
    storeRuntimeSecretMock.mockResolvedValue({ success: true });

    const policy = await saveAgentPkmAutoSavePolicy({
      ...vault,
      enabled: true,
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "pkm_memory_auto_save_toggle",
      },
    });

    expect(policy).toMatchObject({ enabled: true, source: "owner_choice" });
    expect(storeRuntimeSecretMock).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialRef: "pkm:runtime_secrets.agent_memory.auto_save_policy",
      }),
    );
  });
});
