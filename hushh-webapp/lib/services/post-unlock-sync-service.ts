"use client";

import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";
import { OneLocationService } from "@/lib/one-location/service";
import { OneConnectionsService } from "@/lib/one-connections/service";

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
  }): Promise<{ onboardingSynced: boolean; sosSeeded: boolean; trustedSeeded: boolean }> {
    const syncResult = await KaiProfileSyncService.syncPendingToVault({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch((error) => {
      console.warn("[PostUnlockSyncService] Pending onboarding sync failed:", error);
      return { synced: false };
    });

    // Seed trusted contacts (idempotent, gated server-side on zero connections)
    // so a fresh user has SOS recipients. Isolated: a failure here must not
    // abort onboarding sync.
    const seedResult = await OneLocationService.seedTrustedContacts({
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch((error) => {
      console.warn("[PostUnlockSyncService] SOS trusted-contact seed failed:", error);
      return { seeded: 0, existingCount: 0, skippedSelf: 0 };
    });

    // Seed the generalized trusted-connections graph (idempotent, gated
    // server-side on zero edges). Separate from the SOS seed above; a failure
    // here must not abort onboarding sync.
    const trustedSeed = await OneConnectionsService.seedTrustedConnections({
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch((error) => {
      console.warn("[PostUnlockSyncService] Trusted-connection seed failed:", error);
      return { seeded: 0, existingCount: 0, skippedSelf: 0 };
    });

    return {
      onboardingSynced: Boolean(syncResult.synced),
      sosSeeded: Boolean(seedResult.seeded),
      trustedSeeded: Boolean(trustedSeed.seeded),
    };
  }
}
