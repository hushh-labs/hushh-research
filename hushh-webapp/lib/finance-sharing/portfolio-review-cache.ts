"use client";

import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { SecureDurableResourceService } from "@/lib/services/secure-durable-resource-service";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";

export type PortfolioReviewResponse = {
  score: number | null;
  takeaway: string;
  reason: string;
  next_step: string;
  advisor_reason: string | null;
};

export type SavedPortfolioReview = { digest: string; review: PortfolioReviewResponse };
const RESOURCE_KEY = "finance-portfolio-review-v1";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** An encrypted result for this device only. It carries no approval for another model call. */
export function readSavedPortfolioReview({ userId, vaultKey }: FinanceShareContext) {
  return SecureResourceCacheService.read<SavedPortfolioReview>({
    userId, vaultKey, resourceKey: RESOURCE_KEY,
  });
}

export async function portfolioReviewCacheGeneration(userId: string) {
  return (await SecureDurableResourceService.version(userId, RESOURCE_KEY).catch(() => null))?.generation;
}

export function savePortfolioReviewOnDevice(
  context: FinanceShareContext,
  value: SavedPortfolioReview,
  ownerGeneration: number,
) {
  if (!context.isCurrent()) return;
  const { userId, vaultKey } = context;
  return SecureResourceCacheService.writeRequired({
    userId, vaultKey, resourceKey: RESOURCE_KEY, value, ttlMs: TTL_MS, ownerGeneration,
  }).catch(() => undefined);
}
