import { describe, expect, it } from "vitest";

import {
  resolveLockState,
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

  it("keeps an unresolved presence read in loading instead of setup", () => {
    expect(
      resolveLockState({
        hasVault: null,
        isVaultUnlocked: false,
        vaultKey: null,
        vaultOwnerToken: null,
      }),
    ).toBe("loading");

    expect(
      resolveVaultAvailabilityState({
        hasVault: null,
        isVaultUnlocked: false,
      }),
    ).toMatchObject({
      state: "loading",
      vaultUnknown: true,
      needsVaultCreation: false,
      needsUnlock: false,
      vaultCheckFailed: false,
    });
  });

  it("keeps a failed presence read out of both setup and unlock prompts", () => {
    expect(
      resolveVaultAvailabilityState({
        hasVault: false,
        isVaultUnlocked: false,
        presenceFailed: true,
      }),
    ).toMatchObject({
      state: "error",
      needsVaultCreation: false,
      needsUnlock: false,
      vaultCheckFailed: true,
    });
  });
});
