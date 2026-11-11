/**
 * PortfolioReviewView Component
 *
 * Review screen for verifying and editing parsed portfolio data before saving.
 * Displayed after PDF parsing completes, before data is saved to PKM.
 *
 * Features:
 * - Account info display (editable)
 * - Summary section with key metrics
 * - Holdings list with inline editing
 * - Asset allocation breakdown
 * - Income summary (if available)
 * - Save to Vault button (encrypts and stores to PKM)
 * - Re-import button to try again
 */

"use client";

import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { PortfolioReviewSummary } from "@/components/kai/cards/portfolio-review-summary";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Plus,
  Loader2,
  Building2,
  ChevronDown,
  PieChart,
  Wallet,
} from "@/components/icons";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/morphy-ux/ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HoldingRowActions } from "@/components/kai/holdings/holding-row-actions";
import { DataTable } from "@/components/app-ui/data-table";
import { PortfolioReviewHoldingsFilter, type ReviewHoldingsFilter } from "@/components/kai/holdings/portfolio-review-holdings-filter";
import { HoldingGainLoss } from "@/components/kai/holdings/holding-gain-loss";
import { toHoldingViewModel } from "@/components/kai/holdings/holding-view-model";


import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  useCache,
  type PortfolioData as CachedPortfolioData,
} from "@/lib/cache/cache-context";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { VaultService } from "@/lib/services/vault-service";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import {
  Card as MorphyCard, 
  CardContent, 
  CardHeader, 
  CardTitle,
} from "@/lib/morphy-ux/card";
import { EditHoldingModal } from "@/components/kai/modals/edit-holding-modal";
import { findHoldingValidationIssue, holdingValueIssue, isCashEquivalentHolding, type HoldingValidationIssue } from "@/lib/kai/holding-validation";
import { scrollAppToTop } from "@/lib/navigation/use-scroll-reset";
import { toInvestorMessage } from "@/lib/copy/investor-language";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { ROUTES } from "@/lib/navigation/routes";
import {
  buildFinancialDomainSummary,
  buildStatementSource,
} from "@/lib/kai/brokerage/financial-sources";
import {
  computeStatementImportId,
  upsertStatementSnapshot,
} from "@/lib/kai/brokerage/statement-import-identity";
import {
  KAI_AUXILIARY_STEP_TIMEOUT_MS,
  runKaiStepWithTimeout,
} from "@/lib/kai/brokerage/kai-operation-timeout";
import { normalizeStoredPortfolio } from "@/lib/utils/portfolio-normalize";
import { groupHoldingPositions, prepareHoldingEntryEdit, type HoldingPosition } from "@/lib/kai/holding-positions";
import type { Holding as PortfolioHolding } from "@/components/kai/types/portfolio";
import { AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";




// =============================================================================
// TYPES
// =============================================================================

export type Holding = PortfolioHolding & { pending_delete?: boolean };

export interface AccountInfo {
  holder_name?: string;
  account_number?: string;
  account_type?: string;
  brokerage?: string;
  statement_period_start?: string;
  statement_period_end?: string;
}

export interface AccountSummary {
  beginning_value?: number;
  ending_value?: number;
  cash_balance?: number;
  equities_value?: number;
  declared_security_count?: number;
  securities_market_value?: number;
  pending_receivables?: number;
  change_in_value?: number;
  total_change?: number;
  net_deposits_withdrawals?: number;
  net_deposits_period?: number;
  net_deposits_ytd?: number;
  investment_gain_loss?: number;
  total_income_period?: number;
  total_income_ytd?: number;
  total_fees?: number;
}

export interface AssetAllocation {
  cash_pct?: number;
  cash_value?: number;
  equities_pct?: number;
  equities_value?: number;
  bonds_pct?: number;
  bonds_value?: number;
  real_assets_pct?: number;
  real_assets_value?: number;
  other_pct?: number;
  other_value?: number;
}

export interface IncomeSummary {
  dividends_taxable?: number;
  interest_income?: number;
  total_income?: number;
}

export interface RealizedGainLoss {
  short_term_gain?: number;
  long_term_gain?: number;
  net_realized?: number;
}

export interface QualityReport {
  raw_count?: number;
  validated_count?: number;
  aggregated_count?: number;
  holdings_count?: number;
  investable_positions_count?: number;
  cash_positions_count?: number;
  allocation_coverage_pct?: number;
  symbol_trust_coverage_pct?: number;
  parser_quality_score?: number;
  quality_gate?: Record<string, unknown>;
  dropped_reasons?: Record<string, number>;
  diagnostics?: Record<string, unknown>;
}

export interface PortfolioData {
  account_info?: AccountInfo;
  account_summary?: AccountSummary;
  asset_allocation?: AssetAllocation;
  holdings?: Holding[];
  income_summary?: IncomeSummary;
  realized_gain_loss?: RealizedGainLoss;
  transactions?: Array<Record<string, unknown>>;
  activity_and_transactions?: Array<Record<string, unknown>>;
  historical_values?: Array<Record<string, unknown>>;
  cash_flow?: Record<string, unknown>;
  cash_management?: Record<string, unknown>;
  projections_and_mrd?: Record<string, unknown>;
  legal_and_disclosures?: string[];
  quality_report_v2?: QualityReport;
  raw_extract_v2?: Record<string, unknown>;
  analytics_v2?: Record<string, unknown>;
  source_metadata?: {
    source_type?: string;
    source_label?: string;
    source_id?: string;
    active_snapshot_id?: string;
    is_editable?: boolean;
  };
  domain_intent?: {
    primary: string;
    source: string;
    captured_sections: readonly string[];
    updated_at: string;
  };
  parse_fallback?: boolean;
  cash_balance?: number;
  total_value?: number;
}

export interface PortfolioReviewViewProps {
  /** Parsed portfolio data from Gemini */
  portfolioData: PortfolioData;
  /** User ID for saving */
  userId: string;
  /** Vault key for encryption (optional; create/unlock flow may run later) */
  vaultKey?: string;
  /** VAULT_OWNER token for authentication (required on native) */
  vaultOwnerToken?: string;
  /** Callback when save completes successfully */
  onSaveComplete: (data: PortfolioData) => void | Promise<void>;
  /**
   * Setup-only persistence adapter. It records a reviewed portfolio for the
   * master Finish setup transaction instead of creating a vault mid-journey.
   */
  onStageForFinish?: (data: PortfolioData) => void | Promise<void>;
  /** Completes the setup capability after local staging without warming PKM caches. */
  onStageComplete?: () => void | Promise<void>;
  /** Callback to re-import */
  onReimport: () => void;
  /** Callback to go back */
  onBack?: () => void;
  /** Additional CSS classes */
  className?: string;
}

type ReviewHoldingRow = Holding & {
  client_id: string;
  source_index: number;
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatCurrency(value: number | undefined | null, currency = "USD"): string {
  if (value === undefined || value === null) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: /^[A-Z]{3}$/i.test(currency) ? currency : "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function _formatPercent(value: number | undefined | null): string {
  if (value === undefined || value === null) return "0.00%";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function compareHoldingsByNameAsc<T extends { name?: string; symbol?: string }>(
  left: T,
  right: T
): number {
  const leftName = String(left.name || "").trim();
  const rightName = String(right.name || "").trim();
  const leftSymbol = String(left.symbol || "").trim();
  const rightSymbol = String(right.symbol || "").trim();
  const leftKey = leftName || leftSymbol;
  const rightKey = rightName || rightSymbol;

  if (!leftKey && !rightKey) return 0;
  if (!leftKey) return 1;
  if (!rightKey) return -1;

  return leftKey.localeCompare(rightKey, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function deriveRiskBucket(holdings: Holding[]): string {
  if (!holdings || holdings.length === 0) return "unknown";

  const totalValue = holdings.reduce(
    (sum, h) => sum + (h.market_value || 0),
    0
  );
  if (totalValue === 0) return "unknown";

  // Sort by value descending
  const sorted = [...holdings].sort(
    (a, b) => (b.market_value || 0) - (a.market_value || 0)
  );
  const topHoldingPct =
    sorted.length > 0 ? ((sorted[0]?.market_value || 0) / totalValue) * 100 : 0;

  if (topHoldingPct > 30) return "aggressive";
  if (topHoldingPct > 15) return "moderate";
  return "conservative";
}

function getPositionSide(holding: Holding): "long" | "short" | "liability" {
  if (holding.position_side === "long" || holding.position_side === "short" || holding.position_side === "liability") {
    return holding.position_side;
  }
  if (holding.is_liability_position) return "liability";
  if (holding.is_short_position) return "short";
  const qty = toFiniteNumber(holding.quantity);
  const marketValue = toFiniteNumber(holding.market_value);
  if ((holding.is_cash_equivalent || isCashEquivalentHolding(holding)) && (marketValue ?? 0) < 0) {
    return "liability";
  }
  if ((qty ?? 0) < 0 || (marketValue ?? 0) < 0) {
    return "short";
  }
  return "long";
}

function inferHoldingIdentifierType(holding: Holding): "ticker" | "cusip" | "derived" {
  if (holding.identifier_type === "ticker" || holding.identifier_type === "cusip") {
    return holding.identifier_type;
  }
  const symbol = String(holding.symbol || "").trim().toUpperCase();
  if (/^[A-Z][A-Z0-9.\-]{0,5}$/.test(symbol)) return "ticker";
  const symbolCusip = String(holding.symbol_cusip || "").trim().toUpperCase();
  if (/^[0-9A-Z]{8,12}$/.test(symbolCusip) || /^[0-9A-Z]{8,12}$/.test(symbol)) return "cusip";
  return "derived";
}

function inferInstrumentKind(holding: Holding, isCashEquivalent: boolean): string {
  if (holding.instrument_kind) return holding.instrument_kind;
  if (isCashEquivalent) return "cash_equivalent";
  const hint = `${holding.asset_type || ""} ${holding.name || ""}`.toLowerCase();
  if (hint.includes("bond") || hint.includes("fixed income") || hint.includes("treasury")) {
    return "fixed_income";
  }
  if (
    hint.includes("real estate") ||
    hint.includes("reit") ||
    hint.includes("real asset") ||
    hint.includes("gold")
  ) {
    return "real_asset";
  }
  if (hint.includes("equity") || hint.includes("stock") || hint.includes("etf") || hint.includes("fund")) {
    return "equity";
  }
  return "other";
}

function inferAnalyzeEligibility(
  holding: Holding,
  isInvestable: boolean,
): boolean {
  if (typeof holding.analyze_eligible === "boolean") {
    return holding.analyze_eligible;
  }
  if (!isInvestable) return false;

  const listingStatus = String(holding.security_listing_status || "")
    .trim()
    .toLowerCase();
  const symbolKind = String(holding.symbol_kind || "")
    .trim()
    .toLowerCase();

  if (listingStatus === "non_sec_common_equity") return false;
  if (listingStatus === "fixed_income") return false;
  if (listingStatus === "cash_or_sweep") return false;

  if (holding.is_sec_common_equity_ticker === true) return true;
  if (listingStatus === "sec_common_equity") return true;
  if (symbolKind === "us_common_equity_ticker") return true;

  return isInvestable;
}

function extractSaveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const trimmed = error.message.trim();
    if (trimmed) return trimmed;
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

function isAuthFailureMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("vault owner token")
  );
}

function normalizeHoldingForStorage({ pending_delete: _pendingDelete, ...holding }: Holding): Holding {
  const isCashEquivalent = isCashEquivalentHolding(holding);
  const identifierType = inferHoldingIdentifierType(holding);
  const isInvestable = !isCashEquivalent && identifierType === "ticker";
  const analyzeEligible = inferAnalyzeEligibility(holding, isInvestable);
  return {
    ...holding,
    identifier_type: identifierType,
    instrument_kind: inferInstrumentKind(holding, isCashEquivalent),
    is_cash_equivalent: isCashEquivalent,
    is_investable: isInvestable,
    analyze_eligible: analyzeEligible,
    debate_eligible: isInvestable,
    optimize_eligible: isInvestable,
  };
}

function holdingsForStorage(holdings: Holding[]): Holding[] {
  return normalizeStoredPortfolio({ holdings: holdings.map(normalizeHoldingForStorage) }, {
    preserveEntries: true,
  }).holdings as Holding[];
}

function isHoldingAnalyzeEligible(holding: Holding): boolean {
  if (holding.pending_delete) return false;
  if (holding.is_cash_equivalent === true || isCashEquivalentHolding(holding)) return false;
  if (typeof holding.analyze_eligible === "boolean") return holding.analyze_eligible;
  if (typeof holding.is_investable === "boolean") return holding.is_investable;
  const kind = String(holding.instrument_kind || "").toLowerCase();
  if (kind.includes("equity")) return true;
  return false;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const normalized = trimmed
      .replace(/[,$\s]/g, "")
      .replace(/%/g, "")
      .replace(/[()]/g, "");
    if (!normalized) return undefined;
    const asNumber = Number(trimmed.startsWith("(") && trimmed.endsWith(")") ? `-${normalized}` : normalized);
    return Number.isFinite(asNumber) ? asNumber : undefined;
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function compactRecord<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => {
      if (entryValue === undefined || entryValue === null) return false;
      if (typeof entryValue === "string" && entryValue.trim().length === 0) return false;
      return true;
    })
  ) as Partial<T>;
}

function hasRecordValues(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value) && Object.keys(value as Record<string, unknown>).length > 0;
}

function sanitizeAccountSummary(value: unknown): AccountSummary {
  const record = toRecord(value);
  if (!record) return {};
  return compactRecord({
    beginning_value: toFiniteNumber(record.beginning_value),
    ending_value: toFiniteNumber(record.ending_value),
    cash_balance: toFiniteNumber(record.cash_balance),
    equities_value: toFiniteNumber(record.equities_value),
    declared_security_count: toFiniteNumber(record.declared_security_count),
    securities_market_value: toFiniteNumber(record.securities_market_value),
    pending_receivables: toFiniteNumber(record.pending_receivables),
    change_in_value: toFiniteNumber(record.change_in_value),
    total_change: toFiniteNumber(record.total_change),
    net_deposits_withdrawals: toFiniteNumber(record.net_deposits_withdrawals),
    net_deposits_period: toFiniteNumber(record.net_deposits_period),
    net_deposits_ytd: toFiniteNumber(record.net_deposits_ytd),
    investment_gain_loss: toFiniteNumber(record.investment_gain_loss),
    total_income_period: toFiniteNumber(record.total_income_period),
    total_income_ytd: toFiniteNumber(record.total_income_ytd),
    total_fees: toFiniteNumber(record.total_fees),
  } satisfies AccountSummary) as AccountSummary;
}

function sanitizeAssetAllocation(value: unknown): AssetAllocation {
  if (Array.isArray(value)) {
    const bucketTotals: Record<"cash" | "equities" | "bonds" | "real_assets" | "other", number> = {
      cash: 0,
      equities: 0,
      bonds: 0,
      real_assets: 0,
      other: 0,
    };
    const bucketPct: Record<"cash" | "equities" | "bonds" | "real_assets" | "other", number> = {
      cash: 0,
      equities: 0,
      bonds: 0,
      real_assets: 0,
      other: 0,
    };
    let totalMarketValue = 0;

    for (const row of value) {
      const record = toRecord(row);
      if (!record) continue;
      const category = String(
        record.category || record.asset_class || record.asset_type || ""
      ).trim().toLowerCase();
      const marketValue = toFiniteNumber(
        record.market_value ?? record.value ?? record.amount
      );
      const percentage = toFiniteNumber(
        record.percentage ?? record.pct ?? record.weight
      );

      let bucket: keyof typeof bucketTotals = "other";
      if (category.includes("cash")) bucket = "cash";
      else if (
        category.includes("fixed income") ||
        category.includes("bond") ||
        category.includes("taxable") ||
        category.includes("non-taxable")
      ) {
        bucket = "bonds";
      } else if (
        category.includes("real asset") ||
        category.includes("real estate") ||
        category.includes("commod")
      ) {
        bucket = "real_assets";
      } else if (
        category.includes("equit") ||
        category.includes("stock") ||
        category.includes("fund")
      ) {
        bucket = "equities";
      }

      if (marketValue !== undefined) {
        bucketTotals[bucket] += marketValue;
        totalMarketValue += marketValue;
      }
      if (percentage !== undefined) {
        bucketPct[bucket] += percentage;
      }
    }

    const fromValue = (bucket: keyof typeof bucketTotals): number | undefined => {
      if (bucketPct[bucket] > 0) return bucketPct[bucket];
      if (totalMarketValue <= 0 || bucketTotals[bucket] <= 0) return undefined;
      return Number(((bucketTotals[bucket] / totalMarketValue) * 100).toFixed(2));
    };

    return compactRecord({
      cash_pct: fromValue("cash"),
      cash_value: bucketTotals.cash || undefined,
      equities_pct: fromValue("equities"),
      equities_value: bucketTotals.equities || undefined,
      bonds_pct: fromValue("bonds"),
      bonds_value: bucketTotals.bonds || undefined,
      real_assets_pct: fromValue("real_assets"),
      real_assets_value: bucketTotals.real_assets || undefined,
      other_pct: fromValue("other"),
      other_value: bucketTotals.other || undefined,
    } satisfies AssetAllocation) as AssetAllocation;
  }

  const record = toRecord(value);
  if (!record) return {};
  return compactRecord({
    cash_pct: toFiniteNumber(record.cash_pct),
    cash_value: toFiniteNumber(record.cash_value),
    equities_pct: toFiniteNumber(record.equities_pct),
    equities_value: toFiniteNumber(record.equities_value),
    bonds_pct: toFiniteNumber(record.bonds_pct),
    bonds_value: toFiniteNumber(record.bonds_value),
    real_assets_pct: toFiniteNumber(record.real_assets_pct),
    real_assets_value: toFiniteNumber(record.real_assets_value),
    other_pct: toFiniteNumber(record.other_pct),
    other_value: toFiniteNumber(record.other_value),
  } satisfies AssetAllocation) as AssetAllocation;
}

function hasSummaryValues(summary: AccountSummary): boolean {
  return (
    summary.beginning_value !== undefined ||
    summary.ending_value !== undefined ||
    summary.cash_balance !== undefined ||
    summary.equities_value !== undefined ||
    summary.declared_security_count !== undefined ||
    summary.securities_market_value !== undefined ||
    summary.pending_receivables !== undefined ||
    summary.change_in_value !== undefined ||
    summary.total_change !== undefined ||
    summary.net_deposits_withdrawals !== undefined ||
    summary.net_deposits_period !== undefined ||
    summary.net_deposits_ytd !== undefined ||
    summary.investment_gain_loss !== undefined ||
    summary.total_income_period !== undefined ||
    summary.total_income_ytd !== undefined ||
    summary.total_fees !== undefined
  );
}

function hasAllocationValues(allocation: AssetAllocation): boolean {
  return (
    allocation.cash_pct !== undefined ||
    allocation.cash_value !== undefined ||
    allocation.equities_pct !== undefined ||
    allocation.equities_value !== undefined ||
    allocation.bonds_pct !== undefined ||
    allocation.bonds_value !== undefined ||
    allocation.real_assets_pct !== undefined ||
    allocation.real_assets_value !== undefined ||
    allocation.other_pct !== undefined ||
    allocation.other_value !== undefined
  );
}

function isCashLikeHolding(holding: Holding): boolean {
  const symbol = String(holding.symbol || "").trim().toUpperCase();
  const name = String(holding.name || "").trim().toLowerCase();
  const assetType = String(holding.asset_type || "").trim().toLowerCase();
  if (symbol === "CASH" || symbol === "SWEEP" || symbol === "MMF") return true;
  if (name.includes("cash") || name.includes("sweep")) return true;
  if (assetType.includes("cash") || assetType.includes("money market")) return true;
  return false;
}

function deriveCashFromHoldings(holdings: Holding[]): number | undefined {
  const cash = holdings.filter(isCashLikeHolding);
  return cash.length ? cash.reduce((sum, holding) => sum + (toFiniteNumber(holding.market_value) ?? 0), 0) : undefined;
}

function deriveAssetAllocationFromHoldings(holdings: Holding[]): AssetAllocation {
  const bucketTotals: Record<"cash" | "equities" | "bonds" | "real_assets" | "other", number> = {
    cash: 0,
    equities: 0,
    bonds: 0,
    real_assets: 0,
    other: 0,
  };

  let totalMarketValue = 0;

  for (const holding of holdings) {
    const marketValue = toFiniteNumber(holding.market_value) ?? 0;
    if (marketValue <= 0) continue;

    const hint =
      `${holding.instrument_kind || ""} ${holding.asset_type || ""} ${holding.name || ""}`.toLowerCase();

    let bucket: keyof typeof bucketTotals = "other";
    if (isCashLikeHolding(holding) || holding.is_cash_equivalent) bucket = "cash";
    else if (hint.includes("bond") || hint.includes("fixed income") || hint.includes("treasury")) {
      bucket = "bonds";
    } else if (
      hint.includes("real estate") ||
      hint.includes("real asset") ||
      hint.includes("reit") ||
      hint.includes("commod")
    ) {
      bucket = "real_assets";
    } else if (
      hint.includes("equity") ||
      hint.includes("stock") ||
      hint.includes("etf") ||
      hint.includes("fund") ||
      hint.includes("adr")
    ) {
      bucket = "equities";
    }

    bucketTotals[bucket] += marketValue;
    totalMarketValue += marketValue;
  }

  const fromValue = (bucket: keyof typeof bucketTotals): number | undefined => {
    if (totalMarketValue <= 0 || bucketTotals[bucket] <= 0) return undefined;
    return Number(((bucketTotals[bucket] / totalMarketValue) * 100).toFixed(2));
  };

  return compactRecord({
    cash_pct: fromValue("cash"),
    cash_value: bucketTotals.cash || undefined,
    equities_pct: fromValue("equities"),
    equities_value: bucketTotals.equities || undefined,
    bonds_pct: fromValue("bonds"),
    bonds_value: bucketTotals.bonds || undefined,
    real_assets_pct: fromValue("real_assets"),
    real_assets_value: bucketTotals.real_assets || undefined,
    other_pct: fromValue("other"),
    other_value: bucketTotals.other || undefined,
  } satisfies AssetAllocation) as AssetAllocation;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function PortfolioReviewView({
  portfolioData: initialData,
  userId,
  vaultKey,
  vaultOwnerToken,
  onSaveComplete,
  onStageForFinish,
  onStageComplete,
  onReimport,
  onBack: _onBack,
  className,
}: PortfolioReviewViewProps) {
  const { setPortfolioData: setCachePortfolioData } = useCache();
  const { user } = useAuth();
  const {
    vaultKey: ctxVaultKey,
    vaultOwnerToken: ctxVaultOwnerToken,
    tokenExpiresAt: ctxTokenExpiresAt,
    unlockVault: contextUnlockVault,
    getVaultOwnerToken: contextGetVaultOwnerToken,
  } = useVault();
  const currentContextToken =
    typeof contextGetVaultOwnerToken === "function"
      ? contextGetVaultOwnerToken()
      : ctxVaultOwnerToken;
  const effectiveVaultKey = ctxVaultKey ?? vaultKey;
  const effectiveVaultOwnerToken = currentContextToken ?? vaultOwnerToken;

  // Editable state
  const [accountInfo, setAccountInfo] = useState<AccountInfo>(
    initialData.account_info || {}
  );
  const [accountSummary, _setAccountSummary] = useState<AccountSummary>(
    initialData.account_summary || {}
  );
  const [holdings, setHoldings] = useState<Holding[]>(
    (initialData.holdings || []).map((holding) => ({
      ...holding,
      pending_delete: Boolean(holding.pending_delete),
    }))
  );
  const [assetAllocation] = useState<AssetAllocation>(
    initialData.asset_allocation || {}
  );
  const [incomeSummary] = useState<IncomeSummary>(
    initialData.income_summary || {}
  );
  const [realizedGainLoss] = useState<RealizedGainLoss>(
    initialData.realized_gain_loss || {}
  );

  const [isSaving, setIsSaving] = useState(false);
  const [isBackgroundSaveRunning, setIsBackgroundSaveRunning] = useState(false);
  const setBusyOperation = useKaiSession((s) => s.setBusyOperation);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [pendingVaultSave, setPendingVaultSave] = useState(false);
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const createdVaultCopyRef = useRef(false);
  const createdVaultModeRef = useRef<string | null>(null);
  const continuationInFlightRef = useRef(false);
  const vaultUnlockSucceededRef = useRef(false);
  const handleSaveRef = useRef<() => Promise<void>>(async () => {});
  const saveInFlightRef = useRef(false);
  const isMountedRef = useRef(true);
  const [editingHolding, setEditingHolding] = useState<Holding | null>(null);
  const [holdingValidationIssue, setHoldingValidationIssue] = useState<HoldingValidationIssue | null>(null);
  const [editingHoldingIndex, setEditingHoldingIndex] = useState<number>(-1);
  const [expandedPositionId, setExpandedPositionId] = useState<string | null>(null);
  const [holdingsTab, setHoldingsTab] = useState<ReviewHoldingsFilter>("all");

  // Computed values
  // Scroll to top on mount to ensure clean view framing after progress view
  useEffect(() => {
    scrollAppToTop("auto");
  }, []);

  const serializeEditableState = useCallback(
    (nextAccountInfo: AccountInfo, nextHoldings: Holding[]): string =>
      JSON.stringify({
        accountInfo: nextAccountInfo,
        holdings: nextHoldings.map((holding) => ({
          ...holding,
          pending_delete: Boolean(holding.pending_delete),
        })),
      }),
    []
  );

  const baselineSnapshotRef = useRef(
    serializeEditableState(
      initialData.account_info || {},
      (initialData.holdings || []).map((holding) => ({
        ...holding,
        pending_delete: Boolean(holding.pending_delete),
      }))
    )
  );

  const currentEditableSnapshot = useMemo(
    () => serializeEditableState(accountInfo, holdings),
    [accountInfo, holdings, serializeEditableState]
  );

  useEffect(() => {
    setHasUnsavedChanges(currentEditableSnapshot !== baselineSnapshotRef.current);
  }, [currentEditableSnapshot]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const isBusySaving = isSaving || isBackgroundSaveRunning;

  useEffect(() => {
    setBusyOperation("portfolio_save", isSaving);
    return () => {
      setBusyOperation("portfolio_save", false);
    };
  }, [isSaving, setBusyOperation]);

  useEffect(() => {
    setBusyOperation("portfolio_review_active", true);
    return () => {
      setBusyOperation("portfolio_review_active", false);
    };
  }, [setBusyOperation]);

  useEffect(() => {
    setBusyOperation("portfolio_review_dirty", hasUnsavedChanges && !isBackgroundSaveRunning);
    return () => {
      setBusyOperation("portfolio_review_dirty", false);
    };
  }, [hasUnsavedChanges, isBackgroundSaveRunning, setBusyOperation]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges || isBusySaving) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [hasUnsavedChanges, isBusySaving]);

  useEffect(() => {
    let cancelled = false;

    async function loadVaultState() {
      if (!user) return;
      try {
        const next = await VaultService.checkVault(userId);
        if (!cancelled) setHasVault(next);
      } catch (error) {
        console.warn("[PortfolioReviewView] Failed to check vault existence:", error);
        if (!cancelled) setHasVault(null);
      }
    }

    void loadVaultState();

    return () => {
      cancelled = true;
    };
  }, [user, userId]);

  useEffect(() => {
    if (!pendingVaultSave) return;
    if (!effectiveVaultKey) return;
    if (continuationInFlightRef.current) return;

    setPendingVaultSave(false);
    continuationInFlightRef.current = true;
    void handleSaveRef.current().finally(() => {
      continuationInFlightRef.current = false;
    });
     
  }, [pendingVaultSave, effectiveVaultKey]);

  const activeHoldings = useMemo(
    () => holdings.filter((holding) => !holding.pending_delete),
    [holdings]
  );
  const pendingDeleteCount = holdings.length - activeHoldings.length;

  const reportedCashBalance = useMemo(
    () =>
      toFiniteNumber(accountSummary.cash_balance) ??
      toFiniteNumber(initialData.cash_balance),
    [accountSummary.cash_balance, initialData.cash_balance]
  );

  const reportedTotalValue = useMemo(
    () =>
      toFiniteNumber(initialData.total_value) ??
      toFiniteNumber(accountSummary.ending_value),
    [initialData.total_value, accountSummary.ending_value]
  );

  const liveCashBalance = useMemo(() => {
    const holdingsCash = deriveCashFromHoldings(activeHoldings);
    if (hasUnsavedChanges && holdingsCash !== undefined) return holdingsCash;
    // Prefer statement/account summary cash when present.
    // Holdings-derived cash is only a fallback for sparse parses.
    if (reportedCashBalance !== undefined) return reportedCashBalance;
    return holdingsCash ?? 0;
  }, [activeHoldings, hasUnsavedChanges, reportedCashBalance]);

  const pendingReceivables = toFiniteNumber(accountSummary.pending_receivables) ?? 0;
  const totalValue = useMemo(() => {
    const holdingsTotal = activeHoldings.reduce(
      (sum, h) => sum + (toFiniteNumber(h.market_value) ?? 0),
      0
    );
    const holdingsCash = deriveCashFromHoldings(activeHoldings);
    const hasLiveHoldingsMarketValue = activeHoldings.some(
      (holding) => toFiniteNumber(holding.market_value) !== undefined
    );
    // When cash-equivalent positions are already in holdings, do not add cash again.
    const derivedTotal = holdingsTotal + (holdingsCash !== undefined ? 0 : liveCashBalance) + pendingReceivables;
    // Before edits, trust statement totals over derived sums. This avoids
    // rendering drift when parsed holdings are internally inconsistent.
    if (!hasUnsavedChanges && reportedTotalValue !== undefined) {
      return reportedTotalValue;
    }
    if (hasLiveHoldingsMarketValue) return derivedTotal;
    return reportedTotalValue ?? derivedTotal;
  }, [
    activeHoldings,
    hasUnsavedChanges,
    reportedTotalValue,
    liveCashBalance,
    pendingReceivables,
  ]);

  const totalUnrealizedGainLoss = useMemo(() => {
    return activeHoldings.reduce(
      (sum, h) => sum + (h.unrealized_gain_loss || 0),
      0
    );
  }, [activeHoldings]);

  const riskBucket = useMemo(() => deriveRiskBucket(activeHoldings), [activeHoldings]);

  const displayAssetAllocation = useMemo(() => {
    const liveAllocation = deriveAssetAllocationFromHoldings(activeHoldings);
    if (hasAllocationValues(liveAllocation)) return liveAllocation;
    return assetAllocation;
  }, [activeHoldings, assetAllocation]);

  // Handlers
  const handleDeleteHolding = useCallback((index: number) => {
    let action: "mark" | "restore" | null = null;
    setHoldings((prev) =>
      prev.map((holding, i) => {
        if (i !== index) return holding;
        const currentlyPendingDelete = Boolean(holding.pending_delete);
        action = currentlyPendingDelete ? "restore" : "mark";
        return {
          ...holding,
          pending_delete: !currentlyPendingDelete,
        };
      })
    );
    if (action === "restore") {
      toast.info("Holding restored");
      return;
    }
    toast.info("Holding marked for removal");
  }, []);

  const handleEditHolding = useCallback(
    (index: number) => {
      const row = holdings[index];
      if (!row) return;
      if (row.pending_delete) {
        toast.info("Restore this holding before editing.");
        return;
      }
      setHoldingValidationIssue(null);
      setEditingHolding({ ...row, pending_delete: false });
      setEditingHoldingIndex(index);
    },
    [holdings]
  );

  const closeHoldingModal = useCallback(() => {
    setHoldingValidationIssue(null);
    setEditingHolding(null);
    setEditingHoldingIndex(-1);
  }, []);

  const handleSaveHolding = useCallback(
    (updatedHolding: Holding) => {
      const quantity = Number(updatedHolding.quantity);
      const price = Number(updatedHolding.price);
      const marketValue = Number(updatedHolding.market_value);
      const isAddingNewHolding = editingHoldingIndex < 0;

      const issue = holdingValueIssue(updatedHolding);
      if (issue) { setHoldingValidationIssue(issue); return; }

      const normalizedHolding = prepareHoldingEntryEdit({
        ...updatedHolding, quantity, price, market_value: marketValue,
      }, holdings[editingHoldingIndex], holdings);

      setHoldings((prev) => {
        const next = [...prev];
        if (editingHoldingIndex >= 0 && editingHoldingIndex < next.length) {
          const existing = next[editingHoldingIndex];
          if (!existing) return next;
          next[editingHoldingIndex] = {
            ...existing,
            ...normalizedHolding,
            pending_delete: false,
          };
          return next;
        }
        next.push({
          ...normalizedHolding,
          pending_delete: false,
        });
        return next;
      });
      closeHoldingModal();
      if (isAddingNewHolding) {
        toast.success("Holding added");
      }
    },
    [closeHoldingModal, editingHoldingIndex, holdings]
  );

  const handleAddHolding = useCallback(() => {
    const newHolding: Holding = {
      symbol: "",
      identifier_type: "ticker",
      name: "",
      quantity: 0,
      price: 0,
      market_value: 0,
      instrument_kind: "equity",
      is_cash_equivalent: false,
      is_investable: false,
      analyze_eligible: false,
      debate_eligible: false,
      optimize_eligible: false,
      pending_delete: false,
    };
    setEditingHolding(newHolding);
    setEditingHoldingIndex(-1);
  }, []);

  const tableHoldingRows = useMemo(
    () => groupHoldingPositions(holdings.map((holding, index): ReviewHoldingRow => ({
      ...normalizeHoldingForStorage(holding),
      pending_delete: holding.pending_delete,
      client_id: "holding-" + index,
      source_index: index,
    }))).sort(compareHoldingsByNameAsc),
    [holdings]
  );

  const holdingTables = useMemo(
    () => ({
      all: tableHoldingRows,
      analyzeEligible: tableHoldingRows.filter((holding) => isHoldingAnalyzeEligible(holding)),
      nonAnalyzable: tableHoldingRows.filter(
        (holding) => !isHoldingAnalyzeEligible(holding) && !isCashEquivalentHolding(holding)
      ),
      cashSweep: tableHoldingRows.filter((holding) => isCashEquivalentHolding(holding)),
    }),
    [tableHoldingRows]
  );

  function entryActions(entry: ReviewHoldingRow, label = entry.symbol) {
    return <HoldingRowActions
      symbol={label}
      isDeleted={entry.pending_delete}
      disableEdit={entry.pending_delete}
      layout="row"
      className="w-auto"
      onEdit={() => handleEditHolding(entry.source_index)}
      onToggleDelete={() => handleDeleteHolding(entry.source_index)}
    />;
  }

  function positionLabel(position: HoldingPosition<ReviewHoldingRow>) {
    const side = getPositionSide(position);
    const expanded = expandedPositionId === position.client_id;
    return (
      <div className="min-w-0">
        <p title={position.symbol} className={cn("ui-text-row-label-emphasized truncate", position.pending_delete && "line-through")}>{position.symbol}</p>
        <p title={position.name} className="ui-text-row-description truncate text-muted-foreground">
          {position.name || "Unnamed security"}{side === "long" ? "" : " · " + side}
        </p>
        {position.entries.length > 1 ? (
          <div>
            <button
              type="button"
              aria-expanded={expanded}
              className="ui-text-row-description inline-flex min-h-11 cursor-pointer items-center gap-1.5 text-primary"
              onClick={() => setExpandedPositionId(expanded ? null : position.client_id)}
            >
              {position.entries.length} entries
              <ChevronDown
                className={cn("size-3 shrink-0 motion-safe:transition-transform", expanded && "rotate-180")}
                aria-hidden="true"
              />
            </button>
            {expanded ? <ul className="divide-y divide-border">
              {position.entries.map((entry, index) => (
                <li key={entry.client_id} className="flex min-h-11 items-center justify-between gap-2">
                  <div className="ui-text-row-description tabular-nums">
                    <p className={cn(entry.pending_delete && "line-through text-muted-foreground")}>
                      {entry.quantity.toLocaleString()} · {positionValue(entry)}
                    </p>
                    {entry.acquisition_date ? <p className="text-muted-foreground">{entry.acquisition_date}</p> : null}
                  </div>
                  {entryActions(entry, entry.symbol + " entry " + (index + 1))}
                </li>
              ))}
            </ul> : null}
          </div>
        ) : null}
      </div>
    );
  }

  function positionValue(holding: Holding) {
    return formatCurrency(holding.market_value, holding.currency || holding.iso_currency_code);
  }

  function sharesAtPrice(holding: Holding) {
    const quantity = Math.abs(holding.quantity).toLocaleString(undefined, { maximumFractionDigits: 4 });
    return quantity + (holding.price_unavailable ? " @ —" : " @ " + formatCurrency(holding.price, holding.currency || holding.iso_currency_code));
  }

  const holdingsTableColumns: ColumnDef<HoldingPosition<ReviewHoldingRow>>[] = [
    {
      accessorKey: "symbol",
      header: "Holding",
      cell: ({ row }) => positionLabel(row.original),
    },
    {
      id: "position",
      header: "Shares @ Price",
      cell: ({ row }) => <span className="ui-text-row-description tabular-nums">{sharesAtPrice(row.original)}</span>,
    },
    {
      accessorKey: "market_value",
      header: "Market value",
      cell: ({ row }) => <span className="ui-text-row-label-emphasized tabular-nums">{positionValue(row.original)}</span>,
    },
    {
      accessorKey: "unrealized_gain_loss",
      header: "Gain / Loss",
      cell: ({ row }) => <HoldingGainLoss holding={toHoldingViewModel(row.original, totalValue)}
        className="ui-text-row-description tabular-nums" />,
    },
    {
      id: "row_actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => row.original.entries.length === 1 ? entryActions(row.original.entries[0]!) : null,
    },
  ];

  const resolveVaultOwnerTokenForSave = useCallback(
    async (forceRefresh = false): Promise<string | undefined> => {
      if (!userId || !effectiveVaultKey) return undefined;

      try {
        const issued = await VaultService.getOrIssueVaultOwnerToken(
          userId,
          forceRefresh ? null : effectiveVaultOwnerToken ?? null,
          forceRefresh ? null : ctxTokenExpiresAt
        );

        if (typeof contextUnlockVault === "function") {
          contextUnlockVault(effectiveVaultKey, issued.token, issued.expiresAt);
        }

        return issued.token;
      } catch (tokenError) {
        console.error("[PortfolioReviewView] Failed to resolve VAULT_OWNER token:", tokenError);
        return undefined;
      }
    },
    [
      ctxTokenExpiresAt,
      contextUnlockVault,
      effectiveVaultKey,
      effectiveVaultOwnerToken,
      userId,
    ]
  );

  const handleSave = async () => {
    if (saveInFlightRef.current) {
      toast.info("Portfolio save already in progress.");
      return;
    }
    if (!userId) return;

    const invalid = findHoldingValidationIssue(holdings);
    if (invalid) {
      setHoldingValidationIssue(invalid.issue);
      setEditingHolding({ ...invalid.holding, pending_delete: false });
      setEditingHoldingIndex(invalid.index);
      return;
    }

    if (!effectiveVaultKey && onStageForFinish) {
      const stagedPayload: PortfolioData = {
        ...initialData,
        account_info: accountInfo,
        account_summary: hasUnsavedChanges ? { ...accountSummary, ending_value: totalValue, cash_balance: liveCashBalance } : accountSummary,
        total_value: totalValue,
        cash_balance: liveCashBalance,
        asset_allocation: assetAllocation,
        holdings: holdingsForStorage(activeHoldings),
        income_summary: incomeSummary,
        realized_gain_loss: realizedGainLoss,
      };

      saveInFlightRef.current = true;
      setIsSaving(true);
      try {
        await runKaiStepWithTimeout(
          "Staging portfolio for setup",
          Promise.resolve().then(() => onStageForFinish(stagedPayload)),
        );
        baselineSnapshotRef.current = serializeEditableState(accountInfo, holdings);
        if (isMountedRef.current) {
          setHasUnsavedChanges(false);
        }
        toast.success("Portfolio saved. It will be protected when you finish setup.");
        await runKaiStepWithTimeout(
          "Completing portfolio setup",
          Promise.resolve().then(() => onStageComplete?.()),
          KAI_AUXILIARY_STEP_TIMEOUT_MS,
        );
      } catch (error) {
        console.error("[PortfolioReview] Failed to stage setup portfolio:", error);
        toast.error("We could not save your portfolio for setup. Try again.");
      } finally {
        if (isMountedRef.current) {
          setIsSaving(false);
        }
        saveInFlightRef.current = false;
      }
      return;
    }

    const shouldVerifySave = process.env.NEXT_PUBLIC_PKM_VERIFY_SAVE === "true";
    const enableSaveProfiling = process.env.NEXT_PUBLIC_KAI_SAVE_PROFILING === "true";
    const nowMs = () =>
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const saveStartedAt = nowMs();
    const logSavePhase = (phase: string, phaseStartedAt: number) => {
      if (!enableSaveProfiling) return;
      const durationMs = nowMs() - phaseStartedAt;
      console.log(`[PortfolioReviewView][save] ${phase}: ${durationMs.toFixed(1)}ms`);
    };

    // If vault existence isn't resolved yet, resolve it on-demand so copy/flow is correct.
    let resolvedHasVault = hasVault;
    if (resolvedHasVault === null) {
      // Hold the in-flight claim across this await: a second tap (or the
      // vault continuation) arriving now would otherwise pass the guard above
      // and commit the same statement a second time.
      saveInFlightRef.current = true;
      try {
        resolvedHasVault = await runKaiStepWithTimeout(
          "Vault availability check",
          VaultService.checkVault(userId)
        );
        setHasVault(resolvedHasVault);
      } catch (error) {
        console.warn(
          "[PortfolioReviewView] Failed to resolve vault existence on save:",
          error
        );
        resolvedHasVault = null;
      } finally {
        saveInFlightRef.current = false;
      }
    }

    if (!effectiveVaultKey) {
      createdVaultCopyRef.current = resolvedHasVault === false;
      createdVaultModeRef.current = null;
      setPendingVaultSave(true);
      setVaultDialogOpen(true);
      toast.info(
        resolvedHasVault === false
          ? "Create your Vault to save your portfolio."
          : "Unlock your Vault to save your portfolio."
      );
      return;
    }

    saveInFlightRef.current = true;
    setIsSaving(true);
    let saveTaskId: string | null = null;

    try {
      let resolvedVaultOwnerToken = effectiveVaultOwnerToken;
      if (!resolvedVaultOwnerToken) {
        const tokenResolveStartedAt = nowMs();
        resolvedVaultOwnerToken = await runKaiStepWithTimeout(
          "Vault access verification",
          resolveVaultOwnerTokenForSave(false)
        );
        logSavePhase("vault owner token resolve", tokenResolveStartedAt);
      }

      if (!resolvedVaultOwnerToken) {
        throw new Error(
          "We could not complete Vault access. Unlock once and try again."
        );
      }

      const capturedSections = [
        "account_info",
        "account_summary",
        "asset_allocation",
        "holdings",
        "income_summary",
        "realized_gain_loss",
        "cash_flow",
        "cash_management",
        "projections_and_mrd",
        "legal_and_disclosures",
      ] as const;

      const savedHoldings = holdingsForStorage(activeHoldings);
      const savedPositions = groupHoldingPositions(savedHoldings);
      const savePayload: PortfolioData = {
        account_info: accountInfo,
        account_summary: accountSummary,
        asset_allocation: assetAllocation,
        holdings: savedHoldings,
        historical_values: initialData.historical_values,
        income_summary: incomeSummary,
        realized_gain_loss: realizedGainLoss,
        cash_balance: toFiniteNumber(initialData.cash_balance),
        total_value: toFiniteNumber(initialData.total_value),
        parse_fallback: initialData.parse_fallback === true,
      };

      const optimisticCachePortfolioData: CachedPortfolioData = {
        ...(savePayload as unknown as CachedPortfolioData),
        account_info: {
          ...(savePayload.account_info || {}),
          brokerage_name: savePayload.account_info?.brokerage,
          account_holder: savePayload.account_info?.holder_name,
        },
      };
      setCachePortfolioData(userId, optimisticCachePortfolioData);
      CacheSyncService.onPortfolioUpserted(userId, optimisticCachePortfolioData);

      saveTaskId = AppBackgroundTaskService.startTask({
        userId,
        kind: "portfolio_save",
        title: "Portfolio save",
        description: "Securing and storing your portfolio in Vault.",
        routeHref: ROUTES.KAI_DASHBOARD,
      });

      const nowIso = new Date().toISOString();
      const blobLoadStartedAt = nowMs();
      const {
        domainData: existingFinancialRaw,
      } = await runKaiStepWithTimeout(
        "Vault portfolio load",
        PkmDomainResourceService.prepareDomainWriteContext({
          userId,
          domain: "financial",
          vaultKey: effectiveVaultKey,
          vaultOwnerToken: resolvedVaultOwnerToken,
        })
      );
      const existingFinancial = existingFinancialRaw ?? {};
      logSavePhase("blob load", blobLoadStartedAt);
      const mergeBuildStartedAt = nowMs();

      const parsedAccountSummary = sanitizeAccountSummary(accountSummary);
      const parsedAssetAllocation = sanitizeAssetAllocation(assetAllocation);
      const parsedCashBalance =
        toFiniteNumber(initialData.cash_balance) ?? parsedAccountSummary.cash_balance;
      const holdingsTotal = savedHoldings.reduce(
        (sum, holding) => sum + (toFiniteNumber(holding.market_value) ?? 0),
        0
      );
      const derivedCashBalance = deriveCashFromHoldings(savedHoldings);
      const holdingsIncludeCash = derivedCashBalance !== undefined;

      // 3. Append structured statement snapshot (no raw PDF bytes).
      const existingDocsValue = existingFinancial.documents;
      const existingDocsSource =
        existingDocsValue &&
        typeof existingDocsValue === "object" &&
        !Array.isArray(existingDocsValue)
          ? (existingDocsValue as Record<string, unknown>)
          : {};
      const existingDocs = { ...existingDocsSource };
      const existingStatements = existingDocs.statements;

      const statementTotalValue =
        toFiniteNumber(initialData.total_value) ??
        parsedAccountSummary.ending_value ??
        (holdingsTotal > 0
          ? holdingsTotal +
            (holdingsIncludeCash ? 0 : parsedCashBalance ?? derivedCashBalance ?? 0) + pendingReceivables
          : undefined);
      const resolvedCashBalance = hasUnsavedChanges ? liveCashBalance : parsedCashBalance ?? derivedCashBalance;
      const resolvedTotalValue =
        (hasUnsavedChanges ? totalValue : statementTotalValue) ??
        (holdingsTotal > 0
          ? holdingsTotal + (holdingsIncludeCash ? 0 : resolvedCashBalance ?? 0) + pendingReceivables
          : undefined) ??
        0;
      const derivedAssetAllocation = deriveAssetAllocationFromHoldings(savedHoldings);

      const resolvedAccountSummary = compactRecord({
        ...parsedAccountSummary,
        ending_value: resolvedTotalValue > 0 ? resolvedTotalValue : undefined,
        cash_balance: resolvedCashBalance,
      } satisfies AccountSummary) as AccountSummary;
      const resolvedAssetAllocation = hasAllocationValues(parsedAssetAllocation)
        ? parsedAssetAllocation
        : derivedAssetAllocation;

      const sparseSections: string[] = [];
      if (!hasSummaryValues(parsedAccountSummary)) sparseSections.push("account_summary");
      if (!hasAllocationValues(parsedAssetAllocation)) sparseSections.push("asset_allocation");
      if (!initialData.account_info || Object.keys(initialData.account_info).length === 0) {
        sparseSections.push("account_info");
      }

      const parseFallback = initialData.parse_fallback === true;

      const normalizedAccountInfo = compactRecord({
        holder_name: accountInfo.holder_name,
        account_number: accountInfo.account_number,
        account_type: accountInfo.account_type,
        brokerage: accountInfo.brokerage,
        statement_period_start: accountInfo.statement_period_start,
        statement_period_end: accountInfo.statement_period_end,
      } satisfies AccountInfo) as AccountInfo;
      const normalizedIncomeSummary = compactRecord({
        dividends_taxable: incomeSummary.dividends_taxable,
        interest_income: incomeSummary.interest_income,
        total_income: incomeSummary.total_income,
      } satisfies IncomeSummary) as IncomeSummary;
      const normalizedRealizedGainLoss = compactRecord({
        short_term_gain: realizedGainLoss.short_term_gain,
        long_term_gain: realizedGainLoss.long_term_gain,
        net_realized: realizedGainLoss.net_realized,
      } satisfies RealizedGainLoss) as RealizedGainLoss;

      const portfolioToSave: PortfolioData = {
        historical_values: initialData.historical_values,
        account_info: hasRecordValues(normalizedAccountInfo as Record<string, unknown>)
          ? normalizedAccountInfo
          : undefined,
        account_summary: hasSummaryValues(resolvedAccountSummary)
          ? resolvedAccountSummary
          : undefined,
        asset_allocation: hasAllocationValues(resolvedAssetAllocation)
          ? resolvedAssetAllocation
          : undefined,
        holdings: savedHoldings,
        income_summary: hasRecordValues(normalizedIncomeSummary as Record<string, unknown>)
          ? normalizedIncomeSummary
          : undefined,
        realized_gain_loss: hasRecordValues(
          normalizedRealizedGainLoss as Record<string, unknown>
        )
          ? normalizedRealizedGainLoss
          : undefined,
        cash_balance: resolvedCashBalance,
        total_value: resolvedTotalValue,
        parse_fallback: parseFallback,
        domain_intent: {
          primary: "financial",
          source: "kai_import_llm",
          captured_sections: capturedSections,
          updated_at: nowIso,
        },
      };

      // Content-derived, so re-saving this statement replaces its snapshot.
      const snapshotId = await computeStatementImportId(
        portfolioToSave as unknown as Record<string, unknown>
      );
      const statementAccountSummary = compactRecord({
        ...parsedAccountSummary,
        ending_value: statementTotalValue ?? parsedAccountSummary.ending_value,
        cash_balance: parsedCashBalance ?? derivedCashBalance,
      } satisfies AccountSummary) as AccountSummary;

      const snapshot = {
        id: snapshotId,
        imported_at: nowIso,
        schema_version: 2,
        domain_intent: {
          primary: "financial",
          secondary: "documents",
          source: "kai_import_llm",
          updated_at: nowIso,
        },
        source: {
          brokerage: accountInfo.brokerage || null,
          statement_period_start: accountInfo.statement_period_start || null,
          statement_period_end: accountInfo.statement_period_end || null,
          account_type: accountInfo.account_type || null,
        },
        account_info: portfolioToSave.account_info || null,
        account_summary: hasSummaryValues(statementAccountSummary)
          ? statementAccountSummary
          : null,
        holdings: savedHoldings || [],
        transactions:
          initialData.transactions ||
          initialData.activity_and_transactions ||
          [],
        asset_allocation: hasAllocationValues(parsedAssetAllocation)
          ? parsedAssetAllocation
          : null,
        income_summary: portfolioToSave.income_summary || null,
        realized_gain_loss: portfolioToSave.realized_gain_loss || null,
        cash_flow: initialData.cash_flow || null,
        cash_management: initialData.cash_management || null,
        projections_and_mrd: initialData.projections_and_mrd || null,
        legal_and_disclosures: initialData.legal_and_disclosures || [],
        quality_report_v2: initialData.quality_report_v2 || null,
        raw_extract_v2: initialData.raw_extract_v2 || null,
        canonical_v2: portfolioToSave,
        analytics_v2: initialData.analytics_v2 || null,
        parse_context: {
          parse_fallback: parseFallback,
          sparse_sections: sparseSections,
          fallback_merge_applied: false,
        },
      };
      const nextDocsDomain = {
        schema_version: 1,
        statements: upsertStatementSnapshot(existingStatements, snapshot),
        domain_intent: {
          primary: "financial",
          secondary: "documents",
          source: "kai_import_llm",
          captured_sections: capturedSections,
          updated_at: nowIso,
        },
      };

      const lastQuality = initialData.quality_report_v2;
      const lastQualityRawCount =
        typeof (lastQuality as Record<string, unknown> | undefined)?.raw_count === "number"
          ? ((lastQuality as Record<string, unknown>).raw_count as number)
          : undefined;
      const lastQualityValidatedCount =
        typeof (lastQuality as Record<string, unknown> | undefined)?.validated_count === "number"
          ? ((lastQuality as Record<string, unknown>).validated_count as number)
          : undefined;
      const lastQualityScore =
        typeof lastQualityValidatedCount === "number" &&
        typeof lastQualityRawCount === "number" &&
        lastQualityRawCount > 0
          ? Number((lastQualityValidatedCount / lastQualityRawCount).toFixed(4))
          : undefined;
      const existingDocsStatementEnd =
        typeof existingDocs.last_statement_end === "string"
          ? (existingDocs.last_statement_end as string)
          : undefined;
      const existingDocsBrokerage =
        typeof existingDocs.last_brokerage === "string"
          ? (existingDocs.last_brokerage as string)
          : undefined;

      const docsSummary: Record<string, unknown> = {
        documents_count: nextDocsDomain.statements.length,
        last_statement_end:
          accountInfo.statement_period_end ||
          existingDocsStatementEnd ||
          null,
        last_brokerage:
          accountInfo.brokerage || existingDocsBrokerage || null,
        parse_fallback_last_import: parseFallback,
        sparse_sections_last_import: sparseSections,
        last_updated: nowIso,
      };
      if (lastQualityScore !== undefined) {
        docsSummary.last_quality_score = lastQualityScore;
      }

      const canonicalPortfolio = {
        ...portfolioToSave,
        source_metadata: {
          source_type: "statement",
          source_label: "Statement",
          source_id: snapshotId,
          active_snapshot_id: snapshotId,
          is_editable: true,
        },
        domain_intent: {
          primary: "financial",
          secondary: "portfolio",
          source: "kai_import_llm",
          captured_sections: capturedSections,
          updated_at: nowIso,
        },
      };

      const nextFinancialDomain = {
        ...existingFinancial,
        schema_version: 3,
        domain_intent: {
          primary: "financial",
          source: "domain_registry_prepopulate",
          contract_version: 2,
          updated_at: nowIso,
        },
        portfolio: canonicalPortfolio,
        analytics: initialData.analytics_v2 || existingFinancial.analytics || null,
        documents: nextDocsDomain,
        sources: {
          ...(
            existingFinancial.sources &&
            typeof existingFinancial.sources === "object" &&
            !Array.isArray(existingFinancial.sources)
              ? (existingFinancial.sources as Record<string, unknown>)
              : {}
          ),
          active_source: "statement",
          statement: buildStatementSource(
            existingFinancial,
            nextDocsDomain.statements as Record<string, unknown>[],
            snapshotId,
            nowIso
          ),
        },
        updated_at: nowIso,
      };

      const financialSummary = {
        ...buildFinancialDomainSummary(nextFinancialDomain as Record<string, unknown>),
        intent_source: "kai_import_llm",
        attribute_count: savedHoldings.length,
        item_count: savedHoldings.length,
        holdings_count: savedPositions.length,
        investable_positions_count: savedPositions.filter(
          (holding) => holding.is_investable
        ).length,
        cash_positions_count: savedPositions.filter(
          (holding) => holding.is_cash_equivalent
        ).length,
        allocation_coverage_pct: hasAllocationValues(resolvedAssetAllocation) ? 1 : 0,
        parser_quality_score:
          typeof lastQualityScore === "number" ? lastQualityScore : null,
        last_statement_total_value: resolvedTotalValue,
        portfolio_risk_bucket: riskBucket,
        risk_bucket: riskBucket,
        has_income_data: !!incomeSummary.total_income,
        has_realized_gains: !!realizedGainLoss.net_realized,
        parse_fallback_last_import: parseFallback,
        sparse_sections_last_import: sparseSections,
        domain_contract_version: 2,
        intent_map: [
          "portfolio",
          "analytics",
          "profile",
          "documents",
          "analysis_history",
          "runtime",
          "analysis.decisions",
        ],
        ...docsSummary,
        last_updated: nowIso,
      };
      logSavePhase("merge/build", mergeBuildStartedAt);

      // 4. Store canonical financial domain with full-blob merge semantics.
      const encryptStoreStartedAt = nowMs();
      const storeMergedDomain = async (vaultOwnerTokenToUse: string) =>
        PkmWriteCoordinator.saveMergedDomain({
          userId,
          domain: "financial",
          vaultKey: effectiveVaultKey,
          vaultOwnerToken: vaultOwnerTokenToUse,
          confirmation: {
            confirmedByUser: true,
            surface: "import",
            source: "kai_portfolio_review_confirm",
          },
          build: () => ({
            domainData: nextFinancialDomain as unknown as Record<string, unknown>,
            summary: financialSummary,
            mergeDecision: {
              merge_mode: "replace_domain",
              target_domain: "financial",
              match_reason:
                "Statement import is authoritative for the active financial portfolio projection.",
            },
          }),
        });

      let financialResult;
      try {
        financialResult = await runKaiStepWithTimeout(
          "Vault portfolio save",
          storeMergedDomain(resolvedVaultOwnerToken)
        );
      } catch (storeError) {
        const storeMessage = extractSaveErrorMessage(
          storeError,
          "Failed to store encrypted portfolio."
        );
        if (isAuthFailureMessage(storeMessage)) {
          const refreshedToken = await resolveVaultOwnerTokenForSave(true);
          if (!refreshedToken) {
            throw storeError;
          }
          resolvedVaultOwnerToken = refreshedToken;
          financialResult = await runKaiStepWithTimeout(
            "Vault portfolio save",
            storeMergedDomain(refreshedToken)
          );
        } else {
          throw storeError;
        }
      }
      logSavePhase("encrypt/store", encryptStoreStartedAt);

      if (!financialResult.success) {
        if (financialResult.conflict) {
          throw new Error(
            financialResult.message ||
              "Vault changed on another device. Refresh and save again."
          );
        }
        // saveMergedDomain already resolves a specific, user-appropriate
        // message for every non-conflict failure it can produce (upgrade
        // required, sharing impact changed, vault not unlocked, or its own
        // generic "couldn't save" fallback) -- discarding it here and
        // always throwing the same opaque string is what turned a real,
        // diagnosable backend failure into an unexplained "Backend returned
        // failure on store" report.
        throw new Error(
          financialResult.message || "Backend returned failure on store"
        );
      }

      const postSaveSyncStartedAt = nowMs();
      // 5. Prime/invalidate deterministic cache entries for all financial reads.
      const cachePortfolioData: CachedPortfolioData = {
        ...(portfolioToSave as unknown as CachedPortfolioData),
        account_info: {
          ...(portfolioToSave.account_info || {}),
          brokerage_name: portfolioToSave.account_info?.brokerage,
          account_holder: portfolioToSave.account_info?.holder_name,
        },
      };
      setCachePortfolioData(userId, cachePortfolioData);
      CacheSyncService.onPortfolioUpserted(
        userId,
        cachePortfolioData
      );

      if (saveTaskId) {
        AppBackgroundTaskService.completeTask(
          saveTaskId,
          createdVaultCopyRef.current
            ? "Vault created and portfolio saved."
            : "Portfolio saved to Vault."
        );
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("kai:portfolio-saved", {
            detail: {
              userId,
            },
          })
        );
      }
      toast.success("Portfolio saved to Vault.");
      if (shouldVerifySave) {
        void (async () => {
          try {
            const readBack = await PersonalKnowledgeModelService.getDomainData(
              userId,
              "financial",
              resolvedVaultOwnerToken
            );
            if (!readBack) {
              console.warn("[PortfolioReview] Read-back verification failed: no data returned");
            }
          } catch (verifyErr) {
            console.warn("[PortfolioReview] Read-back verification error:", verifyErr);
          }
        })();
      }
      baselineSnapshotRef.current = serializeEditableState(accountInfo, holdings);
      if (isMountedRef.current) {
        setHasUnsavedChanges(false);
      }
      void runKaiStepWithTimeout(
        "Finalizing save",
        Promise.resolve()
          .then(() => onSaveComplete(savePayload))
          .catch((saveCompleteError) => {
            console.error("[PortfolioReview] onSaveComplete failed:", saveCompleteError);
          }),
        KAI_AUXILIARY_STEP_TIMEOUT_MS,
      ).catch((saveCompleteError) => {
        console.warn(
          "[PortfolioReview] Save finalization exceeded its deadline:",
          saveCompleteError,
        );
      });
      logSavePhase("post-save sync", postSaveSyncStartedAt);
      logSavePhase("total", saveStartedAt);
    } catch (error) {
      console.error("Save error:", error);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("kai:portfolio-save-failed", {
            detail: {
              userId,
              error: extractSaveErrorMessage(error, "Failed to save portfolio"),
            },
          })
        );
      }
      if (saveTaskId) {
        AppBackgroundTaskService.failTask(
          saveTaskId,
          extractSaveErrorMessage(error, "Failed to save portfolio"),
          "Portfolio save failed. Reopen review and try again."
        );
      }
      toast.error(extractSaveErrorMessage(error, "Failed to save portfolio"));
    } finally {
      if (isMountedRef.current) {
        setIsSaving(false);
        setIsBackgroundSaveRunning(false);
      }
      saveInFlightRef.current = false;
      createdVaultCopyRef.current = false;
      createdVaultModeRef.current = null;
    }
  };
  handleSaveRef.current = handleSave;

  const confirmDiscardChanges = useCallback((): boolean => {
    if (!hasUnsavedChanges || isBusySaving) return true;
    return window.confirm(
      "You have unsaved portfolio changes. Leaving now will discard them."
    );
  }, [hasUnsavedChanges, isBusySaving]);

  const handleReimportAttempt = useCallback(() => {
    if (!confirmDiscardChanges()) return;
    onReimport();
  }, [confirmDiscardChanges, onReimport]);

  const statementCheck = initialData.quality_report_v2?.quality_gate;
  const statementCount = toFiniteNumber(statementCheck?.declared_security_count);
  const extractedCount = toFiniteNumber(statementCheck?.extracted_security_count);
  const hasCountMismatch = statementCount !== undefined && extractedCount !== undefined && statementCount !== extractedCount;
  const hasValueMismatch = statementCheck?.reconciled_within_cent === false;

  return (
    <AppPageContentRegion className={cn(financeStyles.detail, "relative min-w-0 space-y-4 pb-4", className)}>
      <PageHeader title="Review holdings" accent="neutral" actionsInlineMobile className={financeStyles.compactPageHeader}
        description={onStageForFinish && !effectiveVaultKey ? "Your portfolio is protected when setup finishes." : undefined}
        actions={<ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" onClick={handleReimportAttempt}>Start over</ShellActionSurface>}
      />
      {hasCountMismatch || hasValueMismatch ? (
        <p role="status" className="ui-text-row-description text-muted-foreground">
          {hasCountMismatch ? `Found ${extractedCount} of ${statementCount} securities listed on the statement. ` : null}
          {hasValueMismatch ? "The total securities value differs from the statement. " : null}
          Check the holdings before saving.
        </p>
      ) : null}
      <PortfolioReviewSummary
        totalValue={totalValue}
        unrealizedGainLoss={totalUnrealizedGainLoss}
        holdingCount={tableHoldingRows.filter((position) => !position.pending_delete).length}
        riskBucket={riskBucket}
        cashBalance={liveCashBalance}
      />
      <Accordion type="multiple" className="w-full min-w-0 space-y-3">

        <AccordionItem
          value="account"
          className="border-b-0 rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-default)] px-5 shadow-[var(--app-card-shadow-standard)]"
        >
          <AccordionTrigger className="ui-text-section-label py-3 hover:no-underline">


            <div className="flex items-center gap-2">
              <Icon icon={Building2} size="sm" aria-hidden="true" />
              Account Information
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <div className="grid gap-3 pt-2">
              <div>
                <Label htmlFor="account-holder" className="ui-text-form-label">Account Holder</Label>
                <Input
                  id="account-holder"
                  value={accountInfo.holder_name || ""}
                  onChange={(e) =>
                    setAccountInfo((prev) => ({
                      ...prev,
                      holder_name: e.target.value,
                    }))
                  }
                  placeholder="Name"
                  className="mt-1 w-full"
                  title={accountInfo.holder_name || ""}
                />
              </div>
              <div>
                <Label htmlFor="account-number" className="ui-text-form-label">Account Number</Label>
                <Input
                  id="account-number"
                  value={accountInfo.account_number || ""}
                  onChange={(e) =>
                    setAccountInfo((prev) => ({
                      ...prev,
                      account_number: e.target.value,
                    }))
                  }
                  placeholder="XXX-XXXX"
                  className="mt-1 w-full"
                  title={accountInfo.account_number || ""}
                />
              </div>
              <div>
                <Label htmlFor="account-brokerage" className="ui-text-form-label">Brokerage</Label>
                <Input
                  id="account-brokerage"
                  value={accountInfo.brokerage || ""}
                  onChange={(e) =>
                    setAccountInfo((prev) => ({
                      ...prev,
                      brokerage: e.target.value,
                    }))
                  }
                  placeholder="Brokerage name"
                  className="mt-1 w-full"
                  title={accountInfo.brokerage || ""}
                />
              </div>
              <div>
                <Label htmlFor="account-type" className="ui-text-form-label">Account Type</Label>
                <Input
                  id="account-type"
                  value={accountInfo.account_type || ""}
                  onChange={(e) =>
                    setAccountInfo((prev) => ({
                      ...prev,
                      account_type: e.target.value,
                    }))
                  }
                  placeholder="Individual, IRA, etc."
                  className="mt-1 w-full"
                  title={accountInfo.account_type || ""}
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Asset Allocation */}
        {hasAllocationValues(displayAssetAllocation) && (
        <AccordionItem
          value="allocation"
          className="border-b-0 rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-default)] px-5 shadow-[var(--app-card-shadow-standard)]"
        >
            <AccordionTrigger className="ui-text-section-label py-3 hover:no-underline">


              <div className="flex items-center gap-2">
                <Icon icon={PieChart} size="sm" aria-hidden="true" />
                Asset Allocation
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3 pt-2">
                {displayAssetAllocation.cash_pct !== undefined && (
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Cash</span>
                    <div className="text-right">
                      <span className="font-medium">
                        {displayAssetAllocation.cash_pct?.toFixed(1)}%
                      </span>
                      <span className="text-muted-foreground text-sm ml-2">
                        {formatCurrency(displayAssetAllocation.cash_value)}
                      </span>
                    </div>
                  </div>
                )}
                {displayAssetAllocation.equities_pct !== undefined && (
                  <div className="flex justify-between items-center">
                    <span className="text-sm">Equities</span>
                    <div className="text-right">
                      <span className="font-medium">
                        {displayAssetAllocation.equities_pct?.toFixed(1)}%
                      </span>
                      <span className="text-muted-foreground text-sm ml-2">
                        {formatCurrency(displayAssetAllocation.equities_value)}
                      </span>
                    </div>
                  </div>
                )}
                {displayAssetAllocation.bonds_pct !== undefined &&
                  displayAssetAllocation.bonds_pct > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm">Bonds</span>
                      <div className="text-right">
                        <span className="font-medium">
                          {displayAssetAllocation.bonds_pct?.toFixed(1)}%
                        </span>
                        <span className="text-muted-foreground text-sm ml-2">
                          {formatCurrency(displayAssetAllocation.bonds_value)}
                        </span>
                      </div>
                    </div>
                  )}
                {displayAssetAllocation.real_assets_pct !== undefined &&
                  displayAssetAllocation.real_assets_pct > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm">Real Assets</span>
                      <div className="text-right">
                        <span className="font-medium">
                          {displayAssetAllocation.real_assets_pct?.toFixed(1)}%
                        </span>
                        <span className="text-muted-foreground text-sm ml-2">
                          {formatCurrency(displayAssetAllocation.real_assets_value)}
                        </span>
                      </div>
                    </div>
                  )}
                {displayAssetAllocation.other_pct !== undefined &&
                  displayAssetAllocation.other_pct > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm">Other</span>
                      <div className="text-right">
                        <span className="font-medium">
                          {displayAssetAllocation.other_pct?.toFixed(1)}%
                        </span>
                        <span className="text-muted-foreground text-sm ml-2">
                          {formatCurrency(displayAssetAllocation.other_value)}
                        </span>
                      </div>
                    </div>
                  )}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {/* Income Summary */}
        {incomeSummary.total_income !== undefined && (
        <AccordionItem
          value="income"
          className="border-b-0 rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-default)] px-5 shadow-[var(--app-card-shadow-standard)]"
        >
            <AccordionTrigger className="ui-text-section-label py-3 hover:no-underline">


              <div className="flex items-center gap-2">
                <Icon icon={Wallet} size="sm" aria-hidden="true" />
                Income Summary
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3 pt-2">
                {incomeSummary.dividends_taxable !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-sm">Dividends</span>
                    <span className="font-medium">
                      {formatCurrency(incomeSummary.dividends_taxable)}
                    </span>
                  </div>
                )}
                {incomeSummary.interest_income !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-sm">Interest</span>
                    <span className="font-medium">
                      {formatCurrency(incomeSummary.interest_income)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between border-t pt-2">
                  <span className="text-sm font-medium">Total Income</span>
                  <span className="font-semibold text-emerald-600">
                    {formatCurrency(incomeSummary.total_income)}
                  </span>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
      <MorphyCard variant="none" preset="surface" className="min-w-0">
        <CardHeader className="flex items-center justify-between gap-2 space-y-0 px-4 pb-2 pt-3">
          <CardTitle className="ui-text-section-label">Holdings</CardTitle>
          <ShellActionSurface variant="pill" className="min-h-11 shrink-0 ui-text-compact-button-label" onClick={handleAddHolding}>
            <Plus className="size-4" aria-hidden="true" /> Add holding
          </ShellActionSurface>
        </CardHeader>
        <CardContent className="min-w-0 px-4 pb-4 pt-0">
          {pendingDeleteCount > 0 ? (
            <p className="ui-text-row-description mb-2 text-muted-foreground">{pendingDeleteCount} pending removal</p>
          ) : null}
          <div className="flex flex-col gap-3">
            <PortfolioReviewHoldingsFilter value={holdingsTab} onChange={setHoldingsTab} />
            <section aria-label="Holdings results">
              <DataTable
                columns={holdingsTableColumns}
                tableClassName={financeStyles.reviewTable}
                data={holdingsTab === "all" ? holdingTables.all : holdingsTab === "analyze"
                  ? holdingTables.analyzeEligible : holdingsTab === "cash" ? holdingTables.cashSweep : holdingTables.nonAnalyzable}
                globalSearchKeys={["symbol", "name"]}
                searchPlaceholder="Search holdings"
                paginate={false}
                density="compact"
                renderMobileCard={(position) => (
                  <article className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-b border-border py-2">
                    {positionLabel(position)}
                    <div className="grid justify-items-end gap-1 text-right">
                      <span className="ui-text-row-label-emphasized tabular-nums">{positionValue(position)}</span>
                      <span className="ui-text-row-description tabular-nums text-muted-foreground">{sharesAtPrice(position)}</span>
                      {!isCashEquivalentHolding(position) && <HoldingGainLoss
                        holding={toHoldingViewModel(position, totalValue)}
                        className="ui-text-row-description tabular-nums"
                      />}
                      {position.entries.length === 1 ? entryActions(position.entries[0]!) : null}
                    </div>
                  </article>
                )}
              />
            </section>
          </div>
        </CardContent>
      </MorphyCard>
      <footer
        data-portfolio-review-save
        className="flex justify-end pt-2"
      >
        <Button
          size="standard"
          className="w-full scroll-mb-[calc(var(--bottom-chrome-stack-height,0px)+1rem)] ui-text-compact-button-label sm:w-auto"
          onClick={() => {
            createdVaultCopyRef.current = hasVault === false;
            void handleSave();
          }}
          disabled={isBusySaving || activeHoldings.length === 0}
        >
          {isBusySaving ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" /> : null}
          {isBusySaving
            ? hasVault === false
              ? "Creating Vault and saving portfolio..."
              : isSaving
                ? "Securing portfolio in Vault..."
                : "Saving portfolio in background..."
            : onStageForFinish && !effectiveVaultKey
              ? "Save portfolio"
            : hasVault === false
            ? "Create Vault"
            : "Save to Vault"}
        </Button>
      </footer>

      <EditHoldingModal
        isOpen={Boolean(editingHolding)}
        onClose={closeHoldingModal}
        holding={editingHolding}
        validationIssue={holdingValidationIssue}
        onSave={handleSaveHolding}
      />

      {/* Vault Dialog (create/unlock) */}
      {user && (
        <VaultUnlockDialog
          user={user}
          open={vaultDialogOpen}
          onOpenChange={(open) => {
            if (isBusySaving) return;
            if (open) {
              vaultUnlockSucceededRef.current = false;
              setVaultDialogOpen(true);
              return;
            }
            setVaultDialogOpen(open);
            if (vaultUnlockSucceededRef.current) {
              vaultUnlockSucceededRef.current = false;
              return;
            }
            setPendingVaultSave(false);
          }}
          title={
            hasVault === false
              ? "Create Vault to save portfolio"
              : "Unlock Vault to save portfolio"
          }
          description="Create or unlock your Vault to save this portfolio securely."
          enableGeneratedDefault={hasVault === false}
          onSuccess={(meta) => {
            createdVaultModeRef.current = meta?.mode ?? null;
            vaultUnlockSucceededRef.current = true;
            setVaultDialogOpen(false);
            setPendingVaultSave(true);
          }}
        />
      )}

      {isSaving && (
        <div className="fixed inset-0 z-[560] flex items-center justify-center bg-background/75 backdrop-blur-md">
          <div className="mx-4 w-full max-w-sm rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-default)] p-5 shadow-[var(--app-card-shadow-feature)]">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <p className="text-sm font-semibold">Securing and saving to Vault</p>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {toInvestorMessage("SAVE_IN_PROGRESS")}
            </p>
          </div>
        </div>
      )}
    </AppPageContentRegion>
  );
}
