"use client";

import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";

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
  }): Promise<{ onboardingSynced: boolean }> {
    const syncResult = await KaiProfileSyncService.syncPendingToVault({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch((error) => {
      console.warn("[PostUnlockSyncService] Pending onboarding sync failed:", error);
      return { synced: false };
    });

    return {
      onboardingSynced: Boolean(syncResult.synced),
    };
  }
}
