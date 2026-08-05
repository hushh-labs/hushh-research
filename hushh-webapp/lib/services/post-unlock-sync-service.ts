"use client";

import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";
import { KycIdentityProfileDraftService } from "@/lib/services/kyc-identity-profile-pkm-service";

/**
 * Syncs pre-vault onboarding data to the encrypted PKM after vault unlock.
 *
 * NOTE: This service handles ONLY onboarding sync.
 * For full post-unlock warming (metadata, financial, consents, dashboard),
 * see UnlockWarmOrchestrator which is triggered from KaiLayout.
 */
export class PostUnlockSyncService {
  static async run(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<{ onboardingSynced: boolean; kycIdentitySynced: boolean }> {
    // Callers decide whether this is a best-effort background warm-up or the
    // mandatory Finish setup transaction. Never convert an encrypted-write
    // failure into `false` here: the setup hub must keep its retryable state
    // rather than exiting with a partially protected onboarding session.
    const [syncResult, kycIdentitySynced] = await Promise.all([
      KaiProfileSyncService.syncPendingToVault({
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
      }),
      KycIdentityProfileDraftService.flushToVault(params),
    ]);

    return {
      onboardingSynced: Boolean(syncResult.synced),
      kycIdentitySynced,
    };
  }
}
