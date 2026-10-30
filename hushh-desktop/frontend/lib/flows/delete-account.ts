"use client";

import { VaultService } from "@/lib/services/vault-service";

export type DeleteAccountAuthResolution =
  | { kind: "use_existing_token"; token: string; hasVault: true }
  | { kind: "issue_token"; token: string; hasVault: false }
  | { kind: "needs_unlock"; hasVault: true };

export async function resolveDeleteAccountAuth(params: {
  userId: string;
  existingVaultOwnerToken: string | null;
}): Promise<DeleteAccountAuthResolution> {
  const hasVault = await VaultService.checkVault(params.userId);

  if (!hasVault) {
    const issued = await VaultService.getOrIssueVaultOwnerToken(
      params.userId,
      null,
      null
    );
    return { kind: "issue_token", token: issued.token, hasVault: false };
  }

  if (params.existingVaultOwnerToken) {
    return {
      kind: "use_existing_token",
      token: params.existingVaultOwnerToken,
      hasVault: true,
    };
  }

  return { kind: "needs_unlock", hasVault: true };
}

