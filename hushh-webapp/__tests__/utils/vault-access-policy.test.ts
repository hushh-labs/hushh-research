import { describe, expect, it } from "vitest";

import {
  resolveVaultAvailabilityState,
  resolveVaultCapabilityState,
} from "@/lib/vault/vault-access-policy";


// resolveVaultCapabilityState

describe("resolveVaultCapabilityState", () => {
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

  it("allows read but not mutate when token is present and vault is locked", () => {
    expect(
      resolveVaultCapabilityState({
        isVaultUnlocked: false,
        vaultKey: null,
        vaultOwnerToken: "vault-owner-token",
      })
    ).toEqual({
      hasVaultKey: false,
      hasVaultOwnerToken: true,
      isUnlocked: false,
      canReadSecureData: true,
      canMutateSecureData: false,
    });
  });

  it("denies both read and mutate when no owner token is present", () => {
    expect(
      resolveVaultCapabilityState({
        isVaultUnlocked: true,
        vaultKey: "vault-key",
        vaultOwnerToken: null,
      })
    ).toEqual({
      hasVaultKey: true,
      hasVaultOwnerToken: false,
      isUnlocked: true,
      canReadSecureData: false,
      canMutateSecureData: false,
    });
  });

  it("returns fully denied capability when all inputs are absent", () => {
    expect(
      resolveVaultCapabilityState({
        isVaultUnlocked: false,
        vaultKey: null,
        vaultOwnerToken: null,
      })
    ).toEqual({
      hasVaultKey: false,
      hasVaultOwnerToken: false,
      isUnlocked: false,
      canReadSecureData: false,
      canMutateSecureData: false,
    });
  });

  it("treats undefined vaultKey and vaultOwnerToken as absent", () => {
    const result = resolveVaultCapabilityState({ isVaultUnlocked: false });
    expect(result.hasVaultKey).toBe(false);
    expect(result.hasVaultOwnerToken).toBe(false);
    expect(result.canReadSecureData).toBe(false);
    expect(result.canMutateSecureData).toBe(false);
  });

  it("requires all three conditions for canMutateSecureData", () => {
    // unlocked + key, but no token
    expect(
      resolveVaultCapabilityState({
        isVaultUnlocked: true,
        vaultKey: "key",
        vaultOwnerToken: null,
      }).canMutateSecureData
    ).toBe(false);

    // unlocked + token, but no key
    expect(
      resolveVaultCapabilityState({
        isVaultUnlocked: true,
        vaultKey: null,
        vaultOwnerToken: "token",
      }).canMutateSecureData
    ).toBe(false);

    // key + token, but not unlocked
    expect(
      resolveVaultCapabilityState({
        isVaultUnlocked: false,
        vaultKey: "key",
        vaultOwnerToken: "token",
      }).canMutateSecureData
    ).toBe(false);
  });
});

// resolveVaultAvailabilityState

describe("resolveVaultAvailabilityState", () => {
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

  it("treats null hasVault as unknown vault state", () => {
    const result = resolveVaultAvailabilityState({
      hasVault: null,
      isVaultUnlocked: false,
      vaultKey: null,
      vaultOwnerToken: null,
    });
    expect(result.vaultUnknown).toBe(true);
    expect(result.hasVault).toBe(false);
    expect(result.needsVaultCreation).toBe(false);
    expect(result.needsUnlock).toBe(false);
  });

  it("does not set needsUnlock when vault is missing — creation takes priority", () => {
    const result = resolveVaultAvailabilityState({
      hasVault: false,
      isVaultUnlocked: false,
      vaultKey: null,
      vaultOwnerToken: null,
    });
    expect(result.needsUnlock).toBe(false);
    expect(result.needsVaultCreation).toBe(true);
  });

  it("clears needsUnlock when owner token satisfies canReadSecureData", () => {
    const result = resolveVaultAvailabilityState({
      hasVault: true,
      isVaultUnlocked: false,
      vaultKey: null,
      vaultOwnerToken: "vault-owner-token",
    });
    expect(result.needsUnlock).toBe(false);
    expect(result.canReadSecureData).toBe(true);
  });

  it("propagates full capability for a fully unlocked vault", () => {
    expect(
      resolveVaultAvailabilityState({
        hasVault: true,
        isVaultUnlocked: true,
        vaultKey: "key",
        vaultOwnerToken: "token",
      })
    ).toEqual({
      hasVault: true,
      vaultUnknown: false,
      needsVaultCreation: false,
      needsUnlock: false,
      hasVaultKey: true,
      hasVaultOwnerToken: true,
      isUnlocked: true,
      canReadSecureData: true,
      canMutateSecureData: true,
    });
  });

  it("does not set vaultUnknown or needsVaultCreation when hasVault is true", () => {
    const result = resolveVaultAvailabilityState({
      hasVault: true,
      isVaultUnlocked: true,
      vaultKey: "key",
      vaultOwnerToken: "token",
    });
    expect(result.vaultUnknown).toBe(false);
    expect(result.needsVaultCreation).toBe(false);
  });
});