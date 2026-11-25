"use client";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { buildFinancialDomainSummary, buildStatementSource, getStatementSnapshots } from "@/lib/kai/brokerage/financial-sources";
import { computeStatementImportId, upsertStatementSnapshot } from "@/lib/kai/brokerage/statement-import-identity";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

type FinancialRecord = Record<string, unknown>;

function asRecord(value: unknown): FinancialRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as FinancialRecord
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

/** Commit a statement selected for vault import using the existing financial snapshot format. */
export async function commitStatementPortfolio(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  portfolio: FinancialRecord;
  setupStagedAt?: string;
  importedAt?: string;
  fileName?: string;
  beforeEffect?: () => Promise<void>;
  mayPublish?: () => boolean;
}): Promise<void> {
  const savedAt = new Date().toISOString();
  const portfolio = params.portfolio;
  const accountInfo = asRecord(portfolio.account_info);
  const existingStatementPeriodEnd = text(accountInfo.statement_period_end);
  // The same id the review save derives, so a statement committed here and
  // again from the review (or by a retried Finish) stays one snapshot.
  const snapshotId = await computeStatementImportId(portfolio);

  const result = await PkmWriteCoordinator.saveMergedDomain({
    userId: params.userId,
    domain: "financial",
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    confirmation: {
      confirmedByUser: true,
      surface: params.setupStagedAt ? "web" : "chat",
      source: params.setupStagedAt ? "one_setup_finance_finalize" : "one_chat_portfolio_import",
    },
    beforeEffect: params.beforeEffect,
    mayPublish: params.mayPublish,
    build: (context) => {
      const current = asRecord(context.currentDomainData);
      const existingDocuments = asRecord(current.documents);
      const canonicalPortfolio: FinancialRecord = {
        ...portfolio,
        source_metadata: {
          source_type: "statement",
          source_label: params.setupStagedAt ? "Setup portfolio" : "Statement",
          source_id: snapshotId,
          active_snapshot_id: snapshotId,
          is_editable: true,
        },
        domain_intent: {
          primary: "financial",
          secondary: "portfolio",
          source: params.setupStagedAt ? "one_setup_finance" : "kai_import_llm",
          captured_sections: ["account_info", "account_summary", "holdings"],
          updated_at: savedAt,
        },
      };
      const snapshot: FinancialRecord = {
        id: snapshotId,
        imported_at: params.importedAt ?? savedAt,
        schema_version: 2,
        source: {
          ...(params.fileName && { file_name: params.fileName.trim().slice(0, 255) }),
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
        ...(params.setupStagedAt ? {} : {
          quality_report_v2: portfolio.quality_report_v2,
          raw_extract_v2: portfolio.raw_extract_v2,
          analytics_v2: portfolio.analytics_v2,
        }),
        parse_context: {
          ...(params.setupStagedAt && { setup_staged: true }),
        },
      };
      const statements = upsertStatementSnapshot(getStatementSnapshots(current), snapshot);
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
          statement: buildStatementSource(current, statements, snapshotId, savedAt),
        },
        updated_at: savedAt,
      };

      return {
        domainData,
        summary: {
          ...buildFinancialDomainSummary(domainData),
          intent_source: params.setupStagedAt ? "one_setup_finance" : "kai_import_llm",
          ...(params.setupStagedAt && { setup_staged_at: params.setupStagedAt }),
        },
        mergeDecision: {
          merge_mode: "replace_domain",
          target_domain: "financial",
          match_reason: "The confirmed portfolio import becomes the active statement source.",
        },
      };
    },
  });

  if (!result.success) {
    throw new Error(result.message || "Your portfolio could not be protected yet.");
  }

  if (params.mayPublish?.() === false) return;
  CacheSyncService.onPortfolioUpserted(params.userId, portfolio as never);
}
