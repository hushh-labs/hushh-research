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

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Plus,
  Save,
  RefreshCw,
  Loader2,
  Building2,
  TrendingUp,
  TrendingDown,
  PieChart,
  Wallet,
} from "lucide-react";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/morphy-ux/ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { HoldingRowActions } from "@/components/kai/holdings/holding-row-actions";
import { DataTable } from "@/components/app-ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";


import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  useCache,
  type PortfolioData as CachedPortfolioData,
} from "@/lib/cache/cache-context";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
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
import { scrollAppToTop } from "@/lib/navigation/use-scroll-reset";
import { toInvestorMessage } from "@/lib/copy/investor-language";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { ROUTES } from "@/lib/navigation/routes";
import {
  buildFinancialDomainSummary,
  buildStatementSource,
} from "@/lib/kai/brokerage/financial-sources";




// =============================================================================
// TYPES
// =============================================================================

export interface Holding {
  symbol: string;
  symbol_cusip?: string;
  identifier_type?: "ticker" | "cusip" | "derived";
  position_side?: "long" | "short" | "liability";
  is_short_position?: boolean;
  is_liability_position?: boolean;
  name: string;
  quantity: number;
  price: number;
  market_value: number;
  cost_basis?: number;
  unrealized_gain_loss?: number;
  unrealized_gain_loss_pct?: number;
  asset_type?: string;
  instrument_kind?: string;
  is_cash_equivalent?: boolean;
  is_investable?: boolean;
  analyze_eligible?: boolean;
  debate_eligible?: boolean;
  optimize_eligible?: boolean;
  symbol_source?: string;
  symbol_kind?: string;
  security_listing_status?: string;
  is_sec_common_equity_ticker?: boolean;
  pending_delete?: boolean;
}

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

function formatCurrency(value: number | undefined | null): string {
  if (value === undefined || value === null) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCurrencyCompact(value: number | undefined | null): string {
  if (value === undefined || value === null) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
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

function isCashEquivalentHolding(holding: Holding): boolean {
  const symbol = String(holding.symbol || "").trim().toUpperCase();
  if (["CASH", "MMF", "SWEEP", "QACDS"].includes(symbol)) return true;
  const assetType = String(holding.asset_type || "").trim().toLowerCase();
  const name = String(holding.name || "").trim().toLowerCase();
  return (
    assetType.includes("cash") ||
    assetType.includes("money market") ||
    assetType.includes("sweep") ||
    name.includes("cash") ||
    name.includes("money market") ||
    name.includes("sweep")
  );
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

  return false;
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

function normalizeHoldingForStorage(holding: Holding): Holding {
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

function mergeAccountSummary(primary: AccountSummary, fallback: AccountSummary): AccountSummary {
  return compactRecord({
    beginning_value: primary.beginning_value ?? fallback.beginning_value,
    ending_value: primary.ending_value ?? fallback.ending_value,
    cash_balance: primary.cash_balance ?? fallback.cash_balance,
    equities_value: primary.equities_value ?? fallback.equities_value,
    change_in_value: primary.change_in_value ?? fallback.change_in_value,
    total_change: primary.total_change ?? fallback.total_change,
    net_deposits_withdrawals:
      primary.net_deposits_withdrawals ?? fallback.net_deposits_withdrawals,
    net_deposits_period: primary.net_deposits_period ?? fallback.net_deposits_period,
    net_deposits_ytd: primary.net_deposits_ytd ?? fallback.net_deposits_ytd,
    investment_gain_loss: primary.investment_gain_loss ?? fallback.investment_gain_loss,
    total_income_period: primary.total_income_period ?? fallback.total_income_period,
    total_income_ytd: primary.total_income_ytd ?? fallback.total_income_ytd,
    total_fees: primary.total_fees ?? fallback.total_fees,
  } satisfies AccountSummary) as AccountSummary;
}

function _mergeAssetAllocation(primary: AssetAllocation, fallback: AssetAllocation): AssetAllocation {
  return compactRecord({
    cash_pct: primary.cash_pct ?? fallback.cash_pct,
    cash_value: primary.cash_value ?? fallback.cash_value,
    equities_pct: primary.equities_pct ?? fallback.equities_pct,
    equities_value: primary.equities_value ?? fallback.equities_value,
    bonds_pct: primary.bonds_pct ?? fallback.bonds_pct,
    bonds_value: primary.bonds_value ?? fallback.bonds_value,
    real_assets_pct: primary.real_assets_pct ?? fallback.real_assets_pct,
    real_assets_value: primary.real_assets_value ?? fallback.real_assets_value,
    other_pct: primary.other_pct ?? fallback.other_pct,
    other_value: primary.other_value ?? fallback.other_value,
  } satisfies AssetAllocation) as AssetAllocation;
}

function pickRicherAccountSummary(left: AccountSummary, right: AccountSummary): AccountSummary {
  return Object.keys(right).length > Object.keys(left).length ? right : left;
}

function pickRicherAssetAllocation(left: AssetAllocation, right: AssetAllocation): AssetAllocation {
  return Object.keys(right).length > Object.keys(left).length ? right : left;
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
  const total = holdings.reduce((sum, holding) => {
    if (!isCashLikeHolding(holding)) return sum;
    return sum + (toFiniteNumber(holding.market_value) ?? 0);
  }, 0);
  return total > 0 ? total : undefined;
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

function statementCompletenessScore(statement: Record<string, unknown>): number {
  const summary = sanitizeAccountSummary(statement.account_summary);
  const allocation = sanitizeAssetAllocation(statement.asset_allocation);
  const holdings = Array.isArray(statement.holdings) ? statement.holdings.length : 0;
  const quality = toRecord(statement.quality_report_v2);
  const validated = toFiniteNumber(quality?.validated_count);

  const summaryCount = Object.keys(summary).length;
  const allocationCount = Object.keys(allocation).length;
  return summaryCount * 6 + allocationCount * 4 + Math.min(holdings, 25) + (validated ?? 0) / 10;
}

function pickBestStatementSnapshot(statements: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(statements) || statements.length === 0) return undefined;
  const candidates = statements
    .map((entry) => toRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => statementCompletenessScore(right) - statementCompletenessScore(left));
  return candidates[0];
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
  const handleSaveRef = useRef<() => Promise<void>>(async () => {});
  const saveInFlightRef = useRef(false);
  const isMountedRef = useRef(true);
  const [editingHolding, setEditingHolding] = useState<Holding | null>(null);
  const [editingHoldingIndex, setEditingHoldingIndex] = useState<number>(-1);
  const [holdingsTab, setHoldingsTab] = useState<"all" | "analyze" | "non-analyze" | "cash">(
    "all"
  );

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
    // Prefer statement/account summary cash when present.
    // Holdings-derived cash is only a fallback for sparse parses.
    if (reportedCashBalance !== undefined) return reportedCashBalance;
    const holdingsCash = deriveCashFromHoldings(activeHoldings);
    return holdingsCash ?? 0;
  }, [activeHoldings, reportedCashBalance]);

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
    const derivedTotal = holdingsTotal + (holdingsCash !== undefined ? 0 : liveCashBalance);
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
      setEditingHolding({ ...row, pending_delete: false });
      setEditingHoldingIndex(index);
    },
    [holdings]
  );

  const closeHoldingModal = useCallback(() => {
    setEditingHolding(null);
    setEditingHoldingIndex(-1);
  }, []);

  const handleSaveHolding = useCallback(
    (updatedHolding: Holding) => {
      const quantity = Number(updatedHolding.quantity);
      const price = Number(updatedHolding.price);
      const marketValue = Number(updatedHolding.market_value);
      const isAddingNewHolding = editingHoldingIndex < 0;

      if (
        !Number.isFinite(quantity) ||
        !Number.isFinite(price) ||
        !Number.isFinite(marketValue) ||
        quantity <= 0 ||
        price <= 0 ||
        marketValue <= 0
      ) {
        toast.error("Quantity, price, and market value must all be greater than 0.");
        return;
      }

      const normalizedHolding: Holding = {
        ...updatedHolding,
        quantity,
        price,
        market_value: marketValue,
      };

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
    [closeHoldingModal, editingHoldingIndex]
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

  const tableHoldingRows = useMemo<ReviewHoldingRow[]>(
    () =>
      holdings
        .map((holding, index) => ({
          ...holding,
          client_id: `holding-${index}`,
          source_index: index,
        }))
        .sort(compareHoldingsByNameAsc),
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

  const holdingsTableColumns = useMemo<ColumnDef<ReviewHoldingRow>[]>(
    () => [
      {
        id: "row_actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const holding = row.original;
          const deleted = Boolean(holding.pending_delete);
          return (
            <div className="flex items-start justify-center pt-1">
              <HoldingRowActions
                symbol={holding.symbol}
                isDeleted={deleted}
                disableEdit={deleted}
                layout="row"
                className="w-auto"
                onEdit={() => handleEditHolding(holding.source_index)}
                onToggleDelete={() => handleDeleteHolding(holding.source_index)}
              />
            </div>
          );
        },
      },
      {
        accessorKey: "symbol",
        header: "Holding",
        cell: ({ row }) => {
          const holding = row.original;
          const deleted = Boolean(holding.pending_delete);
          const side = getPositionSide(holding);
          const sideClass =
            side === "short"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : side === "liability"
                ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                : "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
          return (
            <div
              className={cn(
                "min-w-[170px] max-w-[240px] sm:max-w-[280px] lg:max-w-[340px]",
                deleted && "opacity-60"
              )}
            >
              <div className="flex items-center gap-2">
                <p className={cn("font-semibold", deleted && "line-through")}>
                  {holding.symbol || "—"}
                </p>
                <Badge variant="outline" className={cn("h-5 px-1.5 text-[10px] uppercase", sideClass)}>
                  {side}
                </Badge>
              </div>
              <p
                title={holding.name || "Unnamed security"}
                className={cn("truncate text-xs text-muted-foreground", deleted && "line-through")}
              >
                {holding.name || "Unnamed security"}
              </p>
            </div>
          );
        },
      },
      {
        id: "position",
        header: "Shares @ Price",
        cell: ({ row }) => {
          const holding = row.original;
          const side = getPositionSide(holding);
          const quantityValue = Number(holding.quantity || 0);
          const quantityLabel =
            side === "short" || side === "liability"
              ? Math.abs(quantityValue).toLocaleString()
              : quantityValue.toLocaleString();
          return (
            <span
              className={cn(
                "text-xs sm:text-sm leading-tight",
                holding.pending_delete && "line-through text-muted-foreground"
              )}
            >
              {quantityLabel} @{" "}
              {formatCurrency(Number(holding.price || 0))}
            </span>
          );
        },
      },
      {
        accessorKey: "market_value",
        header: "Market Value",
        cell: ({ row }) => {
          const holding = row.original;
          return (
            <span
              className={cn(
                "font-semibold text-xs sm:text-sm leading-tight",
                holding.pending_delete && "line-through text-muted-foreground"
              )}
            >
              {formatCurrency(Number(holding.market_value || 0))}
            </span>
          );
        },
      },
      {
        accessorKey: "unrealized_gain_loss",
        header: "Gain / Loss",
        cell: ({ row }) => {
          const holding = row.original;
          const gain = Number(holding.unrealized_gain_loss || 0);
          const gainText = `${gain >= 0 ? "+" : ""}${formatCurrency(gain)}`;
          return (
            <span
              className={cn(
                "font-medium",
                holding.pending_delete
                  ? "line-through text-muted-foreground"
                  : gain >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
              )}
            >
              {gainText}
            </span>
          );
        },
      },
    ],
    [handleDeleteHolding, handleEditHolding]
  );

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

    const invalidHolding = activeHoldings.find((holding) => {
      const isCashLike = Boolean(holding.is_cash_equivalent) || isCashEquivalentHolding(holding);
      const quantity = Number(holding.quantity);
      const price = Number(holding.price);
      const marketValue = Number(holding.market_value);
      if (!Number.isFinite(marketValue) || Math.abs(marketValue) <= 0) return true;
      if (isCashLike) return false;
      return (
        !Number.isFinite(quantity) ||
        Math.abs(quantity) <= 0 ||
        !Number.isFinite(price) ||
        price <= 0
      );
    });
    if (invalidHolding) {
      toast.error(
        `Holding ${invalidHolding.symbol || invalidHolding.name || "entry"} has invalid values. Quantity must be non-zero, price must be positive, and market value must be non-zero.`
      );
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
      try {
        resolvedHasVault = await VaultService.checkVault(userId);
        setHasVault(resolvedHasVault);
      } catch (error) {
        console.warn(
          "[PortfolioReviewView] Failed to resolve vault existence on save:",
          error
        );
        resolvedHasVault = null;
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
        resolvedVaultOwnerToken = await resolveVaultOwnerTokenForSave(false);
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

      const normalizedActiveHoldings = activeHoldings.map((holding) =>
        normalizeHoldingForStorage(holding)
      );
      const savePayload: PortfolioData = {
        account_info: accountInfo,
        account_summary: accountSummary,
        asset_allocation: assetAllocation,
        holdings: normalizedActiveHoldings,
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
      setIsBackgroundSaveRunning(true);
      toast.success("Portfolio save started in background.");
      setIsSaving(false);
      baselineSnapshotRef.current = serializeEditableState(accountInfo, holdings);
      if (isMountedRef.current) {
        setHasUnsavedChanges(false);
        Promise.resolve(onSaveComplete(savePayload)).catch((saveCompleteError) => {
          console.error("[PortfolioReview] onSaveComplete failed:", saveCompleteError);
        });
      }

      const nowIso = new Date().toISOString();
      const blobLoadStartedAt = nowMs();
      const cachedBlob = PersonalKnowledgeModelService.peekCachedFullBlob(userId);
      let fullBlob: Record<string, unknown>;
      let expectedDataVersion = cachedBlob?.dataVersion;
      if (cachedBlob?.blob) {
        fullBlob = cachedBlob.blob;
      } else {
        const existingFinancial =
          (await PersonalKnowledgeModelService.loadDomainData({
            userId,
            domain: "financial",
            vaultKey: effectiveVaultKey,
            vaultOwnerToken: resolvedVaultOwnerToken,
          }).catch(() => null)) ?? {};
        fullBlob =
          existingFinancial &&
          typeof existingFinancial === "object" &&
          !Array.isArray(existingFinancial)
            ? { financial: existingFinancial }
            : {};
      }
      if (expectedDataVersion === undefined) {
        expectedDataVersion = PersonalKnowledgeModelService.peekCachedEncryptedBlob(userId)?.dataVersion;
      }
      logSavePhase("blob load", blobLoadStartedAt);
      const mergeBuildStartedAt = nowMs();
      const existingFinancialValue = fullBlob.financial;
      const existingFinancial =
        existingFinancialValue &&
        typeof existingFinancialValue === "object" &&
        !Array.isArray(existingFinancialValue)
          ? ({ ...(existingFinancialValue as Record<string, unknown>) } as Record<string, unknown>)
          : {};

      const existingPortfolioCandidate = toRecord(existingFinancial.portfolio) ?? existingFinancial;

      const parsedAccountSummary = sanitizeAccountSummary(accountSummary);
      const parsedAssetAllocation = sanitizeAssetAllocation(assetAllocation);
      const parsedCashBalance =
        toFiniteNumber(initialData.cash_balance) ?? parsedAccountSummary.cash_balance;
      const holdingsTotal = normalizedActiveHoldings.reduce(
        (sum, holding) => sum + (toFiniteNumber(holding.market_value) ?? 0),
        0
      );
      const derivedCashBalance = deriveCashFromHoldings(normalizedActiveHoldings);
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
      const existingStatementsValue = existingDocs.statements;
      const existingStatements = Array.isArray(existingStatementsValue)
        ? [...existingStatementsValue]
        : [];
      const bestStatementSnapshot = pickBestStatementSnapshot(existingStatements);

      const existingPortfolioSummary = sanitizeAccountSummary(
        existingPortfolioCandidate.account_summary
      );
      const existingStatementSummary = sanitizeAccountSummary(
        bestStatementSnapshot?.account_summary
      );
      const fallbackAccountSummary = pickRicherAccountSummary(
        existingPortfolioSummary,
        existingStatementSummary
      );

      const existingPortfolioAllocation = sanitizeAssetAllocation(
        existingPortfolioCandidate.asset_allocation
      );
      const existingStatementAllocation = sanitizeAssetAllocation(
        bestStatementSnapshot?.asset_allocation
      );
      const fallbackAssetAllocation = pickRicherAssetAllocation(
        existingPortfolioAllocation,
        existingStatementAllocation
      );

      const fallbackCashBalance =
        toFiniteNumber(existingPortfolioCandidate.cash_balance) ??
        existingPortfolioSummary.cash_balance ??
        toFiniteNumber(bestStatementSnapshot?.cash_balance) ??
        existingStatementSummary.cash_balance;
      const fallbackTotalValue =
        toFiniteNumber(existingPortfolioCandidate.total_value) ??
        existingPortfolioSummary.ending_value ??
        toFiniteNumber(bestStatementSnapshot?.total_value) ??
        existingStatementSummary.ending_value;

      const statementTotalValue =
        toFiniteNumber(initialData.total_value) ??
        parsedAccountSummary.ending_value ??
        (holdingsTotal > 0
          ? holdingsTotal +
            (holdingsIncludeCash ? 0 : parsedCashBalance ?? derivedCashBalance ?? 0)
          : undefined);
      const resolvedCashBalance = parsedCashBalance ?? derivedCashBalance ?? fallbackCashBalance;
      const resolvedTotalValue =
        statementTotalValue ??
        (holdingsTotal > 0
          ? holdingsTotal + (holdingsIncludeCash ? 0 : resolvedCashBalance ?? 0)
          : undefined) ??
        fallbackTotalValue ??
        0;

      const resolvedAccountSummary = compactRecord({
        ...mergeAccountSummary(parsedAccountSummary, fallbackAccountSummary),
        ending_value: resolvedTotalValue > 0 ? resolvedTotalValue : undefined,
        cash_balance: resolvedCashBalance,
      } satisfies AccountSummary) as AccountSummary;
      const resolvedAssetAllocation = hasAllocationValues(parsedAssetAllocation)
        ? parsedAssetAllocation
        : fallbackAssetAllocation;

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
        account_info: hasRecordValues(normalizedAccountInfo as Record<string, unknown>)
          ? normalizedAccountInfo
          : undefined,
        account_summary: hasSummaryValues(resolvedAccountSummary)
          ? resolvedAccountSummary
          : undefined,
        asset_allocation: hasAllocationValues(resolvedAssetAllocation)
          ? resolvedAssetAllocation
          : undefined,
        holdings: normalizedActiveHoldings,
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

      const snapshotId = `stmt_${Date.now()}`;
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
        holdings: portfolioToSave.holdings || [],
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
          fallback_merge_applied: sparseSections.length > 0,
        },
      };
      existingStatements.unshift(snapshot);

      const nextDocsDomain = {
        schema_version: 1,
        statements: existingStatements.slice(0, 25),
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
      const bestSnapshotSource = toRecord(bestStatementSnapshot?.source);
      const bestSnapshotStatementEnd =
        typeof bestSnapshotSource?.statement_period_end === "string"
          ? bestSnapshotSource.statement_period_end
          : undefined;
      const bestSnapshotBrokerage =
        typeof bestSnapshotSource?.brokerage === "string"
          ? bestSnapshotSource.brokerage
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
          bestSnapshotStatementEnd ||
          existingDocsStatementEnd ||
          null,
        last_brokerage:
          accountInfo.brokerage || bestSnapshotBrokerage || existingDocsBrokerage || null,
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
          contract_version: 1,
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
        attribute_count: normalizedActiveHoldings.length,
        item_count: normalizedActiveHoldings.length,
        holdings_count: normalizedActiveHoldings.length,
        investable_positions_count: normalizedActiveHoldings.filter(
          (holding) => holding.is_investable
        ).length,
        cash_positions_count: normalizedActiveHoldings.filter(
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
        PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
          userId,
          vaultKey: effectiveVaultKey,
          domain: "financial",
          domainData: nextFinancialDomain as unknown as Record<string, unknown>,
          summary: financialSummary,
          baseFullBlob: fullBlob,
          expectedDataVersion,
          cacheFullBlob: Boolean(cachedBlob?.blob),
          vaultOwnerToken: vaultOwnerTokenToUse,
        });

      let financialResult;
      try {
        financialResult = await storeMergedDomain(resolvedVaultOwnerToken);
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
          financialResult = await storeMergedDomain(refreshedToken);
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
        throw new Error("Backend returned failure on store");
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

  return (
    <div className={cn("relative w-full", className)}>


      <div className="mx-auto w-full max-w-6xl space-y-8 px-4 pb-6 transition-all duration-500 ease-in-out md:px-6">



      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="px-1">
	            <h1 className="text-xl font-bold tracking-tight">Review Portfolio</h1>
	            <p className="text-sm text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis max-w-[200px] sm:max-w-none">
	              {hasVault === false
	                ? "Review your portfolio, then create your Vault to save it."
	                : "Review before saving to Vault"}
	            </p>
	          </div>
	        </div>
        <MorphyButton 
          variant="muted" 
          size="default" 
          onClick={handleReimportAttempt}
          className="shrink-0"
          icon={{ 
            icon: RefreshCw
          }}
        >
          <span className="hidden sm:inline ml-2 font-bold">Re-import</span>
          <span className="sm:hidden font-bold">Try again</span>
        </MorphyButton>


      </div>



      <div className="xl:grid xl:grid-cols-12 xl:items-start xl:gap-10">
        {/* Left Column / Mobile Top: Summary & Info */}
        <div className="space-y-8 xl:col-span-5">
          {/* Summary Card - Redesigned for bigger numbers */}
          <MorphyCard variant="none" className="overflow-hidden border-none shadow-xl">
            <div className="absolute inset-0 bg-linear-to-br from-primary/5 to-primary/10 dark:from-primary/10 dark:to-primary/20" />
            <CardContent className="relative pt-8 px-6 pb-8 space-y-8">

              <div className="text-center">
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1">
                  Total Portfolio Value
                </p>
                <p className="max-w-full px-2 text-[clamp(1.7rem,8.5vw,2.55rem)] font-black leading-none tracking-tight tabular-nums whitespace-nowrap bg-linear-to-br from-foreground to-foreground/70 bg-clip-text text-transparent sm:text-4xl">
                  <span title={formatCurrency(totalValue)}>{formatCurrencyCompact(totalValue)}</span>
                </p>

                {totalUnrealizedGainLoss !== 0 && (
                  <div className="flex justify-center mt-3">
                    <Badge
                      className={cn(
                        "font-bold py-1 px-3",
                        totalUnrealizedGainLoss >= 0
                          ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                          : "bg-red-500/10 text-red-500 border-red-500/20"
                      )}
                    >
                      {totalUnrealizedGainLoss >= 0 ? (
                        <Icon icon={TrendingUp} size={12} className="mr-1.5" />
                      ) : (
                        <Icon icon={TrendingDown} size={12} className="mr-1.5" />
                      )}
                      <span title={formatCurrency(totalUnrealizedGainLoss)}>
                        {formatCurrencyCompact(totalUnrealizedGainLoss)} unrealized
                      </span>
                    </Badge>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 sm:gap-4 pt-6 border-t border-primary/10">
                <div className="min-w-0 text-center sm:text-left sm:pl-4">
                  <p className="text-2xl font-black">{activeHoldings.length}</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Assets</p>
                </div>
                <div className="min-w-0 flex flex-col items-center justify-center">
                  <Badge
                    variant="outline"
                    className={cn(
                      "font-black text-[10px] uppercase tracking-widest px-2",
                      riskBucket === "aggressive"
                        ? "app-critical-badge"
                        : riskBucket === "moderate"
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    )}
                  >
                    {riskBucket}
                  </Badge>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mt-2">Portfolio Risk</p>
                </div>
                <div className="min-w-0 text-center sm:text-right sm:pr-4">
                  <p
                    className={cn(
                      "max-w-full text-[clamp(1.05rem,5.8vw,1.55rem)] font-black leading-none tabular-nums whitespace-nowrap sm:text-2xl",
                      liveCashBalance < 0
                        ? "text-red-500 dark:text-red-400"
                        : "text-foreground"
                    )}
                  >
                    <span title={formatCurrency(liveCashBalance)}>
                      {formatCurrencyCompact(liveCashBalance)}
                    </span>
                  </p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Cash</p>
                </div>
              </div>

            </CardContent>
          </MorphyCard>


      {/* Account & Meta Accordions */}
      <Accordion type="multiple" defaultValue={["account", "income"]} className="w-full space-y-4">

        <AccordionItem value="account" className="border-b-0 bg-card rounded-2xl border px-5">
          <AccordionTrigger className="text-base font-bold py-5 hover:no-underline">


            <div className="flex items-center gap-2">
              <Icon icon={Building2} size="sm" />
              Account Information
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div>
                <Label className="text-xs">Account Holder</Label>
                <Input
                  value={accountInfo.holder_name || ""}
                  onChange={(e) =>
                    setAccountInfo((prev) => ({
                      ...prev,
                      holder_name: e.target.value,
                    }))
                  }
                  placeholder="Name"
                  className="mt-1 overflow-x-auto whitespace-nowrap [text-overflow:clip] [touch-action:pan-x]"
                  title={accountInfo.holder_name || ""}
                />
              </div>
              <div>
                <Label className="text-xs">Account Number</Label>
                <Input
                  value={accountInfo.account_number || ""}
                  onChange={(e) =>
                    setAccountInfo((prev) => ({
                      ...prev,
                      account_number: e.target.value,
                    }))
                  }
                  placeholder="XXX-XXXX"
                  className="mt-1 overflow-x-auto whitespace-nowrap [text-overflow:clip] [touch-action:pan-x]"
                  title={accountInfo.account_number || ""}
                />
              </div>
              <div>
                <Label className="text-xs">Brokerage</Label>
                <Input
                  value={accountInfo.brokerage || ""}
                  onChange={(e) =>
                    setAccountInfo((prev) => ({
                      ...prev,
                      brokerage: e.target.value,
                    }))
                  }
                  placeholder="Brokerage name"
                  className="mt-1 overflow-x-auto whitespace-nowrap [text-overflow:clip] [touch-action:pan-x]"
                  title={accountInfo.brokerage || ""}
                />
              </div>
              <div>
                <Label className="text-xs">Account Type</Label>
                <Input
                  value={accountInfo.account_type || ""}
                  onChange={(e) =>
                    setAccountInfo((prev) => ({
                      ...prev,
                      account_type: e.target.value,
                    }))
                  }
                  placeholder="Individual, IRA, etc."
                  className="mt-1 overflow-x-auto whitespace-nowrap [text-overflow:clip] [touch-action:pan-x]"
                  title={accountInfo.account_type || ""}
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Asset Allocation */}
        {hasAllocationValues(displayAssetAllocation) && (
        <AccordionItem value="allocation" className="border-b-0 bg-card rounded-2xl border px-5">
            <AccordionTrigger className="text-base font-bold py-5 hover:no-underline">


              <div className="flex items-center gap-2">
                <Icon icon={PieChart} size="sm" />
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
        <AccordionItem value="income" className="border-b-0 bg-card rounded-2xl border px-5">
            <AccordionTrigger className="text-base font-bold py-5 hover:no-underline">


              <div className="flex items-center gap-2">
                <Icon icon={Wallet} size="sm" />
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
        </div>

        {/* Right Column / Mobile Bottom: Holdings */}
        <div className="mt-8 xl:col-span-7 xl:mt-0">
          <MorphyCard variant="none" className="h-full border-none bg-card shadow-xl">
            <CardHeader className="bg-muted/30 px-6 pb-4 pt-6">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-lg font-black uppercase tracking-widest text-foreground">
                    Holdings ({holdings.length})
                    {pendingDeleteCount > 0 ? (
                      <span className="ml-2 text-[11px] font-semibold text-muted-foreground">
                        {pendingDeleteCount} pending remove
                      </span>
                    ) : null}
                  </CardTitle>
                </div>
                <MorphyButton
                  variant="none"
                  effect="fade"
                  size="sm"
                  onClick={handleAddHolding}
                >
                  <Icon icon={Plus} size="sm" className="mr-1" />
                  Add Holding
                </MorphyButton>
              </div>
            </CardHeader>

            <CardContent className="space-y-4 px-6 pb-6 pt-6">
              <div className="rounded-xl border border-border/60 bg-background/70 px-3 py-2.5 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">Current State</span>
                  <span className="rounded-full bg-background px-2 py-0.5">
                    Assets: {activeHoldings.length}
                  </span>
                  <span className="rounded-full bg-background px-2 py-0.5">
                    Marked remove: {pendingDeleteCount}
                  </span>
                  <span className="rounded-full bg-background px-2 py-0.5">
                    Cash positions: {holdingTables.cashSweep.length}
                  </span>
                </div>
              </div>

              <Tabs
                value={holdingsTab}
                onValueChange={(value) =>
                  setHoldingsTab(value as "all" | "analyze" | "non-analyze" | "cash")
                }
                className="space-y-3"
              >
                <div className="pb-1">
                  <TabsList className="grid h-8 w-full grid-cols-4 gap-0.5 rounded-lg bg-background/80 p-0.5">
                    <TabsTrigger
                      className="h-7 min-w-0 truncate px-1 text-[10px] leading-none sm:text-xs"
                      value="all"
                      title={`All holdings (${holdingTables.all.length})`}
                    >
                      All ({holdingTables.all.length})
                    </TabsTrigger>
                    <TabsTrigger
                      className="h-7 min-w-0 truncate px-1 text-[10px] leading-none sm:text-xs"
                      value="analyze"
                      title={`Equities (${holdingTables.analyzeEligible.length})`}
                    >
                      Equity ({holdingTables.analyzeEligible.length})
                    </TabsTrigger>
                    <TabsTrigger
                      className="h-7 min-w-0 truncate px-1 text-[10px] leading-none sm:text-xs"
                      value="non-analyze"
                      title={`Other assets (${holdingTables.nonAnalyzable.length})`}
                    >
                      Other ({holdingTables.nonAnalyzable.length})
                    </TabsTrigger>
                    <TabsTrigger
                      className="h-7 min-w-0 truncate px-1 text-[10px] leading-none sm:text-xs"
                      value="cash"
                      title={`Cash holdings (${holdingTables.cashSweep.length})`}
                    >
                      Cash ({holdingTables.cashSweep.length})
                    </TabsTrigger>
                  </TabsList>
                </div>

                <TabsContent value="all">
                  <DataTable
                    columns={holdingsTableColumns}
                    data={holdingTables.all}
                    globalSearchKeys={["symbol", "name"]}
                    searchPlaceholder="Search holdings by symbol or name..."
                    initialPageSize={5}
                    pageSizeOptions={[5, 10, 20]}
                    rowClassName={(holding) =>
                      holding.pending_delete ? "bg-muted/45 text-muted-foreground" : "bg-transparent"
                    }
                    tableContainerClassName="w-full"
                    tableClassName="w-full"
                  />
                </TabsContent>

                <TabsContent value="analyze">
                  <DataTable
                    columns={holdingsTableColumns}
                    data={holdingTables.analyzeEligible}
                    globalSearchKeys={["symbol", "name"]}
                    searchPlaceholder="Search equities..."
                    initialPageSize={5}
                    pageSizeOptions={[5, 10, 20]}
                    rowClassName={(holding) =>
                      holding.pending_delete ? "bg-muted/45 text-muted-foreground" : "bg-transparent"
                    }
                    tableContainerClassName="w-full"
                    tableClassName="w-full"
                  />
                </TabsContent>

                <TabsContent value="non-analyze">
                  <DataTable
                    columns={holdingsTableColumns}
                    data={holdingTables.nonAnalyzable}
                    globalSearchKeys={["symbol", "name"]}
                    searchPlaceholder="Search other assets..."
                    initialPageSize={5}
                    pageSizeOptions={[5, 10, 20]}
                    rowClassName={(holding) =>
                      holding.pending_delete ? "bg-muted/45 text-muted-foreground" : "bg-transparent"
                    }
                    tableContainerClassName="w-full"
                    tableClassName="w-full"
                  />
                </TabsContent>

                <TabsContent value="cash">
                  <DataTable
                    columns={holdingsTableColumns}
                    data={holdingTables.cashSweep}
                    globalSearchKeys={["symbol", "name"]}
                    searchPlaceholder="Search cash holdings..."
                    initialPageSize={5}
                    pageSizeOptions={[5, 10, 20]}
                    rowClassName={(holding) =>
                      holding.pending_delete ? "bg-muted/45 text-muted-foreground" : "bg-transparent"
                    }
                    tableContainerClassName="w-full"
                    tableClassName="w-full"
                  />
                </TabsContent>
              </Tabs>

              <div className="pt-2">
                <MorphyButton
                  variant="blue-gradient"
                  effect="fade"
                  fullWidth
                  onClick={() => {
                    createdVaultCopyRef.current = hasVault === false;
                    void handleSave();
                  }}
                  disabled={isBusySaving || activeHoldings.length === 0}
                  className="bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90"
                >
                  {isBusySaving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Icon icon={Save} size="sm" className="mr-2" />
                  )}
                  {isBusySaving
                    ? hasVault === false
                      ? "Creating Vault and saving portfolio..."
                      : isSaving
                        ? "Securing portfolio in Vault..."
                        : "Saving portfolio in background..."
                    : hasVault === false
                    ? "Create Vault"
                    : "Save to Vault"}
                </MorphyButton>
              </div>
            </CardContent>
          </MorphyCard>
        </div>
      </div>
      </div>

      <EditHoldingModal
        isOpen={Boolean(editingHolding)}
        onClose={closeHoldingModal}
        holding={editingHolding}
        onSave={handleSaveHolding}
      />

      {/* Vault Dialog (create/unlock) */}
      {user && (
        <VaultUnlockDialog
          user={user}
          open={vaultDialogOpen}
          onOpenChange={(open) => {
            if (isBusySaving) return;
            setVaultDialogOpen(open);
            if (!open) setPendingVaultSave(false);
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
            setVaultDialogOpen(false);
            if (
              effectiveVaultKey &&
              !continuationInFlightRef.current
            ) {
              continuationInFlightRef.current = true;
              void handleSave().finally(() => {
                continuationInFlightRef.current = false;
              });
              return;
            }
            setPendingVaultSave(true);
          }}
        />
      )}

      {isSaving && (
        <div className="fixed inset-0 z-[560] flex items-center justify-center bg-background/75 backdrop-blur-md">
          <div className="mx-4 w-full max-w-sm rounded-2xl border border-border/70 bg-background/95 p-5 shadow-2xl">
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
	</div>
	  );
}
