"use client";

import { mailKycDisplayVersion } from "./mail-kyc-display-version";
import { useCallback } from "react";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { CacheService } from "@/lib/services/cache-service";
import { GmailInformationRequestsService } from "@/lib/services/gmail-information-requests-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { withDeadline } from "@/lib/utils/with-deadline";

export const MAIL_KYC_READ_BUDGET_MS = 30_000;
const TTL_MS = 60_000;
// Credential changes purge protected display information synchronously. No device storage.
subscribeVaultSessionEpoch(() => CacheService.getInstance().invalidatePattern("mail_kyc_display_"));


export function useMailKycDisplay({ userId, vaultOwnerToken, isConnected, active, idTokenProvider, accountKey = "current" }: {
  userId: string | null; vaultOwnerToken: string | null; isConnected: boolean;
  active: boolean; idTokenProvider: (() => Promise<string>) | null; accountKey?: string;
}) {
  const epoch = snapshotVaultSessionEpoch();
  const load = useCallback(async (options?: { deadlineMs?: number }) => {
    if (!userId || !idTokenProvider) throw new Error("Mail is unavailable.");
    // One deadline covers token acquisition and every read, including unabortable bridges.
    const deadline = options?.deadlineMs ?? Date.now() + MAIL_KYC_READ_BUDGET_MS;
    return withDeadline((async () => {
      const firebaseIdToken = await idTokenProvider();
      if (!isVaultSessionEpochCurrent(epoch) || Date.now() >= deadline) throw new Error("Mail session changed.");
      const preference = await GmailInformationRequestsService.getPreference({ userId, firebaseIdToken });
      if (!preference.monitoring_enabled || !vaultOwnerToken) return { preference, requests: null, activity: null };
      if (!isVaultSessionEpochCurrent(epoch) || Date.now() >= deadline) throw new Error("Mail session changed.");
      const [requests, activity] = await Promise.all([
        GmailInformationRequestsService.list({ firebaseIdToken, vaultOwnerToken, limit: 100 }),
        GmailInformationRequestsService.list({ firebaseIdToken, vaultOwnerToken, limit: 100, view: "activity" }),
      ]);
      return { preference, requests, activity };
    })(), deadline);
  }, [userId, idTokenProvider, vaultOwnerToken, epoch]);
  const cacheKey = `mail_kyc_display_${userId ?? "guest"}_${accountKey}_${epoch}_${Boolean(vaultOwnerToken)}`;
  const resource = useStaleResource({
    cacheKey,
    requestScope: String(epoch), enabled: Boolean(active && isConnected && userId && idTokenProvider),
    resourceLabel: "mail-kyc-display", load, cacheTtlMs: TTL_MS, requestBudgetMs: MAIL_KYC_READ_BUDGET_MS, retainOnInvalidate: true,
    getRequestVersion: () => mailKycDisplayVersion(userId ?? "guest"),
    isRequestCurrent: () => isVaultSessionEpochCurrent(epoch),
  });
  const publish = useCallback((value: Awaited<ReturnType<typeof load>>) => {
    if (isVaultSessionEpochCurrent(epoch)) CacheService.getInstance().set(cacheKey, value, TTL_MS);
  }, [cacheKey, epoch]);
  return { ...resource, publish };
}
