import { describe, expect, it } from "vitest";

import { resolveProfileVaultSettingsRow } from "@/lib/profile/profile-vault-settings-row";

describe("resolveProfileVaultSettingsRow", () => {
  it("keeps the vault row visible while vault status is unknown", () => {
    expect(
      resolveProfileVaultSettingsRow({
        vaultUnknown: true,
        needsVaultCreation: false,
        needsUnlock: false,
        hasVault: false,
        canMutateSecureData: false,
      }),
    ).toMatchObject({
      action: "wait",
      title: "Vault",
      disabled: true,
      chevron: false,
    });
  });

  it("prompts vault creation for accounts without a vault", () => {
    expect(
      resolveProfileVaultSettingsRow({
        vaultUnknown: false,
        needsVaultCreation: true,
        needsUnlock: false,
        hasVault: false,
        canMutateSecureData: false,
      }),
    ).toMatchObject({
      action: "create",
      title: "Create your vault",
      disabled: false,
      chevron: true,
    });
  });

  it("prompts unlock for an existing locked vault", () => {
    expect(
      resolveProfileVaultSettingsRow({
        vaultUnknown: false,
        needsVaultCreation: false,
        needsUnlock: true,
        hasVault: true,
        canMutateSecureData: false,
      }),
    ).toMatchObject({
      action: "unlock",
      title: "Unlock vault",
      disabled: false,
      chevron: true,
    });
  });

  it("opens management for an existing unlocked vault", () => {
    expect(
      resolveProfileVaultSettingsRow({
        vaultUnknown: false,
        needsVaultCreation: false,
        needsUnlock: false,
        hasVault: true,
        canMutateSecureData: true,
      }),
    ).toMatchObject({
      action: "manage",
      title: "Manage vault",
      disabled: false,
      chevron: true,
    });
  });
});
