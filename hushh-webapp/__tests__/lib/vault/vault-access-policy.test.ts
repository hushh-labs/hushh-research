import { describe, expect, it } from "vitest";

import {
  resolveVaultAvailabilityState,
  resolveVaultCapabilityState,
} from "@/lib/vault/vault-access-policy";

// Regression suite for: hushh-webapp/lib/vault/vault-access-policy.ts
// Covers: resolveVaultCapabilityState, resolveVaultAvailabilityState

describe("resolveVaultCapabilityState", () => {
  it("returns full read and mutate capability when vault is unlocked with key and owner token", () => {
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

  it("grants secure-read capability with vault key present but no owner token", () => {
    expect(
      resolveVaultCapabilityState({
        isVaultUnlocked: true,
        vaultKey: "vault-key",
        vaultOwnerToken: null,
      })
    ).toMatchObject({
      hasVaultKey: true,
      hasVaultOwnerToken: false,
      canReadSecureData: false,
      canMutateSecureData: false,
    });
  });

  it("denies all capability when vault is locked with no credentials", () => {
    expect(
      resolveVaultCapabilityState({
        isVaultUnlocked: false,
        vaultKey: null,
        vaultOwnerToken: null,
      })
    ).toMatchObject({
      hasVaultKey: false,
      hasVaultOwnerToken: false,
      isUnlocked: false,
      canReadSecureData: false,
      canMutateSecureData: false,
    });
  });

  it("denies mutate capability when owner token is absent even if vault key is present", () => {
    expect(
      resolveVaultCapabilityState({
        isVaultUnlocked: false,
        vaultKey: "vault-key",
        vaultOwnerToken: null,
      })
    ).toMatchObject({
      hasVaultOwnerToken: false,
      canMutateSecureData: false,
    });
  });
});

describe("resolveVaultAvailabilityState", () => {
  it("resolves locked vault as unlock-required, not unavailable", () => {
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

  it("resolves absent vault as creation-required, not unlock-required", () => {
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
      canReadSecureData: false,
      canMutateSecureData: false,
    });
  });

  it("resolves fully unlocked vault as read and mutate capable", () => {
    expect(
      resolveVaultAvailabilityState({
        hasVault: true,
        isVaultUnlocked: true,
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner-token",
      })
    ).toMatchObject({
      hasVault: true,
      vaultUnknown: false,
      needsVaultCreation: false,
      needsUnlock: false,
      canReadSecureData: true,
      canMutateSecureData: true,
    });
  });

  it("resolves unknown vault state as vaultUnknown with all capabilities denied", () => {
    expect(
      resolveVaultAvailabilityState({
        hasVault: null,
        isVaultUnlocked: false,
        vaultKey: null,
        vaultOwnerToken: null,
      })
    ).toMatchObject({
      vaultUnknown: true,
      needsVaultCreation: false,
      needsUnlock: false,
      canReadSecureData: false,
      canMutateSecureData: false,
    });
  });

  it("resolves partial unlock state as unlock-required with all secure capability denied", () => {
    expect(
      resolveVaultAvailabilityState({
        hasVault: true,
        isVaultUnlocked: true,
        vaultKey: "vault-key",
        vaultOwnerToken: null,
      })
    ).toMatchObject({
      hasVault: true,
      needsUnlock: true,
      canReadSecureData: false,
      canMutateSecureData: false,
    });
  });
});