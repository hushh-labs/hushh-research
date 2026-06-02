import { beforeEach, describe, expect, it, vi } from "vitest";

const emptyMetadataMock = vi.fn((userId: string) => ({
  userId,
  domains: [],
  totalAttributes: 0,
  modelCompleteness: 0,
  modelVersion: 4,
  storedModelVersion: 4,
  effectiveModelVersion: 4,
  targetModelVersion: 4,
  upgradeStatus: "current",
  upgradableDomains: [],
  lastUpgradedAt: null,
  suggestedDomains: [],
  lastUpdated: null,
}));
const getMetadataMock = vi.fn();

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    emptyMetadata: (...args: [string]) => emptyMetadataMock(...args),
    getMetadata: (...args: unknown[]) => getMetadataMock(...args),
  },
}));

import { loadProfilePkmMetadataForVaultState } from "@/lib/profile/profile-pkm-metadata-policy";

describe("loadProfilePkmMetadataForVaultState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses local empty metadata when the profile already knows no vault exists", async () => {
    const result = await loadProfilePkmMetadataForVaultState({
      userId: "user-without-vault",
      hasVault: false,
      vaultOwnerToken: null,
    });

    expect(result).toMatchObject({
      userId: "user-without-vault",
      domains: [],
      totalAttributes: 0,
    });
    expect(emptyMetadataMock).toHaveBeenCalledWith("user-without-vault");
    expect(getMetadataMock).not.toHaveBeenCalled();
  });

  it("fetches network metadata only when a vault exists", async () => {
    getMetadataMock.mockResolvedValueOnce({
      userId: "user-with-vault",
      domains: [{ key: "financial" }],
      totalAttributes: 1,
    });

    const result = await loadProfilePkmMetadataForVaultState({
      userId: "user-with-vault",
      hasVault: true,
      force: true,
      vaultOwnerToken: "vault-owner-token",
    });

    expect(result).toMatchObject({
      userId: "user-with-vault",
      totalAttributes: 1,
    });
    expect(getMetadataMock).toHaveBeenCalledWith(
      "user-with-vault",
      true,
      "vault-owner-token",
    );
    expect(emptyMetadataMock).not.toHaveBeenCalled();
  });
});
