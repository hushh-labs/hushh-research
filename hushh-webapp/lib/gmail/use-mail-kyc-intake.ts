"use client";

import { advanceMailKycDisplayVersion, mailKycDisplayVersion } from "./mail-kyc-display-version";
import { useCallback } from "react";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { CacheService } from "@/lib/services/cache-service";
import { KycIdentityProfilePkmService } from "@/lib/services/kyc-identity-profile-pkm-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { withDeadline } from "@/lib/utils/with-deadline";

const TTL_MS = 60_000;
subscribeVaultSessionEpoch(() => CacheService.getInstance().invalidatePattern("mail_kyc_intake_"));

/** A display hint; profile saves and disclosure still use their existing live owners. */
export function useMailKycIntake({ userId, vaultKey, vaultOwnerToken }: {
  userId: string | null; vaultKey: string | null; vaultOwnerToken: string | null;
}) {
  const epoch = snapshotVaultSessionEpoch();
  const cacheKey = `mail_kyc_intake_${userId ?? "guest"}_${epoch}`;
  const load = useCallback(async (options?: { deadlineMs?: number }) => {
    if (!userId || !vaultKey || !vaultOwnerToken) throw new Error("Unlock your private vault.");
    return withDeadline(KycIdentityProfilePkmService.hasCompletedIntake({ userId, vaultKey, vaultOwnerToken }), options?.deadlineMs ?? Date.now() + 30_000);
  }, [userId, vaultKey, vaultOwnerToken]);
  const resource = useStaleResource({ cacheKey, requestScope: String(epoch),
    enabled: Boolean(userId && vaultKey && vaultOwnerToken), load,
    resourceLabel: "mail-kyc-intake", cacheTtlMs: TTL_MS, requestBudgetMs: 30_000,
    getRequestVersion: () => mailKycDisplayVersion(userId ?? "guest"),
  });
  const markCompleted = useCallback(() => {
    if (isVaultSessionEpochCurrent(epoch) && userId) {
      advanceMailKycDisplayVersion(userId);
      CacheService.getInstance().set(cacheKey, true, TTL_MS);
    }
  }, [cacheKey, epoch, userId]);
  return { ...resource, markCompleted };
}
