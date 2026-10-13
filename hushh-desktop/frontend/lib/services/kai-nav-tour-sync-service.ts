"use client";

import { KaiProfileService } from "@/lib/services/kai-profile-service";
import { KaiNavTourLocalService } from "@/lib/services/kai-nav-tour-local-service";

export class KaiNavTourSyncService {
  static async syncPendingToVault(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken?: string;
  }): Promise<{ synced: boolean; reason?: string }> {
    const pending = await KaiNavTourLocalService.load(params.userId);

    if (!pending) {
      return { synced: false, reason: "no_pending_state" };
    }

    if (pending.synced_to_vault_at) {
      return { synced: false, reason: "already_synced" };
    }

    if (!pending.completed_at && !pending.skipped_at) {
      return { synced: false, reason: "not_completed" };
    }

    await KaiProfileService.setNavTourState({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      completedAt: pending.completed_at,
      skippedAt: pending.skipped_at,
    });

    await KaiNavTourLocalService.markSynced(params.userId);

    return { synced: true };
  }
}
