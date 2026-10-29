"use client";

import { forgetFeedDeviceState } from "@/lib/feed/feed-clear-watermark";
import { forgetLocationMemory } from "@/lib/one-location/location-grant-memory";
import { KaiNavTourLocalService } from "@/lib/services/kai-nav-tour-local-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";
import { PreVaultOnboardingService } from "@/lib/services/pre-vault-onboarding-service";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { FinanceSetupDraftService } from "@/lib/services/finance-setup-draft-service";
import { KycIdentityProfileDraftService } from "@/lib/services/kyc-identity-profile-pkm-service";
import { RiaOnboardingDraftLocalService } from "@/lib/services/ria-onboarding-draft-local-service";
import { VaultMethodPromptLocalService } from "@/lib/services/vault-method-prompt-local-service";
import { VaultQuickUnlockTrustLocalService } from "@/lib/services/vault-quick-unlock-trust-local-service";

/**
 * Centralized cleanup for user-scoped local state.
 *
 * Goal:
 * - Ensure deleted accounts leave no user-scoped onboarding/tour/prompt state
 *   in Capacitor Preferences/local fallbacks.
 * - Keep normal multi-account sign-in isolation by user-id scoping.
 */
export class UserLocalStateService {
  /**
   * Remove device-held key material that only a deleted account may lose: the
   * One Location private key and the native vault quick-unlock secret. Never
   * called on sign-out, where both must survive for the next unlock. Never
   * throws, because the account deletion it follows has already committed.
   */
  static async clearDeviceSecretsForDeletedAccount(userId: string): Promise<void> {
    if (!userId) return;
    const results = await Promise.allSettled([
      import("@/lib/services/onboarding-local-service").then(({ OnboardingLocalService }) =>
        OnboardingLocalService.clearReleaseNotices(userId),
      ),
      import("@/lib/one-location/encryption").then(({ forgetLocationRecipientKey }) =>
        forgetLocationRecipientKey(userId),
      ),
      import("@/lib/services/vault-bootstrap-service").then(({ VaultBootstrapService }) =>
        VaultBootstrapService.clearDeviceVaultSecretsForDeletedAccount(userId),
      ),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[UserLocalStateService] Failed clearing deleted-account device secrets:", result.reason);
      }
    }
  }

  static async clearForUser(userId: string, options: { deleteDurableReceipts?: boolean } = {}): Promise<void> {
    if (!userId) return;

    // Confirmed Reset/delete only; ordinary sign-out/disconnect retains saved
    // receipts. Purge also fences old writes and removes pending PKM jobs.
    const { clearMarkdownMemory } = await import("@/lib/pkm/markdown-memory");
    const { clearCachedGmailReceipts } = await import("@/lib/profile/gmail-receipts-cache");
    const { clearLiveActivity, clearLiveActivityNotice } = await import("@/lib/pkm/live-activity/live-activity-journal");
    clearMarkdownMemory(userId);
    clearCachedGmailReceipts(userId);
    clearLiveActivity(userId);
    const { SecureDurableResourceService } = await import("./secure-durable-resource-service");
    let receiptPurgeError: unknown;
    if (options.deleteDurableReceipts) {
      try { await SecureDurableResourceService.purgeUser(userId); } catch (error) { receiptPurgeError = error; }
      // The account's Feed is gone on the server too. Sign-out keeps the sound
      // choice and any device-only clear not yet copied to the server.
      forgetFeedDeviceState(userId);
      // The deleted owner's id must not stay on the device; sign-out keeps the seen notice.
      clearLiveActivityNotice(userId);
    }

    OneSetupCompletionHintService.clear(userId);
    PreVaultSensitiveDraftService.clearForUser(userId);
    KycIdentityProfileDraftService.clear(userId);
    // The sealed last-known coordinate (24h retention) and the remembered
    // grant (90d) are the only user-scoped records here that describe where a
    // person physically was, so they are the ones that most need to leave with
    // them. Synchronous, and deliberately not in the settled batch below: this
    // is two `removeItem` calls that already swallow their own failures, and an
    // unrelated rejection must not be able to skip it.
    forgetLocationMemory(userId);

    const tasks: Array<Promise<unknown>> = [
      PreVaultOnboardingService.clear(userId),
      FinanceSetupDraftService.clear(userId),
      KaiNavTourLocalService.clear(userId),
      RiaOnboardingDraftLocalService.clear(userId),
      VaultMethodPromptLocalService.clear(userId),
      VaultQuickUnlockTrustLocalService.clear(userId),
    ];

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[UserLocalStateService] Failed clearing user-scoped local state:", result.reason);
      }
    }
    if (receiptPurgeError) throw new Error("Account reset completed, but encrypted device receipts couldn't be removed. Clear this device's app storage before using it again.");
  }
}
