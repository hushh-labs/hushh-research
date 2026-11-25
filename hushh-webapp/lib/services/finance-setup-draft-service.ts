"use client";

import { commitStatementPortfolio } from "@/lib/kai/import/commit-statement-portfolio";
import { DeviceResourceCacheService } from "@/lib/services/device-resource-cache-service";

const RESOURCE_KEY = "setup_finance_review_draft:v1";
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type FinancialRecord = Record<string, unknown>;

export type FinanceSetupReviewDraft = {
  version: 1;
  portfolio: FinancialRecord;
  stagedAt: string;
};

function asRecord(value: unknown): FinancialRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as FinancialRecord)
    : {};
}

function normalizeDraft(value: unknown): FinanceSetupReviewDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const draft = value as Partial<FinanceSetupReviewDraft>;
  if (draft.version !== 1 || !draft.portfolio || typeof draft.portfolio !== "object") {
    return null;
  }
  return {
    version: 1,
    portfolio: asRecord(draft.portfolio),
    stagedAt: typeof draft.stagedAt === "string" ? draft.stagedAt : new Date().toISOString(),
  };
}

/**
 * A bounded bridge between normal Finance setup and the required master vault
 * action. It intentionally accepts only reviewed, structured portfolio
 * information — never a statement file, a Plaid token, a provider credential,
 * or a vault key. The record is user-scoped, expires automatically, and is
 * erased only after its authoritative encrypted PKM commit succeeds.
 */
export class FinanceSetupDraftService {
  static async stage(params: {
    userId: string;
    portfolio: FinancialRecord;
  }): Promise<void> {
    if (!params.userId) throw new Error("A signed-in user is required.");

    // JSON round-tripping rejects non-serializable values and drops UI-only
    // prototypes before the browser persistence boundary.
    const portfolio = JSON.parse(JSON.stringify(params.portfolio)) as FinancialRecord;
    await DeviceResourceCacheService.write<FinanceSetupReviewDraft>({
      userId: params.userId,
      resourceKey: RESOURCE_KEY,
      ttlMs: DRAFT_TTL_MS,
      value: {
        version: 1,
        portfolio,
        stagedAt: new Date().toISOString(),
      },
    });
  }

  static async load(userId: string): Promise<FinanceSetupReviewDraft | null> {
    if (!userId) return null;
    return normalizeDraft(
      await DeviceResourceCacheService.read<unknown>({
        userId,
        resourceKey: RESOURCE_KEY,
      }),
    );
  }

  static async hasPending(userId: string): Promise<boolean> {
    return Boolean(await this.load(userId));
  }

  static async clear(userId: string): Promise<void> {
    if (!userId) return;
    await DeviceResourceCacheService.invalidateResource(userId, RESOURCE_KEY);
  }

  /**
   * The master Finish setup transaction calls this after vault authority is
   * available. A failed encrypted write deliberately leaves the staged origin
   * intact so the same Finish action can be retried without losing the review.
   */
  static async finalizeForVault(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<boolean> {
    const draft = await this.load(params.userId);
    if (!draft) return false;

    await commitStatementPortfolio({
      ...params,
      portfolio: draft.portfolio,
      setupStagedAt: draft.stagedAt,
    });
    await this.clear(params.userId);
    return true;
  }
}
