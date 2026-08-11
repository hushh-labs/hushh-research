"use client";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  buildFinancialDomainSummary,
  buildStatementSource,
} from "@/lib/kai/brokerage/financial-sources";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
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

    const savedAt = new Date().toISOString();
    const portfolio = asRecord(draft.portfolio);
    const accountInfo = asRecord(portfolio.account_info);
    const existingStatementPeriodEnd = text(accountInfo.statement_period_end);
    const snapshotId = `setup_${Date.now()}`;

    const result = await PkmWriteCoordinator.saveMergedDomain({
      userId: params.userId,
      domain: "financial",
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "one_setup_finance_finalize",
      },
      build: (context) => {
        const current = asRecord(context.currentDomainData);
        const existingDocuments = asRecord(current.documents);
        const existingStatements = asArray(existingDocuments.statements);
        const canonicalPortfolio: FinancialRecord = {
          ...portfolio,
          source_metadata: {
            source_type: "statement",
            source_label: "Setup portfolio",
            source_id: snapshotId,
            active_snapshot_id: snapshotId,
            is_editable: true,
          },
          domain_intent: {
            primary: "financial",
            secondary: "portfolio",
            source: "one_setup_finance",
            captured_sections: ["account_info", "account_summary", "holdings"],
            updated_at: savedAt,
          },
        };
        const snapshot: FinancialRecord = {
          id: snapshotId,
          imported_at: savedAt,
          schema_version: 2,
          source: {
            brokerage: text(accountInfo.brokerage) ?? text(accountInfo.brokerage_name),
            statement_period_end: existingStatementPeriodEnd,
            account_type: text(accountInfo.account_type),
          },
          canonical_v2: canonicalPortfolio,
          holdings: asArray(portfolio.holdings),
          account_info: accountInfo,
          account_summary: asRecord(portfolio.account_summary),
          asset_allocation: portfolio.asset_allocation ?? null,
          transactions: asArray(portfolio.transactions),
          parse_context: {
            setup_staged: true,
          },
        };
        const statements = [snapshot, ...existingStatements].slice(0, 25);
        const documents: FinancialRecord = {
          ...existingDocuments,
          schema_version: 1,
          statements,
          last_statement_end: existingStatementPeriodEnd,
          last_brokerage:
            text(accountInfo.brokerage) ?? text(accountInfo.brokerage_name),
          last_updated: savedAt,
        };
        const sources = asRecord(current.sources);
        const domainData: FinancialRecord = {
          ...current,
          schema_version: 3,
          portfolio: canonicalPortfolio,
          documents,
          sources: {
            ...sources,
            active_source: "statement",
            statement: buildStatementSource(current, statements.map(asRecord), snapshotId, savedAt),
          },
          updated_at: savedAt,
        };

        return {
          domainData,
          summary: {
            ...buildFinancialDomainSummary(domainData),
            intent_source: "one_setup_finance",
            setup_staged_at: draft.stagedAt,
          },
          mergeDecision: {
            merge_mode: "replace_domain",
            target_domain: "financial",
            match_reason: "The reviewed setup portfolio becomes the active statement source.",
          },
        };
      },
    });

    if (!result.success) {
      throw new Error(result.message || "Your portfolio could not be protected yet.");
    }

    await this.clear(params.userId);
    CacheSyncService.onPortfolioUpserted(params.userId, portfolio as never);
    return true;
  }
}
