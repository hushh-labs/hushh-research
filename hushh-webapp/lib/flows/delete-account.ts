"use client";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { AccountService } from "@/lib/services/account-service";
import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { VaultService } from "@/lib/services/vault-service";

export type DeleteAccountAuthResolution =
  | { kind: "use_existing_token"; token: string; hasVault: true }
  | { kind: "issue_token"; token: string; hasVault: false }
  | { kind: "needs_unlock"; hasVault: true };

/**
 * Account deletion is one destructive account-level action, regardless of
 * whether its entry point is Profile or the onboarding shell. Keep the copy
 * and confirmed mutation here so route-local affordances cannot drift.
 */
export const DELETE_ACCOUNT_DIALOG_TITLE = "Delete your One account?";
// Names BOTH sides of the boundary: what is removed (including everything
// Hussh created inside the person's own Google Cloud project: their agent,
// its storage, its keys) and what is deliberately never touched (the project
// itself, which is theirs). Deletion that is silent about the second half
// reads as either over-deleting or under-cleaning (founder finding,
// 2026-08-21).
export const DELETE_ACCOUNT_DIALOG_DESCRIPTION =
  "This action cannot be undone. This permanently deletes your One account, " +
  "your encrypted vault and saved details, every connected service, your " +
  "cloud-linked identity, and your private agent with everything we created " +
  "inside your Google Cloud project (its service, storage, and keys). Your " +
  "Google Cloud project itself is yours and is never deleted by us.";

export async function resolveDeleteAccountAuth(params: {
  userId: string;
  existingVaultOwnerToken: string | null;
}): Promise<DeleteAccountAuthResolution> {
  const hasVault = await VaultService.checkVault(params.userId);

  if (!hasVault) {
    const issued = await VaultService.getOrIssueVaultOwnerToken(
      params.userId,
      null,
      null,
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

/**
 * Execute the already-authorized, full One-account deletion and clear only the
 * browser state that belongs to that owner. Authentication teardown remains in
 * the invoking UI because it owns the active session and final navigation.
 */
export async function executeVerifiedAccountDeletion(params: {
  userId: string;
  vaultOwnerToken: string;
}): Promise<void> {
  await AccountService.deleteAccount(params.vaultOwnerToken, "both");
  CacheSyncService.onAccountDeleted(params.userId);
  await UserLocalStateService.clearForUser(params.userId);
  setOnboardingRequiredCookie(false);
  setOnboardingFlowActiveCookie(false);
}
