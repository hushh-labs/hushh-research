import { describe, expect, it } from "vitest";

import {
  resolveVaultAvailabilityState,
  resolveVaultCapabilityState,
} from "@/lib/vault/vault-access-policy";

describe("vault access policy", () => {
  it("treats owner token as secure-read capability and full unlock as mutate capability", () => {
    expect(
      resolveVaultCapabilityState({
        isVaultUnlocked: true,
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner-token",
      })
    ).toEqual({
      hasVaultKey: true,
      hasVaultOwnerToken: true,
      isUnlocked: true,
      canReadSecureData: true,
      canMutateSecureData: true,
    });
  });

  it("treats an existing but locked vault as unlock-required instead of unavailable", () => {
    expect(
      resolveVaultAvailabilityState({
        hasVault: true,
        isVaultUnlocked: false,
        vaultKey: null,
        vaultOwnerToken: null,
      })
    ).toMatchObject({
      hasVault: true,
      vaultUnknown: false,
      needsVaultCreation: false,
      needsUnlock: true,
      canReadSecureData: false,
      canMutateSecureData: false,
    });
  });

  it("treats accounts without a vault as creation-required", () => {
    expect(
      resolveVaultAvailabilityState({
        hasVault: false,
        isVaultUnlocked: false,
        vaultKey: null,
        vaultOwnerToken: null,
      })
    ).toMatchObject({
      hasVault: false,
      vaultUnknown: false,
      needsVaultCreation: true,
      needsUnlock: false,
    });
  });
});
