import { beforeEach, describe, expect, it, vi } from "vitest";

const { storeRuntimeSecretMock } = vi.hoisted(() => ({
  storeRuntimeSecretMock: vi.fn(),
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  GEMINI_RUNTIME_CREDENTIAL_REF: "credential",
  GEMINI_RUNTIME_TRANSPORT_REF: "transport",
  GEMINI_VERTEX_LOCATION_REF: "location",
  GEMINI_VERTEX_PROJECT_REF: "project",
  RUNTIME_CREDENTIAL_MODE_REF: "mode",
  PersonalKnowledgeModelService: {
    storeRuntimeSecret: (...args: unknown[]) => storeRuntimeSecretMock(...args),
  },
}));

import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";

describe("PreVaultSensitiveDraftService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    PreVaultSensitiveDraftService.clearForUser("user-1");
    storeRuntimeSecretMock.mockResolvedValue({ success: true });
  });

  it("holds a Gemini credential only in memory until every encrypted write succeeds", async () => {
    PreVaultSensitiveDraftService.stageGeminiRuntime("user-1", {
      transport: "developer_api",
      credential: "memory-only-gemini-key",
      vertexProject: null,
      vertexLocation: null,
    });

    await PreVaultSensitiveDraftService.finalizeForVault({
      userId: "user-1",
      vaultKey: "memory-only-vault-key",
      vaultOwnerToken: "memory-only-owner-token",
    });

    expect(storeRuntimeSecretMock).toHaveBeenCalledTimes(3);
    expect(PreVaultSensitiveDraftService.hasGeminiRuntime("user-1")).toBe(false);
  });

  it("retains a staged credential for a retry when encrypted persistence fails", async () => {
    PreVaultSensitiveDraftService.stageGeminiRuntime("user-1", {
      transport: "developer_api",
      credential: "memory-only-gemini-key",
      vertexProject: null,
      vertexLocation: null,
    });
    storeRuntimeSecretMock.mockResolvedValueOnce({ success: false });

    await expect(
      PreVaultSensitiveDraftService.finalizeForVault({
        userId: "user-1",
        vaultKey: "memory-only-vault-key",
        vaultOwnerToken: "memory-only-owner-token",
      }),
    ).rejects.toThrow("PKM_WRITE_FAILED");

    expect(PreVaultSensitiveDraftService.hasGeminiRuntime("user-1")).toBe(true);
  });

  it("holds a selected finance action only in process memory until it is consumed", () => {
    const file = new File(["symbol,quantity\nHUSHH,1"], "portfolio.csv", {
      type: "text/csv",
    });
    PreVaultSensitiveDraftService.stageFinanceIntent("user-1", {
      kind: "statement",
      file,
    });

    expect(PreVaultSensitiveDraftService.hasFinanceIntent("user-1")).toBe(true);
    expect(PreVaultSensitiveDraftService.consumeFinanceIntent("user-1")).toEqual({
      kind: "statement",
      file,
    });
    expect(PreVaultSensitiveDraftService.hasFinanceIntent("user-1")).toBe(false);
  });

  it("clears a pending finance action with all other pre-vault drafts", () => {
    PreVaultSensitiveDraftService.stageFinanceIntent("user-1", {
      kind: "plaid",
      environment: "sandbox",
    });

    PreVaultSensitiveDraftService.clearForUser("user-1");

    expect(PreVaultSensitiveDraftService.hasFinanceIntent("user-1")).toBe(false);
  });
});
