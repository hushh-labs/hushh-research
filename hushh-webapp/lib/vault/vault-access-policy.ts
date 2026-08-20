"use client";

export type VaultCapabilityState = {
  hasVaultKey: boolean;
  hasVaultOwnerToken: boolean;
  isUnlocked: boolean;
  canReadSecureData: boolean;
  canMutateSecureData: boolean;
};

export type VaultAvailabilityState = VaultCapabilityState & {
  hasVault: boolean;
  vaultUnknown: boolean;
  needsVaultCreation: boolean;
  needsUnlock: boolean;
};

export function resolveVaultCapabilityState(params: {
  isVaultUnlocked: boolean;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
}): VaultCapabilityState {
  const hasVaultKey =
    typeof params.vaultKey === "string" && params.vaultKey.trim().length > 0;
  const hasVaultOwnerToken =
    typeof params.vaultOwnerToken === "string" &&
    params.vaultOwnerToken.trim().length > 0;
  const isUnlocked = Boolean(params.isVaultUnlocked);

  return {
    hasVaultKey,
    hasVaultOwnerToken,
    isUnlocked,
    canReadSecureData: hasVaultOwnerToken,
    canMutateSecureData: isUnlocked && hasVaultKey && hasVaultOwnerToken,
  };
}

export function resolveVaultAvailabilityState(params: {
  hasVault: boolean | null;
  isVaultUnlocked: boolean;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
}): VaultAvailabilityState {
  const capability = resolveVaultCapabilityState(params);
  const hasVault = params.hasVault === true;

  return {
    ...capability,
    hasVault,
    vaultUnknown: params.hasVault === null,
    needsVaultCreation: params.hasVault === false,
    needsUnlock: hasVault && !capability.canReadSecureData,
  };
}
