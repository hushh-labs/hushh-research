"use client";

import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";

export class PostUnlockSyncService {
  static async run(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<{
    onboardingSynced: boolean;
    metadataWarmed: boolean;
    financialWarmed: boolean;
  }> {
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
      metadataWarmed: false,
      financialWarmed: false,
    };
  }
}
