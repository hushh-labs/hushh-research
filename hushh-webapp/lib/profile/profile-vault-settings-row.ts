import type { VaultAvailabilityState } from "@/lib/vault/vault-access-policy";

export type ProfileVaultSettingsRowAction =
  | "wait"
  | "create"
  | "unlock"
  | "manage";

export type ProfileVaultSettingsRow = {
  action: ProfileVaultSettingsRowAction;
  title: string;
  description: string;
  disabled: boolean;
  chevron: boolean;
  voiceLabel: string;
  voicePurpose: string;
};

type VaultSettingsAccess = Pick<
  VaultAvailabilityState,
  | "vaultUnknown"
  | "needsVaultCreation"
  | "needsUnlock"
  | "hasVault"
  | "canMutateSecureData"
>;

export function resolveProfileVaultSettingsRow(
  vaultAccess: VaultSettingsAccess,
): ProfileVaultSettingsRow {
  if (vaultAccess.vaultUnknown) {
    return {
      action: "wait",
      title: "Vault",
      description: "Checking secure vault status...",
      disabled: true,
      chevron: false,
      voiceLabel: "Vault",
      voicePurpose: "Checks whether your secure vault is ready.",
    };
  }

  if (vaultAccess.needsVaultCreation) {
    return {
      action: "create",
      title: "Create your vault",
      description: "Set up a passphrase to secure your personal data.",
      disabled: false,
      chevron: true,
      voiceLabel: "Create your vault",
      voicePurpose: "Starts secure vault setup for this account.",
    };
  }

  if (vaultAccess.needsUnlock) {
    return {
      action: "unlock",
      title: "Unlock vault",
      description: "Unlock to access PKM, sharing, receipts, and vault security.",
      disabled: false,
      chevron: true,
      voiceLabel: "Unlock vault",
      voicePurpose: "Unlocks your secure vault before opening vault settings.",
    };
  }

  if (vaultAccess.hasVault) {
    return {
      action: "manage",
      title: vaultAccess.canMutateSecureData ? "Manage vault" : "Vault security",
      description: "Review vault security, passphrase, and unlock methods.",
      disabled: false,
      chevron: true,
      voiceLabel: vaultAccess.canMutateSecureData ? "Manage vault" : "Vault security",
      voicePurpose: "Opens vault security and unlock method settings.",
    };
  }

  return {
    action: "wait",
    title: "Vault",
    description: "Checking secure vault status...",
    disabled: true,
    chevron: false,
    voiceLabel: "Vault",
    voicePurpose: "Checks whether your secure vault is ready.",
  };
}
