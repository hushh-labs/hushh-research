// components/kai/kai-flow.tsx

/**
 * Kai Flow - State-driven UI component flow for investment analysis
 *
 * Flow:
 * 1. Check PKM for financial data
 * 2. If no data -> Show portfolio import
 * 3. After import -> Show streaming progress -> Review screen -> Dashboard
 * 4. Dashboard shows KPIs, prime assets, and search bar for analysis
 * 5. Analysis view shows real-time debate streaming
 *
 * No chat interface - pure UI component flow.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { normalizeStoredPortfolio } from "@/lib/utils/portfolio-normalize";
import { useCache } from "@/lib/cache/cache-context";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { PortfolioImportView } from "./views/portfolio-import-view";
import { ImportProgressView, ImportStage } from "./views/import-progress-view";
import { PortfolioReviewView, PortfolioData as ReviewPortfolioData } from "./views/portfolio-review-view";
import type { PortfolioData } from "./types/portfolio";
import { DashboardMasterView } from "./views/dashboard-master-view";
import { AnalysisView } from "./views/analysis-view";
import { useVault } from "@/lib/vault/vault-context";
import { toast } from "sonner";
import { ApiService } from "@/lib/services/api-service";
import { getStockContext } from "@/lib/services/kai-service";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import type { KaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";
import { consumeCanonicalKaiStream } from "@/lib/streaming/kai-stream-client";
import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { setOnboardingFlowActiveCookie } from "@/lib/services/onboarding-route-cookie";
import { ROUTES } from "@/lib/navigation/routes";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS } from "@/lib/services/kai-import-stream-config";
import { fetchDemoPortfolioTemplateAsset } from "@/lib/services/demo-mode-template-service";
import { hasPortfolioHoldings, type PlaidPortfolioStatusResponse, type PortfolioSource } from "@/lib/kai/brokerage/portfolio-sources";
import { loadPlaidLink } from "@/lib/kai/brokerage/plaid-link-loader";
import {
  clearPlaidOAuthResumeSession,
  savePlaidOAuthResumeSession,
} from "@/lib/kai/brokerage/plaid-oauth-session";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";
import { useAuth } from "@/hooks/use-auth";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { Capacitor } from "@capacitor/core";
import {
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";
import { toInvestorLoading, toInvestorStreamText } from "@/lib/copy/investor-language";
import { ensureKaiVaultOwnerToken } from "@/lib/services/kai-token-guard";

// =============================================================================
// TYPES
// =============================================================================

export type FlowState =
  | "checking"
  | "import_required"
  | "importing"       // Streaming progress view
  | "import_complete" // Stream complete, waits for explicit user action
  | "reviewing"       // Review parsed data before saving
  | "dashboard"       // Main view with KPIs and prime assets
  | "analysis";       // Stock analysis results

interface KaiFlowProps {
  userId: string;
  vaultOwnerToken: string;
  mode: "dashboard" | "import";
  onStateChange?: (state: FlowState) => void;
  onHoldingsLoaded?: (holdings: string[]) => void;
}

interface AnalysisResult {
  symbol: string;
  decision: "BUY" | "HOLD" | "REDUCE";
  confidence: number;
  summary: string;
  fundamentalInsights?: string;
  sentimentInsights?: string;
  valuationInsights?: string;
}

interface AnalysisLaunchOptions {
  portfolioSource?: PortfolioSource;
  portfolioContext?: Record<string, unknown> | null;
}

interface FlowData {
  hasFinancialData: boolean;
  holdingsCount?: number;
  holdings?: string[];
  portfolioData?: PortfolioData;
  analysisResult?: AnalysisResult;
  parsedPortfolio?: ReviewPortfolioData; // Parsed but not yet saved
}

interface QualityReport {
  schema_version?: number;
  raw_count?: number;
  validated_count?: number;
  aggregated_count?: number;
  holdings_count?: number;
  investable_positions_count?: number;
  cash_positions_count?: number;
  allocation_coverage_pct?: number;
  symbol_trust_coverage_pct?: number;
  parser_quality_score?: number;
  diagnostics?: Record<string, unknown>;
  dropped_reasons?: Record<string, number>;
  quality_gate?: Record<string, unknown>;
}

interface LiveHoldingPreview {
  symbol?: string;
  name?: string;
  market_value?: number | null;
  quantity?: number | null;
  asset_type?: string;
  position_side?: "long" | "short" | "liability";
  is_short_position?: boolean;
  is_liability_position?: boolean;
}

// Streaming state
interface StreamingState {
  stage: ImportStage;
  stageTrail: string[];
  rawStreamLines: string[];
  streamedText: string;
  totalChars: number;
  chunkCount: number;
  progressPct?: number;
  statusMessage?: string;
  thoughts: string[];  // Array of thought summaries from Gemini thinking mode
  thoughtCount: number;
  qualityReport?: QualityReport;
  liveHoldings: LiveHoldingPreview[];
  holdingsExtracted: number;
  holdingsTotal?: number;
  errorMessage?: string;
}

type ImportBackgroundStatus = "running" | "completed" | "failed" | "canceled";

interface PersistedImportBackgroundSnapshot {
  version: 1;
  userId: string;
  taskId: string | null;
  runId: string | null;
  latestCursor: number;
  status: ImportBackgroundStatus;
  startedAt: string;
  updatedAt: string;
  errorMessage: string | null;
  streaming: StreamingState;
  parsedPortfolio?: ReviewPortfolioData;
}

const KAI_IMPORT_BACKGROUND_KEY = "kai_portfolio_import_background_v1";
const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_IMPORT_FILE_SIZE_MESSAGE = "File too large. Maximum size is 25MB.";

function createInitialStreamingState(): StreamingState {
  return {
    stage: "idle",
    stageTrail: [],
    rawStreamLines: [],
    streamedText: "",
    totalChars: 0,
    chunkCount: 0,
    progressPct: undefined,
    statusMessage: "Ready to import",
    thoughts: [],
    thoughtCount: 0,
    qualityReport: undefined,
    liveHoldings: [],
    holdingsExtracted: 0,
    holdingsTotal: undefined,
    errorMessage: undefined,
  };
}

function loadImportBackgroundSnapshot(userId: string): PersistedImportBackgroundSnapshot | null {
  const raw = getSessionItem(KAI_IMPORT_BACKGROUND_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedImportBackgroundSnapshot>;
    if (parsed.version !== 1) return null;
    if (!parsed.userId || parsed.userId !== userId) return null;
    if (!parsed.streaming || typeof parsed.streaming !== "object") return null;
    return {
      version: 1,
      userId,
      taskId:
        typeof parsed.taskId === "string" && parsed.taskId.trim().length > 0
          ? parsed.taskId.trim()
          : null,
      runId:
        typeof parsed.runId === "string" && parsed.runId.trim().length > 0
          ? parsed.runId.trim()
          : null,
      latestCursor:
        typeof parsed.latestCursor === "number" && Number.isFinite(parsed.latestCursor)
          ? Math.max(0, Math.floor(parsed.latestCursor))
          : 0,
      status:
        parsed.status === "completed" ||
        parsed.status === "failed" ||
        parsed.status === "canceled"
          ? parsed.status
          : "running",
      startedAt:
        typeof parsed.startedAt === "string" && parsed.startedAt.trim().length > 0
          ? parsed.startedAt
          : new Date().toISOString(),
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt.trim().length > 0
          ? parsed.updatedAt
          : new Date().toISOString(),
      errorMessage:
        typeof parsed.errorMessage === "string" && parsed.errorMessage.trim().length > 0
          ? parsed.errorMessage
          : null,
      streaming: {
        ...createInitialStreamingState(),
        ...(parsed.streaming as StreamingState),
      },
      parsedPortfolio:
        parsed.parsedPortfolio && typeof parsed.parsedPortfolio === "object"
          ? (parsed.parsedPortfolio as ReviewPortfolioData)
          : undefined,
    };
  } catch {
    return null;
  }
}

function saveImportBackgroundSnapshot(snapshot: PersistedImportBackgroundSnapshot): void {
  setSessionItem(KAI_IMPORT_BACKGROUND_KEY, JSON.stringify(snapshot));
}

function clearImportBackgroundSnapshot(userId: string): void {
  void userId;
  removeSessionItem(KAI_IMPORT_BACKGROUND_KEY);
}

// =============================================================================
// NORMALIZATION HELPERS
// =============================================================================

/**
 * Normalize V2 backend portfolio data to match frontend ReviewPortfolioData interface.
 */
function parseMaybeNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  const text = String(value).trim();
  if (!text || ["n/a", "na", "null", "none", "--", "-"].includes(text.toLowerCase())) {
    return undefined;
  }

  const negative = text.startsWith("(") && text.endsWith(")");
  const sanitized = text
    .replace(/[,$\s]/g, "")
    .replace(/%/g, "")
    .replace(/[()]/g, "");
  const maybe = Number(negative ? `-${sanitized}` : sanitized);
  return Number.isFinite(maybe) ? maybe : undefined;
}

function parseNumberOrZero(value: unknown): number {
  return parseMaybeNumber(value) ?? 0;
}

function compactRecord<T extends Record<string, unknown>>(value: T | undefined): T | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).filter(([, entryValue]) => {
    if (entryValue === undefined || entryValue === null) return false;
    if (typeof entryValue === "string" && entryValue.trim().length === 0) return false;
    return true;
  });
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as T;
}

const TRADE_ACTION_SYMBOLS = new Set([
  "BUY",
  "SELL",
  "REINVEST",
  "DIVIDEND",
  "INTEREST",
  "TRANSFER",
  "WITHDRAWAL",
  "DEPOSIT",
]);

const CASH_EQUIVALENT_SYMBOLS = new Set(["CASH", "MMF", "SWEEP", "QACDS"]);
const MAX_RAW_STREAM_LINES = 350;
const STREAM_STALL_WARNING_MS = 45_000;
const STREAM_STALL_ABORT_MS = 150_000;
const STREAM_STALL_CHECK_INTERVAL_MS = 5_000;
const GENERIC_IMPORT_STREAM_LINE = "Reviewing your statement...";

function normalizeTickerSymbol(
  value: unknown,
  opts?: { name?: string; assetType?: string }
): string {
  if (value === null || value === undefined) return "";
  const normalized = String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "");
  if (!normalized || normalized.startsWith("HOLDING_")) return "";
  if (TRADE_ACTION_SYMBOLS.has(normalized)) return "";
  if (CASH_EQUIVALENT_SYMBOLS.has(normalized)) return "CASH";
  const nameLc = String(opts?.name || "").trim().toLowerCase();
  const assetTypeLc = String(opts?.assetType || "").trim().toLowerCase();
  if (
    nameLc.includes("cash") ||
    nameLc.includes("sweep") ||
    assetTypeLc.includes("cash") ||
    assetTypeLc.includes("sweep") ||
    assetTypeLc.includes("money market")
  ) {
    return "CASH";
  }
  return normalized;
}

function normalizeRawStreamLine(input: string): string {
  const stripped = String(input || "")
    .replace(/```(?:json)?/gi, " ")
    .replace(/```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  if (/^[\]\[\{\},:]+$/.test(stripped)) return "";
  const looksStructuredPayload =
    /^\s*[\[{]/.test(stripped) ||
    /"[^"]+"\s*:/.test(stripped) ||
    /(?:portfolio_data_v2|raw_extract_v2|analytics_v2|quality_report_v2|holdings_preview|progress_pct|chunk_count|total_chars|run_id|cursor|seq)\b/i.test(
      stripped
    );
  const tagged = stripped.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (tagged) {
    const cleaned = (tagged[2] || "").trim();
    const message = looksStructuredPayload
      ? GENERIC_IMPORT_STREAM_LINE
      : toInvestorStreamText(cleaned);
    return message;
  }
  if (looksStructuredPayload) {
    return GENERIC_IMPORT_STREAM_LINE;
  }
  return toInvestorStreamText(stripped);
}

function rawStreamLineKey(line: string): string {
  const normalized = normalizeRawStreamLine(line);
  if (normalized.toLowerCase() === GENERIC_IMPORT_STREAM_LINE.toLowerCase()) {
    return normalized.toLowerCase();
  }
  const match = normalized.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!match) return normalized.toLowerCase();
  const tag = (match[1] || "").trim().toUpperCase();
  const message = (match[2] || "").trim().toLowerCase();
  return `[${tag}] ${message}`;
}

function appendRawStreamLines(
  current: string[],
  incoming: string[] | undefined,
): string[] {
  if (!incoming || incoming.length === 0) return current;
  let next = current;
  for (const raw of incoming) {
    const line = normalizeRawStreamLine(raw);
    if (!line) continue;
    const lineKey = rawStreamLineKey(line);
    if (
      lineKey === GENERIC_IMPORT_STREAM_LINE.toLowerCase() &&
      next.some((entry) => rawStreamLineKey(entry) === lineKey)
    ) {
      continue;
    }
    if (next.length > 0) {
      const prevLine = next[next.length - 1];
      if (prevLine && rawStreamLineKey(prevLine) === lineKey) {
        continue;
      }
    }
    next = [...next, line];
    if (next.length > MAX_RAW_STREAM_LINES) {
      next = next.slice(next.length - MAX_RAW_STREAM_LINES);
    }
  }
  return next;
}

function sanitizeInvestorCopy(value: unknown, fallback = ""): string {
  const next = toInvestorStreamText(value);
  if (next) return next;
  return fallback;
}

function dedupeLiveHoldingPreviewRows(rows: LiveHoldingPreview[]): LiveHoldingPreview[] {
  if (rows.length <= 1) return rows;
  const seen = new Set<string>();
  const unique: LiveHoldingPreview[] = [];
  for (const row of rows) {
    const symbol = normalizeTickerSymbol(row.symbol, {
      name: row.name,
      assetType: row.asset_type,
    });
    const name = String(row.name || "").trim().toLowerCase();
    const qty =
      typeof row.quantity === "number" && Number.isFinite(row.quantity)
        ? row.quantity.toFixed(6)
        : "";
    const value =
      typeof row.market_value === "number" && Number.isFinite(row.market_value)
        ? row.market_value.toFixed(2)
        : "";
    const assetType = String(row.asset_type || "").trim().toLowerCase();
    const positionSide = String(row.position_side || "").trim().toLowerCase();
    const key = [symbol, name, qty, value, assetType, positionSide].join("|");
    if (!key.replace(/\|/g, "").trim()) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      ...row,
      symbol: symbol || row.symbol,
    });
  }
  return unique;
}

function mergeLiveHoldingPreviewRows(
  current: LiveHoldingPreview[],
  incoming: LiveHoldingPreview[]
): LiveHoldingPreview[] {
  if (!incoming.length) return current;
  const merged = dedupeLiveHoldingPreviewRows([...current, ...incoming]);
  const bySymbol = new Map<string, LiveHoldingPreview>();
  for (const row of merged) {
    const symbol = normalizeTickerSymbol(row.symbol, {
      name: row.name,
      assetType: row.asset_type,
    });
    if (!symbol) continue;
    const existing = bySymbol.get(symbol);
    if (!existing) {
      bySymbol.set(symbol, {
        symbol,
        name: row.name,
        market_value: row.market_value ?? null,
        quantity: row.quantity ?? null,
        asset_type: row.asset_type,
        position_side: row.position_side,
        is_short_position: row.is_short_position,
        is_liability_position: row.is_liability_position,
      });
      continue;
    }
    const existingQty =
      typeof existing.quantity === "number" && Number.isFinite(existing.quantity)
        ? existing.quantity
        : 0;
    const incomingQty =
      typeof row.quantity === "number" && Number.isFinite(row.quantity)
        ? row.quantity
        : 0;
    const existingValue =
      typeof existing.market_value === "number" && Number.isFinite(existing.market_value)
        ? existing.market_value
        : 0;
    const incomingValue =
      typeof row.market_value === "number" && Number.isFinite(row.market_value)
        ? row.market_value
        : 0;
    bySymbol.set(symbol, {
      symbol,
      name: existing.name || row.name,
      quantity: existingQty + incomingQty,
      market_value: existingValue + incomingValue,
      asset_type: existing.asset_type || row.asset_type,
      position_side:
        existing.position_side === "liability" || row.position_side === "liability"
          ? "liability"
          : existing.position_side === "short" || row.position_side === "short"
            ? "short"
            : "long",
      is_short_position:
        Boolean(existing.is_short_position) || Boolean(row.is_short_position),
      is_liability_position:
        Boolean(existing.is_liability_position) || Boolean(row.is_liability_position),
    });
  }
  return Array.from(bySymbol.values());
}

function readHoldingsPreview(value: unknown): LiveHoldingPreview[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const preview: LiveHoldingPreview[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const symbol = normalizeTickerSymbol(item.symbol, {
      name: typeof item.name === "string" ? item.name : undefined,
      assetType: typeof item.asset_type === "string" ? item.asset_type : undefined,
    });
    const name =
      typeof item.name === "string" && item.name.trim().length > 0
        ? item.name.trim()
        : undefined;
    const marketValue = parseMaybeNumber(item.market_value);
    const quantity = parseMaybeNumber(item.quantity);
    const assetType =
      typeof item.asset_type === "string" && item.asset_type.trim().length > 0
        ? item.asset_type.trim()
        : undefined;
    const positionSideRaw =
      typeof item.position_side === "string" ? item.position_side.trim().toLowerCase() : "";
    const positionSide =
      positionSideRaw === "long" || positionSideRaw === "short" || positionSideRaw === "liability"
        ? (positionSideRaw as "long" | "short" | "liability")
        : undefined;
    if (!symbol) continue;
    if (marketValue === undefined && quantity === undefined && !name && !assetType) continue;
    preview.push({
      symbol,
      name,
      market_value: marketValue,
      quantity,
      asset_type: assetType,
      position_side: positionSide,
      is_short_position: item.is_short_position === true,
      is_liability_position: item.is_liability_position === true,
    });
  }
  return dedupeLiveHoldingPreviewRows(preview);
}

function normalizePortfolioData(backendData: Record<string, unknown>): ReviewPortfolioData {
  const normalized = normalizeStoredPortfolio(backendData as Record<string, unknown>) as ReviewPortfolioData;
  const rawHoldings = Array.isArray(normalized.holdings) ? normalized.holdings : [];
  const canonicalHoldings = rawHoldings
    .map((h) => ({
      ...h,
      symbol: normalizeTickerSymbol(h.symbol, {
        name: h.name,
        assetType: h.asset_type,
      }),
      quantity: parseNumberOrZero(h.quantity),
      price: parseNumberOrZero(h.price),
      market_value: parseNumberOrZero(h.market_value),
      cost_basis: parseMaybeNumber(h.cost_basis),
      unrealized_gain_loss: parseMaybeNumber(h.unrealized_gain_loss),
      unrealized_gain_loss_pct: parseMaybeNumber(h.unrealized_gain_loss_pct),
    }))
    .filter((h) => Boolean((h.symbol || "").trim()));

  const accountSummary = normalized.account_summary || {};
  const totalValue =
    parseMaybeNumber(normalized.total_value) ??
    parseMaybeNumber(accountSummary.ending_value) ??
    canonicalHoldings.reduce((sum, h) => sum + (h.market_value || 0), 0);
  const cashBalance =
    parseMaybeNumber(normalized.cash_balance) ??
    parseMaybeNumber(accountSummary.cash_balance);

  const result: ReviewPortfolioData = {
    ...normalized,
    account_info:
      normalized.account_info && typeof normalized.account_info === "object"
        ? ({
            ...(normalized.account_info as Record<string, unknown>),
            holder_name:
              (normalized.account_info as Record<string, unknown>).holder_name ??
              (normalized.account_info as Record<string, unknown>).account_holder,
            brokerage:
              (normalized.account_info as Record<string, unknown>).brokerage ??
              (normalized.account_info as Record<string, unknown>).brokerage_name,
          } as ReviewPortfolioData["account_info"])
        : normalized.account_info,
    holdings: canonicalHoldings,
    quality_report_v2: compactRecord(
      normalized.quality_report_v2 && typeof normalized.quality_report_v2 === "object"
        ? ({
            ...(normalized.quality_report_v2 as Record<string, unknown>),
          } as Record<string, unknown>)
        : undefined
    ),
    cash_balance: cashBalance,
    total_value: totalValue,
    parse_fallback: normalized.parse_fallback === true,
  };

  console.log("[KaiFlow] Final normalized data:", {
    holdingsCount: result.holdings?.length || 0,
    hasAccountInfo: !!result.account_info,
    hasAccountSummary: !!result.account_summary,
    totalValue: result.total_value,
    cashBalance: result.cash_balance,
  });

  return result;
}

function hasValidFinancialDomainData(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const portfolio = record.portfolio;
  if (portfolio && typeof portfolio === "object" && !Array.isArray(portfolio)) {
    const portfolioRecord = portfolio as Record<string, unknown>;
    return Array.isArray(portfolioRecord.holdings);
  }
  return false;
}

/**
 * Normalize holdings array to ensure unrealized_gain_loss_pct is computed.
 * This helper can be used in multiple places (checkFinancialData, handleSaveComplete).
 */
function normalizeHoldingsWithPct<T extends { 
  unrealized_gain_loss_pct?: number; 
  unrealized_gain_loss?: number; 
  cost_basis?: number; 
  market_value?: number;
}>(holdings: T[] | undefined): T[] | undefined {
  if (!holdings) return holdings;
  
  return holdings.map((h) => {
    // If percentage is already present and valid, keep it
    if (h.unrealized_gain_loss_pct !== undefined && h.unrealized_gain_loss_pct !== 0) {
      return h;
    }

    // Derive percentage from unrealized_gain_loss if available
    const unrealized = h.unrealized_gain_loss;
    if (unrealized !== undefined) {
      let basis: number | undefined;
      const costBasis = h.cost_basis;
      const marketValue = h.market_value || 0;

      if (costBasis !== undefined && Math.abs(costBasis) > 1e-6) {
        basis = costBasis;
      } else if (marketValue !== 0) {
        basis = marketValue - unrealized;
      }

      if (basis !== undefined && Math.abs(basis) > 1e-6) {
        return {
          ...h,
          unrealized_gain_loss_pct: (unrealized / basis) * 100,
        };
      }
    }

    return h;
  });
}

function isReviewPortfolioData(value: unknown): value is ReviewPortfolioData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.holdings);
}

async function fetchDemoModePortfolioTemplate(
  _vaultOwnerToken?: string
): Promise<ReviewPortfolioData> {
  const payload = await fetchDemoPortfolioTemplateAsset();
  if (!isReviewPortfolioData(payload)) {
    throw new Error("Demo template is invalid.");
  }

  const normalized = normalizePortfolioData(payload as Record<string, unknown>);
  if (!Array.isArray(normalized.holdings) || normalized.holdings.length === 0) {
    throw new Error("Demo template has no holdings.");
  }

  return normalized;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function KaiFlow({
  userId,
  vaultOwnerToken,
  mode,
  onStateChange,
  onHoldingsLoaded,
}: KaiFlowProps) {
  const router = useRouter();
  const { user } = useAuth();
  const {
    vaultKey,
    vaultOwnerToken: contextVaultOwnerToken,
    tokenExpiresAt,
    unlockVault,
  } = useVault();
  const initialVaultOwnerToken = vaultOwnerToken.trim().length > 0 ? vaultOwnerToken : null;
  const effectiveVaultOwnerToken =
    contextVaultOwnerToken || initialVaultOwnerToken || undefined;
  const { getPortfolioData, setPortfolioData, invalidateDomain } = useCache();
  const [state, setState] = useState<FlowState>("checking");
  const [flowData, setFlowData] = useState<FlowData>({
    hasFinancialData: false,
  });
  const [error, setError] = useState<string | null>(null);
  const isDashboardMode = mode === "dashboard";
  const stateRef = useRef<FlowState>("checking");
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [resumeImportAfterVault, setResumeImportAfterVault] = useState(false);
  const [pendingSchemaPreload, setPendingSchemaPreload] = useState(false);
  const [resumePreloadAfterVault, setResumePreloadAfterVault] = useState(false);
  const [isPreloadingSchema, setIsPreloadingSchema] = useState(false);
  const [isConnectingPlaid, setIsConnectingPlaid] = useState(false);
  const [plaidStatus, setPlaidStatus] = useState<PlaidPortfolioStatusResponse | null>(null);
  
  // Streaming state for real-time progress
  const [streaming, setStreaming] = useState<StreamingState>(createInitialStreamingState);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastImportFileRef = useRef<File | null>(null);
  const importResumeAppliedRef = useRef(false);
  const importSnapshotUpdatedAtRef = useRef<string | null>(null);
  const activeImportTaskIdRef = useRef<string | null>(null);
  const activeImportRunIdRef = useRef<string | null>(null);
  const activeImportCursorRef = useRef<number>(0);
  const resumeImportStreamInFlightRef = useRef(false);
  const importStartInFlightRef = useRef(false);
  const userRequestedImportCancelRef = useRef(false);
  const setBusyOperation = useKaiSession((s) => s.setBusyOperation);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useScrollReset(`${mode}:${state}`, { enabled: true, behavior: "auto" });

  const plaidPortfolioData =
    plaidStatus?.aggregate?.portfolio_data && hasPortfolioHoldings(plaidStatus.aggregate.portfolio_data)
      ? plaidStatus.aggregate.portfolio_data
      : null;
  const plaidConfigured = plaidStatus?.configured ?? true;

  useEffect(() => {
    if (mode !== "import") return;
    const snapshot = loadImportBackgroundSnapshot(userId);
    if (!snapshot) {
      importResumeAppliedRef.current = false;
      importSnapshotUpdatedAtRef.current = null;
      activeImportTaskIdRef.current = null;
      activeImportRunIdRef.current = null;
      activeImportCursorRef.current = 0;
      return;
    }

    importResumeAppliedRef.current =
      snapshot.status === "running" || snapshot.status === "completed";
    importSnapshotUpdatedAtRef.current = snapshot.updatedAt;
    activeImportTaskIdRef.current = snapshot.taskId;
    activeImportRunIdRef.current = snapshot.runId;
    activeImportCursorRef.current = snapshot.latestCursor;
    setStreaming(snapshot.streaming);

    if (snapshot.status === "running") {
      setError(null);
      setState("importing");
      return;
    }

    if (snapshot.status === "completed" && snapshot.parsedPortfolio) {
      setFlowData((prev) => ({
        ...prev,
        parsedPortfolio: snapshot.parsedPortfolio,
      }));
      setError(null);
      setState("import_complete");
      return;
    }

    if (snapshot.status === "failed" && snapshot.errorMessage) {
      setError(snapshot.errorMessage);
      setState("import_required");
    }
  }, [mode, userId]);

  useEffect(() => {
    if (mode !== "import") return;
    const interval = window.setInterval(() => {
      const snapshot = loadImportBackgroundSnapshot(userId);
      if (!snapshot) return;
      if (snapshot.updatedAt === importSnapshotUpdatedAtRef.current) return;

      importSnapshotUpdatedAtRef.current = snapshot.updatedAt;
      activeImportTaskIdRef.current = snapshot.taskId;
      activeImportRunIdRef.current = snapshot.runId;
      activeImportCursorRef.current = snapshot.latestCursor;
      setStreaming(snapshot.streaming);

      if (snapshot.status === "completed" && snapshot.parsedPortfolio) {
        setFlowData((prev) => ({
          ...prev,
          parsedPortfolio: snapshot.parsedPortfolio,
        }));
        setError(null);
        setState("import_complete");
        return;
      }

      if (snapshot.status === "failed") {
        setError(snapshot.errorMessage || "Import failed. Please try again.");
        setState("import_required");
        return;
      }

      if (snapshot.status === "running") {
        setState("importing");
      }
    }, 700);

    return () => window.clearInterval(interval);
  }, [mode, userId]);

  useEffect(() => {
    if (mode !== "import") return;
    if (!effectiveVaultOwnerToken) return;
    if (resumeImportStreamInFlightRef.current) return;

    const initialSnapshot = loadImportBackgroundSnapshot(userId);
    if (!initialSnapshot) return;
    if (initialSnapshot.status !== "running") return;

    resumeImportStreamInFlightRef.current = true;
    setBusyOperation("portfolio_import_stream", true);
    abortControllerRef.current = new AbortController();

    const validStages = new Set<ImportStage>([
      "idle",
      "uploading",
      "indexing",
      "scanning",
      "thinking",
      "extracting",
      "normalizing",
      "validating",
      "complete",
      "error",
    ]);
    const readNumber = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const readString = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim().length > 0 ? value : undefined;
    let snapshot = initialSnapshot;
    let streamShadow: StreamingState = snapshot.streaming;
    const persistSnapshot = (
      status: ImportBackgroundStatus,
      options?: { errorMessage?: string | null; parsedPortfolio?: ReviewPortfolioData }
    ) => {
      saveImportBackgroundSnapshot({
        version: 1,
        userId,
        taskId: activeImportTaskIdRef.current,
        runId: activeImportRunIdRef.current,
        latestCursor: activeImportCursorRef.current,
        status,
        startedAt: snapshot.startedAt,
        updatedAt: new Date().toISOString(),
        errorMessage: options?.errorMessage ?? null,
        streaming: streamShadow,
        parsedPortfolio: options?.parsedPortfolio,
      });
    };
    const applyStreaming = (mutate: (prev: StreamingState) => StreamingState) => {
      streamShadow = mutate(streamShadow);
      setStreaming(streamShadow);
      persistSnapshot("running");
      if (activeImportTaskIdRef.current) {
        AppBackgroundTaskService.updateTask(activeImportTaskIdRef.current, {
          description: streamShadow.statusMessage || `Import ${streamShadow.stage}`,
          routeHref: ROUTES.KAI_IMPORT,
        });
      }
    };

    void (async () => {
      try {
        if (!snapshot.runId) {
          const activeRunResponse = await ApiService.getActivePortfolioImportRun({
            userId,
            vaultOwnerToken: effectiveVaultOwnerToken,
          });
          if (activeRunResponse.ok) {
            const activePayload = (await activeRunResponse.json()) as {
              run?: { run_id?: unknown; latest_cursor?: unknown };
            };
            const activeRunId =
              typeof activePayload?.run?.run_id === "string"
                ? activePayload.run.run_id.trim()
                : "";
            const activeCursor =
              typeof activePayload?.run?.latest_cursor === "number" &&
              Number.isFinite(activePayload.run.latest_cursor)
                ? Math.max(0, Math.floor(activePayload.run.latest_cursor))
                : snapshot.latestCursor;
            if (activeRunId) {
              snapshot = {
                ...snapshot,
                runId: activeRunId,
                latestCursor: activeCursor,
              };
              activeImportRunIdRef.current = activeRunId;
              activeImportCursorRef.current = activeCursor;
              persistSnapshot("running");
            }
          }
        }

        if (!snapshot.runId) {
          resumeImportStreamInFlightRef.current = false;
          setBusyOperation("portfolio_import_stream", false);
          return;
        }

        const response = await ApiService.streamPortfolioImportRun({
          runId: snapshot.runId,
          userId,
          vaultOwnerToken: effectiveVaultOwnerToken,
          cursor: snapshot.latestCursor,
          signal: abortControllerRef.current?.signal,
        });
        if (!response.ok) {
          if (response.status === 404 || response.status === 410) {
            clearImportBackgroundSnapshot(userId);
            importResumeAppliedRef.current = false;
            importSnapshotUpdatedAtRef.current = null;
            activeImportTaskIdRef.current = null;
            activeImportRunIdRef.current = null;
            activeImportCursorRef.current = 0;
            setStreaming(createInitialStreamingState());
            setState("import_required");
            return;
          }
          throw new Error(`Failed to resume import stream: HTTP ${response.status}`);
        }

        await consumeCanonicalKaiStream(
          response,
          (envelope: KaiStreamEnvelope) => {
            const payload = envelope.payload as Record<string, unknown>;
            const runIdFromPayload =
              typeof payload.run_id === "string" && payload.run_id.trim().length > 0
                ? payload.run_id.trim()
                : null;
            if (runIdFromPayload) {
              activeImportRunIdRef.current = runIdFromPayload;
            }
            if (typeof envelope.seq === "number" && Number.isFinite(envelope.seq)) {
              activeImportCursorRef.current = Math.max(
                activeImportCursorRef.current,
                Math.floor(envelope.seq)
              );
            }

            switch (envelope.event) {
              case "stage": {
                const stageValue = typeof payload.stage === "string" ? payload.stage : undefined;
                const normalizedStageValue =
                  stageValue === "analyzing"
                    ? "scanning"
                    : stageValue === "parsing"
                      ? "normalizing"
                      : stageValue;
                const stage =
                  normalizedStageValue && validStages.has(normalizedStageValue as ImportStage)
                    ? (normalizedStageValue as ImportStage)
                    : undefined;
                const statusMessage = sanitizeInvestorCopy(readString(payload.message), "");
                applyStreaming((prev) => ({
                  ...prev,
                  stage: stage ?? prev.stage,
                  statusMessage: statusMessage || prev.statusMessage,
                  progressPct: readNumber(payload.progress_pct) ?? prev.progressPct,
                }));
                break;
              }
              case "progress": {
                const statusMessage = sanitizeInvestorCopy(readString(payload.message), "");
                applyStreaming((prev) => ({
                  ...prev,
                  statusMessage: statusMessage || prev.statusMessage,
                  progressPct: readNumber(payload.progress_pct) ?? prev.progressPct,
                  holdingsExtracted:
                    readNumber(payload.holdings_extracted) ?? prev.holdingsExtracted,
                  holdingsTotal: readNumber(payload.holdings_total) ?? prev.holdingsTotal,
                }));
                break;
              }
              case "chunk": {
                const text = typeof payload.text === "string" ? payload.text : "";
                const preview = readHoldingsPreview(payload.holdings_preview) ?? [];
                applyStreaming((prev) => ({
                  ...prev,
                  stage: "extracting",
                  rawStreamLines: appendRawStreamLines(
                    prev.rawStreamLines,
                    text ? [text] : undefined
                  ),
                  totalChars: readNumber(payload.total_chars) ?? prev.totalChars,
                  chunkCount: readNumber(payload.chunk_count) ?? prev.chunkCount,
                  liveHoldings: mergeLiveHoldingPreviewRows(prev.liveHoldings, preview),
                  progressPct: readNumber(payload.progress_pct) ?? prev.progressPct,
                }));
                break;
              }
              case "thinking": {
                const statusMessage = sanitizeInvestorCopy(readString(payload.message), "");
                applyStreaming((prev) => ({
                  ...prev,
                  stage: "extracting",
                  thoughtCount: prev.thoughtCount,
                  thoughts: prev.thoughts,
                  statusMessage: statusMessage || prev.statusMessage,
                  progressPct: readNumber(payload.progress_pct) ?? prev.progressPct,
                }));
                break;
              }
              case "warning": {
                const message = sanitizeInvestorCopy(readString(payload.message), "");
                if (!message) break;
                applyStreaming((prev) => ({
                  ...prev,
                  statusMessage: message,
                  stageTrail: [...prev.stageTrail, `[WARNING] ${message}`].slice(-120),
                  rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [`[WARNING] ${message}`]),
                }));
                break;
              }
              case "complete": {
                const rawPortfolioData = payload.portfolio_data_v2 as
                  | Record<string, unknown>
                  | undefined;
                if (
                  !rawPortfolioData ||
                  typeof rawPortfolioData !== "object" ||
                  Array.isArray(rawPortfolioData)
                ) {
                  break;
                }
                const parsedPortfolio = normalizePortfolioData({
                  ...(rawPortfolioData as Record<string, unknown>),
                  raw_extract_v2:
                    payload.raw_extract_v2 &&
                    typeof payload.raw_extract_v2 === "object" &&
                    !Array.isArray(payload.raw_extract_v2)
                      ? (payload.raw_extract_v2 as Record<string, unknown>)
                      : undefined,
                  analytics_v2:
                    payload.analytics_v2 &&
                    typeof payload.analytics_v2 === "object" &&
                    !Array.isArray(payload.analytics_v2)
                      ? (payload.analytics_v2 as Record<string, unknown>)
                      : undefined,
                  quality_report_v2:
                    payload.quality_report_v2 &&
                    typeof payload.quality_report_v2 === "object" &&
                    !Array.isArray(payload.quality_report_v2)
                      ? (payload.quality_report_v2 as Record<string, unknown>)
                      : undefined,
                });
                setFlowData((prev) => ({
                  ...prev,
                  parsedPortfolio,
                }));
                applyStreaming((prev) => ({
                  ...prev,
                  stage: "complete",
                  statusMessage: "Portfolio is ready for review.",
                  progressPct: 100,
                }));
                persistSnapshot("completed", {
                  parsedPortfolio,
                });
                if (activeImportTaskIdRef.current) {
                  AppBackgroundTaskService.completeTask(
                    activeImportTaskIdRef.current,
                    "Import complete. Review and save when ready."
                  );
                }
                setError(null);
                setState("import_complete");
                break;
              }
              case "aborted":
              case "error": {
                const message =
                  envelope.event === "aborted"
                    ? "Import was interrupted before completion. Please retry."
                    : sanitizeInvestorCopy(
                        readString(payload.message),
                        "Import could not be completed."
                      );
                applyStreaming((prev) => ({
                  ...prev,
                  stage: "error",
                  errorMessage: message,
                  statusMessage: message,
                  rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [`[ERROR] ${message}`]),
                }));
                persistSnapshot("failed", {
                  errorMessage: message,
                });
                if (activeImportTaskIdRef.current) {
                  AppBackgroundTaskService.failTask(
                    activeImportTaskIdRef.current,
                    message,
                    "Portfolio import failed. Please retry."
                  );
                }
                setError(message);
                setState("importing");
                break;
              }
              default:
                break;
            }
          },
          {
            signal: abortControllerRef.current?.signal,
            idleTimeoutMs: KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS,
            requireTerminal: true,
          }
        );
      } catch (resumeError) {
        if (resumeError instanceof Error && resumeError.name === "AbortError") {
          return;
        }
        console.warn("[KaiFlow] Failed to resume import stream:", resumeError);
      } finally {
        abortControllerRef.current = null;
        resumeImportStreamInFlightRef.current = false;
        setBusyOperation("portfolio_import_stream", false);
      }
    })();
  }, [effectiveVaultOwnerToken, mode, setBusyOperation, userId]);

  const runDeferredPostSaveSync = useCallback(() => {
    if (!effectiveVaultOwnerToken || !vaultKey) return;
    void KaiProfileSyncService.getPendingSyncState(userId)
      .then((pendingState) => {
        if (!pendingState.hasPending) return;

        const taskId = AppBackgroundTaskService.startTask({
          userId,
          kind: "portfolio_postsave_sync",
          title: "Profile sync",
          description: "Finishing onboarding/profile updates in the background.",
          routeHref: ROUTES.KAI_DASHBOARD,
        });

        return KaiProfileSyncService.syncPendingToVault({
          userId,
          vaultKey,
          vaultOwnerToken: effectiveVaultOwnerToken,
          pendingState,
        })
          .then((result) => {
            if (!result?.synced) {
              if (
                result?.reason === "no_pending_state" ||
                result?.reason === "already_synced" ||
                result?.reason === "portfolio_save_inflight"
              ) {
                AppBackgroundTaskService.dismissTask(taskId);
                return;
              }
              AppBackgroundTaskService.completeTask(
                taskId,
                "No additional profile sync needed."
              );
              return;
            }
            AppBackgroundTaskService.completeTask(
              taskId,
              "Portfolio sync completed."
            );
          })
          .catch((syncError) => {
            console.warn("[KaiFlow] Deferred onboarding sync failed after save:", syncError);
            AppBackgroundTaskService.failTask(
              taskId,
              syncError instanceof Error ? syncError.message : "Sync failed",
              "Portfolio sync failed. You can continue using dashboard."
            );
          });
      })
      .catch((pendingError) => {
        console.warn("[KaiFlow] Failed to preflight profile sync state:", pendingError);
      });
  }, [effectiveVaultOwnerToken, userId, vaultKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isDashboardMode) return;

    const handlePortfolioSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string }>).detail;
      if (!detail || detail.userId !== userId) return;

      const cachedPortfolioData = getPortfolioData(userId) ?? undefined;
      const hasCachedPortfolioData = Boolean(
        cachedPortfolioData &&
          Array.isArray(cachedPortfolioData.holdings) &&
          cachedPortfolioData.holdings.length > 0
      );
      if (!hasCachedPortfolioData || !cachedPortfolioData) return;

      const normalizedCachedHoldings = normalizeHoldingsWithPct(
        cachedPortfolioData.holdings
      );
      const normalizedCachedPortfolio: PortfolioData = {
        ...cachedPortfolioData,
        holdings: normalizedCachedHoldings,
      };
      setPortfolioData(userId, normalizedCachedPortfolio);
      setFlowData({
        hasFinancialData: true,
        holdingsCount: normalizedCachedPortfolio.holdings?.length || 0,
        portfolioData: normalizedCachedPortfolio,
        holdings: normalizedCachedPortfolio.holdings?.map((h) => h.symbol) || [],
      });
      setState("dashboard");
      runDeferredPostSaveSync();
    };

    const handlePortfolioSaveFailed = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; error?: string }>).detail;
      if (!detail || detail.userId !== userId) return;
      toast.error("Background portfolio save failed.", {
        description: detail.error || "Reopen import and try saving again.",
      });
    };

    window.addEventListener("kai:portfolio-saved", handlePortfolioSaved);
    window.addEventListener("kai:portfolio-save-failed", handlePortfolioSaveFailed);
    return () => {
      window.removeEventListener("kai:portfolio-saved", handlePortfolioSaved);
      window.removeEventListener("kai:portfolio-save-failed", handlePortfolioSaveFailed);
    };
  }, [getPortfolioData, isDashboardMode, runDeferredPostSaveSync, setPortfolioData, userId]);

  const loadPlaidStatusSnapshot = useCallback(async (): Promise<PlaidPortfolioStatusResponse | null> => {
    if (!effectiveVaultOwnerToken) {
      setPlaidStatus(null);
      return null;
    }
    try {
      const status = await PlaidPortfolioService.getStatus({
        userId,
        vaultOwnerToken: effectiveVaultOwnerToken,
      });
      setPlaidStatus(status);
      return status;
    } catch (plaidError) {
      console.warn("[KaiFlow] Failed to load Plaid status:", plaidError);
      setPlaidStatus(null);
      return null;
    }
  }, [effectiveVaultOwnerToken, userId]);

  // Check PKM for financial data on mount
  useEffect(() => {
    async function checkFinancialData() {
      try {
        // Import route should only perform this check during initial bootstrap.
        // Re-running on vault token/key transitions can reset active import progress.
        if (mode === "import" && importResumeAppliedRef.current) {
          return;
        }
        if (mode === "import" && stateRef.current !== "checking") {
          return;
        }

        // Avoid resetting active import/review UI when vault state changes mid-flow.
        if (
          vaultDialogOpen ||
          stateRef.current === "importing" ||
          stateRef.current === "import_complete" ||
          stateRef.current === "reviewing"
        ) {
          return;
        }

        setState("checking");

        const cachedPortfolioData = getPortfolioData(userId) ?? undefined;
        const hasCachedPortfolioData = Boolean(
          cachedPortfolioData &&
            Array.isArray(cachedPortfolioData.holdings) &&
            cachedPortfolioData.holdings.length > 0
        );

        // Dashboard-first UX: use trusted in-memory cache immediately and avoid
        // blocking on metadata/blob reads when holdings already exist locally.
        if (isDashboardMode && hasCachedPortfolioData && cachedPortfolioData) {
          const normalizedCachedHoldings = normalizeHoldingsWithPct(
            cachedPortfolioData.holdings
          );
          const normalizedCachedPortfolio: PortfolioData = {
            ...cachedPortfolioData,
            holdings: normalizedCachedHoldings,
          };
          setPortfolioData(userId, normalizedCachedPortfolio);
          setFlowData({
            hasFinancialData: true,
            holdingsCount: normalizedCachedPortfolio.holdings?.length || 0,
            portfolioData: normalizedCachedPortfolio,
            holdings: normalizedCachedPortfolio.holdings?.map((h) => h.symbol) || [],
          });
          setOnboardingFlowActiveCookie(false);
          void loadPlaidStatusSnapshot();
          setState("dashboard");
          return;
        }

        let plaidSnapshot: PlaidPortfolioStatusResponse | null = null;
        const getPlaidPortfolio = async (): Promise<PortfolioData | null> => {
          if (!effectiveVaultOwnerToken) return null;
          if (!plaidSnapshot) {
            plaidSnapshot = await loadPlaidStatusSnapshot();
          }
          const portfolio = plaidSnapshot?.aggregate?.portfolio_data || null;
          return hasPortfolioHoldings(portfolio) ? portfolio : null;
        };

        // Fetch user PKM metadata
        const metadata = await PersonalKnowledgeModelService.getMetadata(userId, false, effectiveVaultOwnerToken);

        // Check if financial domain exists and has data
        const financialDomain = metadata.domains.find(
          (d) => d.key === "financial"
        );

        const hasFinancialData =
          financialDomain && financialDomain.attributeCount > 0;
        if (hasFinancialData) {
          // Prefer CacheProvider (in-memory) for reuse with Manage page
          let portfolioData: PortfolioData | undefined = hasCachedPortfolioData
            ? cachedPortfolioData
            : undefined;

          if (!portfolioData && vaultKey) {
            // No cache - try targeted financial PKM decryption.
            console.log("[KaiFlow] No cache, attempting to decrypt the financial PKM domain...");
            try {
              const rawFinancial = await PersonalKnowledgeModelService.loadDomainData({
                userId,
                domain: "financial",
                vaultKey,
                vaultOwnerToken: effectiveVaultOwnerToken,
              });
              if (!hasValidFinancialDomainData(rawFinancial)) {
                console.warn(
                  "[KaiFlow] Financial domain metadata exists but encrypted blob has no valid financial holdings shape."
                );
                portfolioData = undefined;
              }

              // Normalize Review-format → Dashboard-format field names
              if (hasValidFinancialDomainData(rawFinancial)) {
                portfolioData = normalizeStoredPortfolio(rawFinancial) as PortfolioData;
                console.log("[KaiFlow] Successfully decrypted portfolio data from PKM");
              }
            } catch (decryptError) {
              // Handle encryption key mismatch or corrupted data
              console.error("[KaiFlow] Failed to decrypt the financial PKM domain:", decryptError);
              
              // Check if this is a decryption error (key mismatch)
              const errorMessage = decryptError instanceof Error ? decryptError.message : "";
              if (errorMessage.includes("decrypt") || errorMessage.includes("tag") || errorMessage.includes("authentication")) {
                console.warn("[KaiFlow] Possible encryption key mismatch - clearing cache and prompting re-import");
                invalidateDomain(userId, "financial");
                portfolioData = undefined;
              }
              
              // For other errors, continue without portfolio data - user can re-import
            }
          }
          if (!portfolioData && !vaultKey) {
            // Financial metadata exists, but we cannot decrypt without a vault key.
          }

          // Ensure holdings have unrealized_gain_loss_pct computed
          // This handles data loaded from cache/PKM that may not have been normalized
          if (portfolioData?.holdings) {
            portfolioData.holdings = normalizeHoldingsWithPct(portfolioData.holdings);
            console.log("[KaiFlow] Normalized holdings with unrealized_gain_loss_pct");
          }

          // Update cache with normalized data
          if (portfolioData) {
            setPortfolioData(userId, portfolioData);
          }

          const holdingsCount =
            (Array.isArray(portfolioData?.holdings) && portfolioData?.holdings.length) || 0;

          if (holdingsCount === 0) {
            const plaidPortfolio = await getPlaidPortfolio();
            if (plaidPortfolio) {
              setFlowData({
                hasFinancialData: true,
                holdingsCount: plaidPortfolio.holdings?.length || 0,
                portfolioData,
                holdings: plaidPortfolio.holdings?.map((holding) => holding.symbol) || [],
              });
              if (isDashboardMode) {
                setOnboardingFlowActiveCookie(false);
                setState("dashboard");
              } else {
                setState("import_required");
              }
              return;
            }
            setFlowData({
              hasFinancialData: false,
              holdingsCount: 0,
              portfolioData: undefined,
              holdings: [],
            });
            if (isDashboardMode) {
              setOnboardingFlowActiveCookie(false);
              setState("dashboard");
            } else {
              setState("import_required");
            }
            return;
          }

          // User has financial data - show dashboard
          setFlowData({
            hasFinancialData: true,
            holdingsCount,
            portfolioData,
            holdings: portfolioData?.holdings?.map(h => h.symbol) || [],
          });
          if (isDashboardMode) {
            // Heal stale onboarding-flow cookies after a successful import/resume.
            setOnboardingFlowActiveCookie(false);
          }
          setState(isDashboardMode ? "dashboard" : "import_required");
        } else {
          // Metadata can temporarily report an empty financial domain during startup/race conditions.
          // If we already have a portfolio cached for this user, trust it instead of bouncing to import.
          if (hasCachedPortfolioData && cachedPortfolioData) {
            const normalizedCachedHoldings = normalizeHoldingsWithPct(
              cachedPortfolioData.holdings
            );
            const normalizedCachedPortfolio: PortfolioData = {
              ...cachedPortfolioData,
              holdings: normalizedCachedHoldings,
            };
            setPortfolioData(userId, normalizedCachedPortfolio);
            setFlowData({
              hasFinancialData: true,
              holdingsCount: normalizedCachedPortfolio.holdings?.length || 0,
              portfolioData: normalizedCachedPortfolio,
              holdings: normalizedCachedPortfolio.holdings?.map((h) => h.symbol) || [],
            });
            if (isDashboardMode) {
              setOnboardingFlowActiveCookie(false);
            }
            void loadPlaidStatusSnapshot();
            setState(isDashboardMode ? "dashboard" : "import_required");
            return;
          }

          // Secondary fallback: metadata can lag while full blob already contains holdings.
          if (vaultKey && effectiveVaultOwnerToken) {
            try {
              const rawFinancial = await PersonalKnowledgeModelService.loadDomainData({
                userId,
                domain: "financial",
                vaultKey,
                vaultOwnerToken: effectiveVaultOwnerToken,
              });
              if (hasValidFinancialDomainData(rawFinancial)) {
                let recoveredPortfolioData = normalizeStoredPortfolio(rawFinancial) as PortfolioData;
                if (recoveredPortfolioData.holdings) {
                  recoveredPortfolioData = {
                    ...recoveredPortfolioData,
                    holdings: normalizeHoldingsWithPct(recoveredPortfolioData.holdings),
                  };
                }
                setPortfolioData(userId, recoveredPortfolioData);
                setFlowData({
                  hasFinancialData: true,
                  holdingsCount: recoveredPortfolioData.holdings?.length || 0,
                  portfolioData: recoveredPortfolioData,
                  holdings: recoveredPortfolioData.holdings?.map((h) => h.symbol) || [],
                });
                if (isDashboardMode) {
                  setOnboardingFlowActiveCookie(false);
                }
                void loadPlaidStatusSnapshot();
                setState(isDashboardMode ? "dashboard" : "import_required");
                return;
              }
            } catch (fallbackError) {
              console.warn(
                "[KaiFlow] Metadata reported no financial domain and full-blob fallback failed:",
                fallbackError
              );
            }
          }

          const plaidPortfolio = await getPlaidPortfolio();
          if (plaidPortfolio) {
            setFlowData({
              hasFinancialData: true,
              holdingsCount: plaidPortfolio.holdings?.length || 0,
              portfolioData: undefined,
              holdings: plaidPortfolio.holdings?.map((holding) => holding.symbol) || [],
            });
            if (isDashboardMode) {
              setOnboardingFlowActiveCookie(false);
              setState("dashboard");
              return;
            }
            setState("import_required");
            return;
          }

          // No financial data.
          // Ensure stale frontend cache never leaks into first-time user experience.
          invalidateDomain(userId, "financial");
          setFlowData({ hasFinancialData: false });
          if (isDashboardMode) {
            // Stay on dashboard route and show import CTA instead of hard-redirecting.
            // This avoids navigation thrash during transient metadata issues.
            setState("dashboard");
            return;
          }
          setState("import_required");
        }
      } catch (err) {
        console.warn("[KaiFlow] Error checking financial data:", err);
        const plaidPortfolio = await loadPlaidStatusSnapshot()
          .then((status) => {
            const portfolio = status?.aggregate?.portfolio_data || null;
            return hasPortfolioHoldings(portfolio) ? portfolio : null;
          })
          .catch(() => null);
        if (plaidPortfolio) {
          setFlowData({
            hasFinancialData: true,
            holdingsCount: plaidPortfolio.holdings?.length || 0,
            portfolioData: undefined,
            holdings: plaidPortfolio.holdings?.map((holding) => holding.symbol) || [],
          });
          setState("dashboard");
          return;
        }
        // Keep dashboard stable on transient failures instead of forcing import redirect.
        if (isDashboardMode) {
          setState("dashboard");
          return;
        }
        setFlowData({ hasFinancialData: false });
        setState("import_required");
      }
    }

    checkFinancialData();
  }, [
    mode,
    userId,
    vaultKey,
    effectiveVaultOwnerToken,
    getPortfolioData,
    setPortfolioData,
    invalidateDomain,
    isDashboardMode,
    vaultDialogOpen,
    loadPlaidStatusSnapshot,
  ]);

  // Notify parent of state changes
  useEffect(() => {
    if (onStateChange) {
      onStateChange(state);
    }
  }, [state, onStateChange]);

  // Notify parent of holdings loaded
  useEffect(() => {
    if (onHoldingsLoaded && flowData.holdings) {
      onHoldingsLoaded(flowData.holdings);
    }
  }, [flowData.holdings, onHoldingsLoaded]);

  // Handle file upload with SSE streaming
  const handleFileUpload = useCallback(
    async (file: File) => {
      // Validate file size (max 25MB)
      if (file.size > MAX_IMPORT_FILE_BYTES) {
        setError(MAX_IMPORT_FILE_SIZE_MESSAGE);
        toast.error(MAX_IMPORT_FILE_SIZE_MESSAGE);
        return;
      }

      // Validate file type
      const validTypes = ["application/pdf", "text/csv", "application/vnd.ms-excel"];
      if (!validTypes.includes(file.type) && !file.name.endsWith(".csv") && !file.name.endsWith(".pdf")) {
        setError("Invalid file type. Please upload a PDF or CSV file.");
        toast.error("Invalid file type. Please upload a PDF or CSV file.");
        return;
      }

      if (!vaultKey || !effectiveVaultOwnerToken) {
        setPendingImportFile(file);
        setResumeImportAfterVault(false);
        setVaultDialogOpen(true);
        setError(null);
        toast.info("Create or unlock your Vault to import portfolio.");
        return;
      }

      const forceRefreshVaultOwnerToken = async (
        currentToken: string | null
      ): Promise<string> => {
        const token = await ensureKaiVaultOwnerToken({
          userId,
          currentToken,
          currentExpiresAt: tokenExpiresAt,
          forceRefresh: true,
          onIssued: (issuedToken, expiresAt) => {
            if (vaultKey) {
              unlockVault(vaultKey, issuedToken, expiresAt);
            }
          },
        });
        return token;
      };

      let tokenForImport = effectiveVaultOwnerToken;
      try {
        tokenForImport = await forceRefreshVaultOwnerToken(tokenForImport);
      } catch (tokenError) {
        console.warn("[KaiFlow] Failed to refresh VAULT_OWNER token before import:", tokenError);
        const message = "Your session needs refresh. Please sign in again.";
        setError(message);
        toast.error(message);
        return;
      }
      lastImportFileRef.current = file;
      // Hard reset visual import state before any snapshot/resume branching so
      // previous-run completion bars never bleed into a new upload attempt.
      setError(null);
      setStreaming(createInitialStreamingState());
      setState("importing");
      let lastStreamEventAt = Date.now();
      let streamStallWarningShown = false;
      let streamStallAbortTriggered = false;
      let stallMonitorId: number | null = null;
      let importTaskId: string | null = null;
      const startedAt = new Date().toISOString();
      let streamShadow: StreamingState = createInitialStreamingState();
      const persistBackgroundSnapshot = (
        status: ImportBackgroundStatus,
        options?: {
          errorMessage?: string | null;
          parsedPortfolio?: ReviewPortfolioData;
        }
      ) => {
        const snapshot: PersistedImportBackgroundSnapshot = {
          version: 1,
          userId,
          taskId: importTaskId,
          runId: activeImportRunIdRef.current,
          latestCursor: activeImportCursorRef.current,
          status,
          startedAt,
          updatedAt: new Date().toISOString(),
          errorMessage: options?.errorMessage ?? null,
          streaming: streamShadow,
          parsedPortfolio: options?.parsedPortfolio,
        };
        saveImportBackgroundSnapshot(snapshot);
        importSnapshotUpdatedAtRef.current = snapshot.updatedAt;
      };
      const applyStreaming = (
        mutate: (prev: StreamingState) => StreamingState
      ): void => {
        streamShadow = mutate(streamShadow);
        setStreaming(streamShadow);
        persistBackgroundSnapshot("running");
        if (importTaskId) {
          AppBackgroundTaskService.updateTask(importTaskId, {
            description:
              streamShadow.statusMessage ||
              `Import ${streamShadow.stage}`,
            routeHref: ROUTES.KAI_IMPORT,
          });
        }
      };

      const runningImportExists = AppBackgroundTaskService.hasRunningTask(
        userId,
        "portfolio_import_stream"
      );
      if (runningImportExists) {
        const snapshot = loadImportBackgroundSnapshot(userId);
        if (!snapshot) {
          const staleTasks = AppBackgroundTaskService.getState().tasks.filter(
            (task) =>
              task.userId === userId &&
              task.kind === "portfolio_import_stream" &&
              task.status === "running" &&
              !task.dismissedAt
          );
          for (const task of staleTasks) {
            AppBackgroundTaskService.dismissTask(task.taskId);
          }
        }
        if (snapshot && snapshot.status === "running") {
          importResumeAppliedRef.current = true;
          importSnapshotUpdatedAtRef.current = snapshot.updatedAt;
          activeImportTaskIdRef.current = snapshot.taskId;
          activeImportRunIdRef.current = snapshot.runId;
          activeImportCursorRef.current = snapshot.latestCursor;
          setStreaming(snapshot.streaming);
          setError(null);
          setState("importing");
          toast.message("Portfolio import is already running.", {
            description: "You can continue now or review it later from background tasks.",
          });
          return;
        }
        if (snapshot && snapshot.status === "completed") {
          if (snapshot.taskId) {
            AppBackgroundTaskService.dismissTask(snapshot.taskId);
          }
          clearImportBackgroundSnapshot(userId);
          importResumeAppliedRef.current = false;
          importSnapshotUpdatedAtRef.current = null;
          activeImportTaskIdRef.current = null;
          activeImportRunIdRef.current = null;
          activeImportCursorRef.current = 0;
          setStreaming(createInitialStreamingState());
          setFlowData((prev) => ({
            ...prev,
            parsedPortfolio: undefined,
          }));
          toast.message("Starting a new portfolio import.", {
            description: "Previous import snapshot was cleared.",
          });
        }
        if (snapshot && snapshot.status !== "completed") {
          if (snapshot.taskId) {
            AppBackgroundTaskService.dismissTask(snapshot.taskId);
          }
          clearImportBackgroundSnapshot(userId);
          importResumeAppliedRef.current = false;
          importSnapshotUpdatedAtRef.current = null;
          activeImportTaskIdRef.current = null;
          activeImportRunIdRef.current = null;
          activeImportCursorRef.current = 0;
          toast.message("Recovered a stale import lock.", {
            description: "Starting a fresh import now.",
          });
        }
      } else {
        const snapshot = loadImportBackgroundSnapshot(userId);
        if (snapshot?.status === "running") {
          importResumeAppliedRef.current = true;
          importSnapshotUpdatedAtRef.current = snapshot.updatedAt;
          activeImportTaskIdRef.current = snapshot.taskId;
          activeImportRunIdRef.current = snapshot.runId;
          activeImportCursorRef.current = snapshot.latestCursor;
          setStreaming(snapshot.streaming);
          setError(null);
          setState("importing");
          toast.message("Portfolio import is already running.", {
            description: "You can continue now or review it later from background tasks.",
          });
          return;
        }
        if (snapshot?.status === "completed") {
          if (snapshot.taskId) {
            AppBackgroundTaskService.dismissTask(snapshot.taskId);
          }
          clearImportBackgroundSnapshot(userId);
          importResumeAppliedRef.current = false;
          importSnapshotUpdatedAtRef.current = null;
          activeImportTaskIdRef.current = null;
          activeImportRunIdRef.current = null;
          activeImportCursorRef.current = 0;
          setStreaming(createInitialStreamingState());
          setFlowData((prev) => ({
            ...prev,
            parsedPortfolio: undefined,
          }));
          toast.message("Starting a new portfolio import.", {
            description: "Previous import snapshot was cleared.",
          });
        }
        if (snapshot?.status === "failed") {
          clearImportBackgroundSnapshot(userId);
          importResumeAppliedRef.current = false;
          importSnapshotUpdatedAtRef.current = null;
          activeImportTaskIdRef.current = null;
          activeImportRunIdRef.current = null;
          activeImportCursorRef.current = 0;
          setStreaming(createInitialStreamingState());
        }
      }
      if (
        runningImportExists &&
        AppBackgroundTaskService.hasRunningTask(userId, "portfolio_import_stream")
      ) {
        toast.message("Another portfolio import is already running.", {
          description: "Please wait for it to finish before starting a new one.",
        });
        return;
      }

      if (importStartInFlightRef.current) {
        toast.message("Portfolio import is already starting.", {
          description: "Please wait a moment before starting another import.",
        });
        return;
      }
      importStartInFlightRef.current = true;
      userRequestedImportCancelRef.current = false;

      try {
        // Fresh import intent: proactively cancel any lingering active backend run.
        try {
          const activeRunResponse = await ApiService.getActivePortfolioImportRun({
            userId,
            vaultOwnerToken: tokenForImport,
          });
          if (activeRunResponse.ok) {
            const activePayload = (await activeRunResponse.json().catch(() => null)) as
              | { run?: { run_id?: unknown; status?: unknown } }
              | null;
            const activeRunId =
              typeof activePayload?.run?.run_id === "string"
                ? activePayload.run.run_id.trim()
                : "";
            const activeRunStatus =
              typeof activePayload?.run?.status === "string"
                ? activePayload.run.status.trim().toLowerCase()
                : "";
            if (activeRunId && activeRunStatus === "running") {
              await ApiService.cancelPortfolioImportRun({
                runId: activeRunId,
                userId,
                vaultOwnerToken: tokenForImport,
              });
            }
          }
        } catch (activeRunError) {
          console.warn("[KaiFlow] Active run pre-cancel check failed:", activeRunError);
        }

        setState("importing");
        setError(null);
        setBusyOperation("portfolio_import_stream", true);
        activeImportRunIdRef.current = null;
        activeImportCursorRef.current = 0;

        importTaskId = AppBackgroundTaskService.startTask({
          userId,
          kind: "portfolio_import_stream",
          title: "Portfolio import",
          description: "Parsing your statement in the background.",
          routeHref: ROUTES.KAI_IMPORT,
        });
        activeImportTaskIdRef.current = importTaskId;
        importResumeAppliedRef.current = true;

        streamShadow = {
          stage: "uploading",
          stageTrail: ["[UPLOADING] Processing uploaded file..."],
          rawStreamLines: ["[UPLOADING] Processing uploaded file..."],
          streamedText: "",
          totalChars: 0,
          chunkCount: 0,
          progressPct: undefined,
          statusMessage: "Processing uploaded file...",
          thoughts: [],
          thoughtCount: 0,
          qualityReport: undefined,
          liveHoldings: [],
          holdingsExtracted: 0,
          holdingsTotal: undefined,
          errorMessage: undefined,
        };
        setStreaming(streamShadow);
        persistBackgroundSnapshot("running");

        // Create abort controller for cancellation
        abortControllerRef.current = new AbortController();

        // Build form data
        const formData = new FormData();
        formData.append("file", file);
        formData.append("user_id", userId);

        const runImportRequest = async (importToken: string): Promise<Response> => {
          if (Capacitor.isNativePlatform()) {
            return ApiService.importPortfolioStream({
              formData,
              vaultOwnerToken: importToken,
              signal: abortControllerRef.current?.signal,
            });
          }

          const startResponse = await ApiService.startPortfolioImportRun({
            formData,
            vaultOwnerToken: importToken,
            signal: abortControllerRef.current?.signal,
          });
          if (startResponse.status === 409) {
            const conflict = (await startResponse.json().catch(() => null)) as
              | {
                  detail?: {
                    active_run?: { run_id?: unknown; latest_cursor?: unknown };
                  };
                }
              | null;
            const runIdFromConflict =
              typeof conflict?.detail?.active_run?.run_id === "string"
                ? conflict.detail.active_run.run_id.trim()
                : "";
            if (!runIdFromConflict) {
              throw new Error(
                "Another import is running, but its run id could not be resolved."
              );
            }
            // Explicit upload action should always start a fresh run, not attach.
            await ApiService.cancelPortfolioImportRun({
              runId: runIdFromConflict,
              userId,
              vaultOwnerToken: importToken,
            });
            await new Promise((resolve) => window.setTimeout(resolve, 150));
            const retryStart = await ApiService.startPortfolioImportRun({
              formData,
              vaultOwnerToken: importToken,
              signal: abortControllerRef.current?.signal,
            });
            if (!retryStart.ok) {
              return retryStart;
            }
            const retryPayload = (await retryStart.json()) as {
              run?: { run_id?: unknown };
            };
            const retryRunId =
              typeof retryPayload?.run?.run_id === "string"
                ? retryPayload.run.run_id.trim()
                : "";
            if (!retryRunId) {
              throw new Error("Import run started but no run id was returned.");
            }
            activeImportRunIdRef.current = retryRunId;
            activeImportCursorRef.current = 0;
            persistBackgroundSnapshot("running");
            return ApiService.streamPortfolioImportRun({
              runId: retryRunId,
              userId,
              vaultOwnerToken: importToken,
              cursor: 0,
              signal: abortControllerRef.current?.signal,
            });
          }
          if (!startResponse.ok) {
            return startResponse;
          }
          const startedPayload = (await startResponse.json()) as {
            run?: { run_id?: unknown };
          };
          const runId =
            typeof startedPayload?.run?.run_id === "string"
              ? startedPayload.run.run_id.trim()
              : "";
          if (!runId) {
            throw new Error("Import run started but no run id was returned.");
          }
          activeImportRunIdRef.current = runId;
          activeImportCursorRef.current = 0;
          persistBackgroundSnapshot("running");
          return ApiService.streamPortfolioImportRun({
            runId,
            userId,
            vaultOwnerToken: importToken,
            cursor: 0,
            signal: abortControllerRef.current?.signal,
          });
        };

        let response: Response;
        try {
          response = await runImportRequest(tokenForImport);
          if (response.status === 401) {
            tokenForImport = await forceRefreshVaultOwnerToken(tokenForImport);
            response = await runImportRequest(tokenForImport);
          }
        } catch (fetchError) {
          if (fetchError instanceof Error && fetchError.name === "AbortError") {
            throw fetchError;
          }
          if (
            fetchError instanceof Error &&
            /session needs refresh|sign in again/i.test(fetchError.message)
          ) {
            throw fetchError;
          }
          throw new Error("Connection issue. Please check your network and try again.");
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          if (response.status === 401) {
            throw new Error("Your session needs refresh. Please sign in again.");
          } else if (response.status === 422) {
            let parsed: Record<string, unknown> | null = null;
            try {
              parsed = JSON.parse(errorText) as Record<string, unknown>;
            } catch {
              parsed = null;
            }
            const detail =
              parsed && typeof parsed.detail === "object" && parsed.detail !== null
                ? (parsed.detail as Record<string, unknown>)
                : null;
            const message =
              (detail && typeof detail.message === "string" && detail.message) ||
              "This document does not appear to be a brokerage statement.";
            throw new Error(message);
          } else if (response.status === 413) {
            throw new Error(MAX_IMPORT_FILE_SIZE_MESSAGE);
          } else if (response.status >= 500) {
            throw new Error("Service is temporarily unavailable. Please try again shortly.");
          }
          throw new Error(`Upload failed: ${response.status} - ${errorText}`);
        }

        let fullStreamedText = "";
        let fullModelTokenText = "";
        let chunkLineBuffer = "";
        let parsedPortfolio: ReviewPortfolioData | null = null;
        let terminalStreamFailureMessage: string | null = null;
        let terminalStreamFailureDetails: string | undefined;
        const validStages = new Set<ImportStage>([
          "idle",
          "uploading",
          "indexing",
          "scanning",
          "thinking",
          "extracting",
          "normalizing",
          "validating",
          "complete",
          "error",
        ]);
        const readNumber = (value: unknown): number | undefined =>
          typeof value === "number" && Number.isFinite(value) ? value : undefined;
        const readString = (value: unknown): string | undefined =>
          typeof value === "string" && value.trim().length > 0 ? value : undefined;
        const readBoolean = (value: unknown): boolean | undefined => {
          if (typeof value === "boolean") return value;
          if (typeof value === "string") {
            const normalized = value.trim().toLowerCase();
            if (normalized === "true") return true;
            if (normalized === "false") return false;
          }
          return undefined;
        };
        const formatQualityGateDetails = (value: unknown): string | undefined => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return undefined;
          }
          const gate = value as Record<string, unknown>;
          const severity = String(gate.severity || "").toLowerCase();
          const reasonsRaw = Array.isArray(gate.reasons)
            ? gate.reasons.map((item) => String(item || "").trim().toLowerCase())
            : [];

          if (severity === "warn" || reasonsRaw.length > 0) {
            const hasReconciliationGap = reasonsRaw.includes("value_reconciliation_gap");
            const hasPlaceholder = reasonsRaw.includes("placeholder_symbols_detected");
            const hasHeaderRows = reasonsRaw.includes("account_header_rows_detected");

            if (hasReconciliationGap || hasPlaceholder || hasHeaderRows) {
              return "Some statement fields were partial. Please review holdings before saving.";
            }
            return "Imported with partial coverage. Please review before saving.";
          }

          if (severity === "fail") {
            return "We could not safely confirm this statement. Please retry with a clearer export.";
          }

          return undefined;
        };
        const readHoldingsPreview = (value: unknown): LiveHoldingPreview[] | undefined => {
          if (!Array.isArray(value)) return undefined;
          const preview: LiveHoldingPreview[] = [];
          for (const row of value) {
            if (!row || typeof row !== "object" || Array.isArray(row)) continue;
            const item = row as Record<string, unknown>;
            const symbol = normalizeTickerSymbol(item.symbol, {
              name: typeof item.name === "string" ? item.name : undefined,
              assetType: typeof item.asset_type === "string" ? item.asset_type : undefined,
            });
            const name =
              typeof item.name === "string" && item.name.trim().length > 0
                ? item.name.trim()
                : undefined;
            const marketValue = readNumber(item.market_value);
            const quantity = readNumber(item.quantity);
            const assetType =
              typeof item.asset_type === "string" && item.asset_type.trim().length > 0
                ? item.asset_type.trim()
                : undefined;
            const positionSideRaw =
              typeof item.position_side === "string" ? item.position_side.trim().toLowerCase() : "";
            const positionSide =
              positionSideRaw === "long" || positionSideRaw === "short" || positionSideRaw === "liability"
                ? (positionSideRaw as "long" | "short" | "liability")
                : undefined;
            // Confirmed preview rows must have a stable symbol and at least one meaningful field.
            if (!symbol) continue;
            if (marketValue === undefined && quantity === undefined && !name && !assetType) continue;
            preview.push({
              symbol,
              name,
              market_value: marketValue,
              quantity,
              asset_type: assetType,
              position_side: positionSide,
              is_short_position: item.is_short_position === true,
              is_liability_position: item.is_liability_position === true,
            });
          }
          return dedupeLiveHoldingPreviewRows(preview);
        };
        const normalizeTrailLine = (next: string): string => {
          const line = next.trim().replace(/\s+/g, " ");
          const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
          if (!match) return line;
          const rawTag = match[1] ?? "";
          const rawMessage = match[2] ?? "";
          const tag = rawTag.trim().toUpperCase();
          const message = rawMessage.trim();
          return message ? `[${tag}] ${message}` : `[${tag}]`;
        };
        const trailLineKey = (line: string): string => {
          const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
          if (!match) return line.trim().toLowerCase();
          const rawTag = match[1] ?? "";
          const rawMessage = match[2] ?? "";
          return `[${rawTag.trim().toUpperCase()}] ${rawMessage.trim().toLowerCase()}`;
        };
        const appendTrailLine = (trail: string[], next?: string): string[] => {
          if (!next) return trail;
          const line = normalizeTrailLine(next);
          if (!line) return trail;
          const key = trailLineKey(line);
          if (trail.some((existingLine) => trailLineKey(existingLine) === key)) return trail;
          return [...trail, line];
        };
        const splitChunkTextIntoLines = (
          text: string,
          options?: { flush?: boolean }
        ): string[] => {
          const flush = Boolean(options?.flush);
          if (text) {
            chunkLineBuffer += text;
          }
          if (!chunkLineBuffer) return [];

          const cleaned = chunkLineBuffer
            .replace(/```(?:json)?/gi, " ")
            .replace(/```/g, " ");
          const lines: string[] = [];
          let working = cleaned;

          const safePush = (candidate: string) => {
            const normalized = normalizeRawStreamLine(candidate);
            if (!normalized) return;
            lines.push(normalized);
          };

          const splitLongLine = (line: string): string[] => {
            const result: string[] = [];
            let remaining = line.trim();
            while (remaining.length > 240) {
              const window = remaining.slice(0, 240);
              const breakAt =
                Math.max(
                  window.lastIndexOf(","),
                  window.lastIndexOf("}"),
                  window.lastIndexOf("]"),
                  window.lastIndexOf("{"),
                  window.lastIndexOf(" "),
                ) || 240;
              const idx = breakAt > 80 ? breakAt : 240;
              result.push(remaining.slice(0, idx + 1).trim());
              remaining = remaining.slice(idx + 1).trim();
            }
            if (remaining) result.push(remaining);
            return result;
          };

          // Prefer newline framing for JSON streams; avoid splitting on periods (e.g. "U.S.")
          while (true) {
            const newlineIndex = working.search(/[\n\r]/);
            if (newlineIndex < 0) break;
            const segment = working.slice(0, newlineIndex);
            splitLongLine(segment).forEach(safePush);
            working = working.slice(newlineIndex + 1);
          }

          if (flush) {
            splitLongLine(working).forEach(safePush);
            chunkLineBuffer = "";
            return lines.filter(Boolean);
          }

          // If no newline for a while, emit bounded chunks to keep stream lively.
          while (working.length > 300) {
            const candidate = working.slice(0, 300);
            const lastDelimiter = Math.max(
              candidate.lastIndexOf(","),
              candidate.lastIndexOf("}"),
              candidate.lastIndexOf("]"),
              candidate.lastIndexOf(" "),
            );
            const idx = lastDelimiter > 100 ? lastDelimiter : 300;
            splitLongLine(working.slice(0, idx + 1)).forEach(safePush);
            working = working.slice(idx + 1);
          }

          chunkLineBuffer = working;
          return lines.filter(Boolean);
        };

        stallMonitorId = window.setInterval(() => {
          if (
            typeof document !== "undefined" &&
            document.visibilityState !== "visible"
          ) {
            // Browsers throttle hidden tabs; avoid false stream-stall aborts while hidden.
            lastStreamEventAt = Date.now();
            return;
          }
          const idleMs = Date.now() - lastStreamEventAt;
          if (!streamStallWarningShown && idleMs >= STREAM_STALL_WARNING_MS) {
            streamStallWarningShown = true;
            const stalledSec = Math.floor(idleMs / 1000);
            setStreaming((prev) => ({
              ...prev,
              stageTrail: appendTrailLine(
                prev.stageTrail,
                `[WATCHDOG] No stream updates for ${stalledSec}s. Still waiting...`
              ),
              rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [
                `[WATCHDOG] No stream updates for ${stalledSec}s. Still waiting...`,
              ]),
              statusMessage: `Still processing... (${stalledSec}s since last update)`,
            }));
          }
          if (!streamStallAbortTriggered && idleMs >= STREAM_STALL_ABORT_MS) {
            streamStallAbortTriggered = true;
            const stalledSec = Math.floor(idleMs / 1000);
            setStreaming((prev) => ({
              ...prev,
              stageTrail: appendTrailLine(
                prev.stageTrail,
                `[ERROR] Import stream stalled for ${stalledSec}s. Aborting stream.`
              ),
              rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [
                `[ERROR] Import stream stalled for ${stalledSec}s. Aborting stream.`,
              ]),
              statusMessage: "Import stream stalled. Retrying is recommended.",
            }));
            abortControllerRef.current?.abort();
          }
        }, STREAM_STALL_CHECK_INTERVAL_MS);

        await consumeCanonicalKaiStream(
          response,
          (envelope: KaiStreamEnvelope) => {
            lastStreamEventAt = Date.now();
            if (streamStallWarningShown) {
              streamStallWarningShown = false;
            }
            const payload = envelope.payload as Record<string, unknown>;
            const runIdFromPayload =
              typeof payload.run_id === "string" && payload.run_id.trim().length > 0
                ? payload.run_id.trim()
                : null;
            if (runIdFromPayload) {
              activeImportRunIdRef.current = runIdFromPayload;
            }
            if (typeof envelope.seq === "number" && Number.isFinite(envelope.seq)) {
              activeImportCursorRef.current = Math.max(
                activeImportCursorRef.current,
                Math.floor(envelope.seq)
              );
            }

            switch (envelope.event) {
              case "stage": {
                const stageValue = typeof payload.stage === "string" ? payload.stage : undefined;
                const normalizedStageValue =
                  stageValue === "analyzing"
                    ? "scanning"
                    : stageValue === "parsing"
                      ? "normalizing"
                      : stageValue;
                const stage =
                  normalizedStageValue && validStages.has(normalizedStageValue as ImportStage)
                    ? (normalizedStageValue as ImportStage)
                    : undefined;
                if (!stage) return;
                const rawStageMessage = readString(payload.message) ?? stage;
                const stageMessage = sanitizeInvestorCopy(rawStageMessage, stage);

                applyStreaming((prev) => ({
                  ...prev,
                  stageTrail: appendTrailLine(
                    prev.stageTrail,
                    `[${stage.toUpperCase()}] ${stageMessage}`
                  ),
                  rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [
                    `[STAGE/${stage.toUpperCase()}] ${stageMessage}`,
                  ]),
                  stage,
                  totalChars: readNumber(payload.total_chars) ?? prev.totalChars,
                  chunkCount: readNumber(payload.chunk_count) ?? prev.chunkCount,
                  thoughtCount: readNumber(payload.thought_count) ?? prev.thoughtCount,
                  progressPct: readNumber(payload.progress_pct) ?? prev.progressPct,
                  statusMessage: stageMessage || prev.statusMessage,
                }));
                break;
              }
              case "thinking": {
                const statusMessage = sanitizeInvestorCopy(readString(payload.message), "");
                applyStreaming((prev) => {
                  return {
                    ...prev,
                    stage: "extracting",
                    thoughts: prev.thoughts,
                    thoughtCount: prev.thoughtCount,
                    progressPct: readNumber(payload.progress_pct) ?? prev.progressPct,
                    statusMessage: statusMessage || prev.statusMessage,
                    streamedText: fullModelTokenText || prev.streamedText,
                  };
                });
                break;
              }
              case "chunk": {
                const text = typeof payload.text === "string" ? payload.text : "";
                const chunkStatusMessage = sanitizeInvestorCopy(readString(payload.message), "");
                const preview = readHoldingsPreview(payload.holdings_preview) ?? [];
                if (text) {
                  fullStreamedText += text;
                  fullModelTokenText += text;
                }
                const chunkLines = splitChunkTextIntoLines(text);
                applyStreaming((prev) => ({
                  ...prev,
                  stage: "extracting",
                  rawStreamLines: appendRawStreamLines(prev.rawStreamLines, chunkLines),
                  streamedText: fullModelTokenText || fullStreamedText,
                  totalChars: readNumber(payload.total_chars) ?? fullStreamedText.length,
                  chunkCount: readNumber(payload.chunk_count) ?? prev.chunkCount,
                  liveHoldings: mergeLiveHoldingPreviewRows(prev.liveHoldings, preview),
                  progressPct: readNumber(payload.progress_pct) ?? prev.progressPct,
                  statusMessage: chunkStatusMessage || prev.statusMessage,
                }));
                break;
              }
              case "progress": {
                const phase = readString(payload.phase);
                const message = sanitizeInvestorCopy(readString(payload.message), "");
                const preview = readHoldingsPreview(payload.holdings_preview) ?? [];
                applyStreaming((prev) => ({
                  ...prev,
                  stageTrail: appendTrailLine(
                    prev.stageTrail,
                    message
                      ? `[${(phase || prev.stage).toUpperCase()}] ${message}`
                        : undefined
                  ),
                  rawStreamLines: appendRawStreamLines(
                    prev.rawStreamLines,
                    message
                      ? [`[PROGRESS/${(phase || String(prev.stage)).toUpperCase()}] ${message}`]
                      : undefined
                  ),
                  stage:
                    phase === "normalizing" || phase === "validating" || phase === "parsing"
                      ? (phase === "parsing" ? "normalizing" : phase as ImportStage)
                      : prev.stage,
                  progressPct: readNumber(payload.progress_pct) ?? prev.progressPct,
                  statusMessage: message ?? prev.statusMessage,
                  holdingsExtracted:
                    readNumber(payload.holdings_extracted) ?? prev.holdingsExtracted,
                  holdingsTotal: readNumber(payload.holdings_total) ?? prev.holdingsTotal,
                  liveHoldings: mergeLiveHoldingPreviewRows(prev.liveHoldings, preview),
                }));
                break;
              }
              case "warning": {
                const message = sanitizeInvestorCopy(readString(payload.message), "");
                if (!message) break;
                applyStreaming((prev) => ({
                  ...prev,
                  stageTrail: appendTrailLine(prev.stageTrail, `[WARNING] ${message}`),
                  rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [
                    `[WARNING] ${message}`,
                  ]),
                  statusMessage: message,
                  progressPct: readNumber(payload.progress_pct) ?? prev.progressPct,
                }));
                break;
              }
              case "complete": {
                const rawPortfolioData = payload.portfolio_data_v2 as
                  | Record<string, unknown>
                  | undefined;
                if (
                  !rawPortfolioData ||
                  typeof rawPortfolioData !== "object" ||
                  Array.isArray(rawPortfolioData)
                ) {
                  throw new Error("Missing portfolio_data_v2 in complete event");
                }
                const parseFallback =
                  readBoolean(payload.parse_fallback) ??
                  readBoolean((rawPortfolioData as Record<string, unknown>).parse_fallback) ??
                  false;
                const rawExtractV2 =
                  payload.raw_extract_v2 &&
                  typeof payload.raw_extract_v2 === "object" &&
                  !Array.isArray(payload.raw_extract_v2)
                    ? (payload.raw_extract_v2 as Record<string, unknown>)
                    : undefined;
                const analyticsV2 =
                  payload.analytics_v2 &&
                  typeof payload.analytics_v2 === "object" &&
                  !Array.isArray(payload.analytics_v2)
                    ? (payload.analytics_v2 as Record<string, unknown>)
                    : undefined;
                const qualityReportV2 =
                  payload.quality_report_v2 &&
                  typeof payload.quality_report_v2 === "object" &&
                  !Array.isArray(payload.quality_report_v2)
                    ? (payload.quality_report_v2 as Record<string, unknown>)
                    : undefined;
                parsedPortfolio = normalizePortfolioData({
                  ...(rawPortfolioData as Record<string, unknown>),
                  raw_extract_v2: rawExtractV2,
                  analytics_v2: analyticsV2,
                  quality_report_v2: qualityReportV2,
                  parse_fallback: parseFallback,
                });

                const qualityReportRaw = qualityReportV2;
                const qualityReport =
                  qualityReportRaw &&
                  typeof qualityReportRaw === "object" &&
                  !Array.isArray(qualityReportRaw)
                    ? ({
                        ...(qualityReportRaw as QualityReport),
                      } as QualityReport)
                    : undefined;
                const trailingChunkLines = splitChunkTextIntoLines("", { flush: true }).map(
                  (line) => line
                );
                const completionMessage = sanitizeInvestorCopy(
                  readString(payload.message),
                  "Import complete!"
                );

                applyStreaming((prev) => ({
                  ...prev,
                  stage: "complete",
                  stageTrail: appendTrailLine(
                    prev.stageTrail,
                    `[COMPLETE] ${completionMessage}`
                  ),
                  rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [
                    ...trailingChunkLines,
                    `[COMPLETE] ${completionMessage}`,
                  ]),
                  thoughtCount: readNumber(payload.thought_count) ?? prev.thoughtCount,
                  qualityReport,
                  holdingsExtracted:
                    parsedPortfolio?.holdings?.length ?? prev.holdingsExtracted,
                  holdingsTotal:
                    parsedPortfolio?.holdings?.length ?? prev.holdingsTotal,
                  liveHoldings:
                    (parsedPortfolio?.holdings ?? []).map((holding) => ({
                      symbol: holding.symbol,
                      name: holding.name,
                      market_value: holding.market_value,
                      quantity: holding.quantity,
                      position_side:
                        holding.position_side === "long" ||
                        holding.position_side === "short" ||
                        holding.position_side === "liability"
                          ? holding.position_side
                          : undefined,
                      is_short_position: holding.is_short_position === true,
                      is_liability_position: holding.is_liability_position === true,
                    })) || prev.liveHoldings,
                  progressPct: readNumber(payload.progress_pct) ?? 100,
                  statusMessage: completionMessage,
                  streamedText: fullModelTokenText || prev.streamedText,
                }));
                break;
              }
              case "aborted": {
                const message = "Import was interrupted before completion. Please retry.";
                terminalStreamFailureMessage = message;
                terminalStreamFailureDetails =
                  formatQualityGateDetails(payload.quality_gate);
                applyStreaming((prev) => ({
                  ...prev,
                  stage: "error",
                  stageTrail: appendTrailLine(prev.stageTrail, `[ERROR] ${message}`),
                  rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [
                    `[ERROR] ${message}`,
                  ]),
                  errorMessage: message,
                  progressPct: readNumber(payload.progress_pct) ?? prev.progressPct,
                  statusMessage: message,
                }));
                break;
              }
              case "error": {
                const message = sanitizeInvestorCopy(
                  typeof payload.message === "string"
                    ? payload.message
                    : "Import could not be completed for this statement.",
                  "Import could not be completed for this statement."
                );
                terminalStreamFailureMessage = message;
                terminalStreamFailureDetails =
                  formatQualityGateDetails(payload.quality_gate);
                applyStreaming((prev) => ({
                  ...prev,
                  stage: "error",
                  stageTrail: appendTrailLine(prev.stageTrail, `[ERROR] ${message}`),
                  rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [
                    `[ERROR] ${message}`,
                  ]),
                  errorMessage: message,
                  progressPct: readNumber(payload.progress_pct) ?? prev.progressPct,
                  statusMessage: message,
                }));
                break;
              }
              default:
                break;
            }
          },
          {
            signal: abortControllerRef.current.signal,
            idleTimeoutMs: KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS,
            requireTerminal: true,
          }
        );

        if (terminalStreamFailureMessage) {
          persistBackgroundSnapshot("failed", {
            errorMessage: terminalStreamFailureMessage,
          });
          if (importTaskId) {
            AppBackgroundTaskService.failTask(
              importTaskId,
              terminalStreamFailureMessage,
              "Portfolio import failed. Please retry."
            );
          }
          setError(terminalStreamFailureMessage);
          toast.error(
            terminalStreamFailureMessage,
            terminalStreamFailureDetails
              ? { description: terminalStreamFailureDetails }
              : undefined
          );
          setState("importing");
          return;
        }

        // Check if we got portfolio data
        if (!parsedPortfolio) {
          throw new Error("No portfolio data was detected in this file.");
        }
        const parsedPortfolioData: ReviewPortfolioData = parsedPortfolio;

        console.log("[KaiFlow] Portfolio parsed via streaming:", {
          holdings: parsedPortfolioData.holdings?.length || 0,
        });

        // Store parsed portfolio and transition to review state
        setFlowData((prev) => ({
          ...prev,
          parsedPortfolio: parsedPortfolioData,
        }));
        persistBackgroundSnapshot("completed", {
          parsedPortfolio: parsedPortfolioData,
        });
        if (importTaskId) {
          AppBackgroundTaskService.completeTask(
            importTaskId,
            "Import complete. Review and save when ready."
          );
        }

        // Persist completion state until user explicitly continues to review.
        setState("import_complete");
        if (parsedPortfolioData.parse_fallback) {
          toast.warning("Portfolio loaded with partial coverage. Please review before saving.");
        } else {
          toast.success("Portfolio is ready for review.");
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          const userInitiatedCancel = userRequestedImportCancelRef.current;
          userRequestedImportCancelRef.current = false;
          if (streamStallAbortTriggered) {
            const stalledMessage =
              "Import stalled with no backend updates. Please retry this statement.";
            setError(stalledMessage);
            toast.error(stalledMessage);
            setStreaming((prev) => ({
              ...prev,
              stage: "error",
              stageTrail: prev.stageTrail.includes(`[ERROR] ${stalledMessage}`)
                ? prev.stageTrail
                : [...prev.stageTrail, `[ERROR] ${stalledMessage}`],
              rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [
                `[ERROR] ${stalledMessage}`,
              ]),
              errorMessage: stalledMessage,
              statusMessage: stalledMessage,
            }));
            setState("importing");
            return;
          }
          if (!userInitiatedCancel) {
            const interruptedMessage = "Import was interrupted before completion. Please retry.";
            setError(interruptedMessage);
            toast.error(interruptedMessage);
            setStreaming((prev) => ({
              ...prev,
              stage: "error",
              stageTrail: prev.stageTrail.includes(`[ERROR] ${interruptedMessage}`)
                ? prev.stageTrail
                : [...prev.stageTrail, `[ERROR] ${interruptedMessage}`],
              rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [
                `[ERROR] ${interruptedMessage}`,
              ]),
              errorMessage: interruptedMessage,
              statusMessage: interruptedMessage,
            }));
            persistBackgroundSnapshot("failed", {
              errorMessage: interruptedMessage,
            });
            if (importTaskId) {
              AppBackgroundTaskService.failTask(
                importTaskId,
                interruptedMessage,
                "Portfolio import was interrupted. Please retry."
              );
            }
            setState("importing");
            return;
          }
          console.log("[KaiFlow] Import cancelled by user");
          persistBackgroundSnapshot("canceled");
          clearImportBackgroundSnapshot(userId);
          importResumeAppliedRef.current = false;
          importSnapshotUpdatedAtRef.current = null;
          if (importTaskId) {
            AppBackgroundTaskService.dismissTask(importTaskId);
          }
          activeImportTaskIdRef.current = null;
          activeImportRunIdRef.current = null;
          activeImportCursorRef.current = 0;
          setStreaming(createInitialStreamingState());
          setState("import_required");
          return;
        }

        console.error("[KaiFlow] Import error:", err);
        const rawErrorMessage =
          err instanceof Error ? String(err.message || "") : String(err || "");
        const isTransientNetworkLoss =
          /network connection was lost|connection issue|failed to fetch|network error|stream error/i.test(
            rawErrorMessage
          );
        const safeError =
          isTransientNetworkLoss
            ? "Connection was interrupted while importing. Reopen import to continue from where it stopped."
            : err instanceof Error
            ? sanitizeInvestorCopy(err.message, err.message)
            : "We could not import your portfolio. Please try again.";
        setError(safeError);
        toast.error(
          safeError
        );
        applyStreaming((prev) => ({
          ...prev,
          stage: "error",
          stageTrail: (() => {
            const nextLine = `[ERROR] ${safeError}`;
            return prev.stageTrail.includes(nextLine)
              ? prev.stageTrail
              : [...prev.stageTrail, nextLine];
          })(),
          rawStreamLines: appendRawStreamLines(prev.rawStreamLines, [
            `[ERROR] ${
              safeError
            }`,
          ]),
          errorMessage: safeError,
          statusMessage: safeError || "Import failed",
        }));
        persistBackgroundSnapshot("failed", {
          errorMessage: safeError,
        });
        if (importTaskId) {
          AppBackgroundTaskService.failTask(
            importTaskId,
            safeError,
            "Portfolio import failed. Please retry."
          );
        }
        setState("importing");
      } finally {
        importStartInFlightRef.current = false;
        if (stallMonitorId !== null) {
          window.clearInterval(stallMonitorId);
        }
        abortControllerRef.current = null;
        setBusyOperation("portfolio_import_stream", false);
      }
    },
    [
      userId,
      vaultKey,
      effectiveVaultOwnerToken,
      tokenExpiresAt,
      unlockVault,
      setBusyOperation,
    ]
  );

  useEffect(() => {
    if (!resumeImportAfterVault || !pendingImportFile) return;
    if (!vaultKey || !effectiveVaultOwnerToken) return;
    const queuedFile = pendingImportFile;
    setResumeImportAfterVault(false);
    setPendingImportFile(null);
    void handleFileUpload(queuedFile);
  }, [
    resumeImportAfterVault,
    pendingImportFile,
    vaultKey,
    effectiveVaultOwnerToken,
    handleFileUpload,
  ]);

  useEffect(() => {
    if (vaultDialogOpen || resumeImportAfterVault || resumePreloadAfterVault) return;
    if (!pendingImportFile) return;
    if (vaultKey && effectiveVaultOwnerToken) return;
    setPendingImportFile(null);
  }, [
    vaultDialogOpen,
    resumeImportAfterVault,
    resumePreloadAfterVault,
    pendingImportFile,
    vaultKey,
    effectiveVaultOwnerToken,
  ]);

  useEffect(() => {
    if (vaultDialogOpen || resumeImportAfterVault || resumePreloadAfterVault) return;
    if (!pendingSchemaPreload) return;
    if (vaultKey && effectiveVaultOwnerToken) return;
    setPendingSchemaPreload(false);
  }, [
    vaultDialogOpen,
    resumeImportAfterVault,
    resumePreloadAfterVault,
    pendingSchemaPreload,
    vaultKey,
    effectiveVaultOwnerToken,
  ]);

  // Handle cancel import
  const handleCancelImport = useCallback(() => {
    userRequestedImportCancelRef.current = true;
    const runId = activeImportRunIdRef.current;
    if (runId && effectiveVaultOwnerToken) {
      void ApiService.cancelPortfolioImportRun({
        runId,
        userId,
        vaultOwnerToken: effectiveVaultOwnerToken,
      }).catch((cancelError) => {
        console.warn("[KaiFlow] Failed to cancel import run on backend:", cancelError);
      });
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const taskId = activeImportTaskIdRef.current;
    if (taskId) {
      AppBackgroundTaskService.dismissTask(taskId);
    }
    activeImportTaskIdRef.current = null;
    activeImportRunIdRef.current = null;
    activeImportCursorRef.current = 0;
    importResumeAppliedRef.current = false;
    importSnapshotUpdatedAtRef.current = null;
    clearImportBackgroundSnapshot(userId);
    setBusyOperation("portfolio_import_stream", false);
    setState(flowData.portfolioData ? "dashboard" : "import_required");
    setStreaming(createInitialStreamingState());
    if (mode === "import" && flowData.portfolioData) {
      router.push(ROUTES.KAI_DASHBOARD);
      return;
    }
  }, [effectiveVaultOwnerToken, flowData.portfolioData, mode, router, setBusyOperation, userId]);

  // Handle retry import after stream error/stall.
  const handleRetryImport = useCallback(() => {
    importResumeAppliedRef.current = false;
    importSnapshotUpdatedAtRef.current = null;
    activeImportTaskIdRef.current = null;
    activeImportRunIdRef.current = null;
    activeImportCursorRef.current = 0;
    clearImportBackgroundSnapshot(userId);
    setError(null);
    const retryFile = lastImportFileRef.current;
    setStreaming(createInitialStreamingState());
    if (retryFile) {
      void handleFileUpload(retryFile);
      return;
    }
    setState("import_required");
  }, [handleFileUpload, userId]);

  const handleReviewParsedPortfolio = useCallback(() => {
    if (!flowData.parsedPortfolio) {
      toast.error("Parsed portfolio not available. Please import again.");
      setState("import_required");
      return;
    }
    setState("reviewing");
  }, [flowData.parsedPortfolio]);

  const handleBackToDashboardFromImport = useCallback(() => {
    if (mode === "import") {
      setOnboardingFlowActiveCookie(false);
      router.push(ROUTES.KAI_DASHBOARD);
      return;
    }
    if (flowData.portfolioData) {
      setState("dashboard");
    } else {
      setState("import_required");
    }
  }, [flowData.portfolioData, mode, router]);

  // Handle save complete from review screen
  const handleSaveComplete = useCallback(async (savedData: ReviewPortfolioData) => {
    // Convert to dashboard format and update flow data
    // Map the review types to dashboard types
    // Normalize holdings to ensure unrealized_gain_loss_pct is computed
    const normalizedHoldings = normalizeHoldingsWithPct(savedData.holdings);
    
    const portfolioData: PortfolioData = {
      account_info: savedData.account_info ? {
        account_number: savedData.account_info.account_number,
        brokerage_name: savedData.account_info.brokerage,
        account_holder: savedData.account_info.holder_name,
      } : undefined,
      account_summary: savedData.account_summary ? {
        beginning_value: savedData.account_summary.beginning_value,
        ending_value: savedData.account_summary.ending_value ?? savedData.total_value ?? 0,
        change_in_value: savedData.account_summary.change_in_value,
        cash_balance: savedData.account_summary.cash_balance,
        equities_value: savedData.account_summary.equities_value,
      } : undefined,
      holdings: normalizedHoldings,
      transactions: [],
      asset_allocation: savedData.asset_allocation ? {
        cash_percent: savedData.asset_allocation.cash_pct,
        equities_percent: savedData.asset_allocation.equities_pct,
        bonds_percent: savedData.asset_allocation.bonds_pct,
      } : undefined,
      income_summary: savedData.income_summary ? {
        dividends: savedData.income_summary.dividends_taxable,
        interest: savedData.income_summary.interest_income,
        total: savedData.income_summary.total_income,
      } : undefined,
      realized_gain_loss: savedData.realized_gain_loss ? {
        short_term: savedData.realized_gain_loss.short_term_gain,
        long_term: savedData.realized_gain_loss.long_term_gain,
        total: savedData.realized_gain_loss.net_realized,
      } : undefined,
      parse_fallback: savedData.parse_fallback,
    };

    const holdingSymbols = normalizedHoldings?.map((h) => h.symbol) || [];

    // Update cache context so other pages (Manage, etc.) can access the data
    setPortfolioData(userId, portfolioData);
    CacheSyncService.onPortfolioUpserted(userId, portfolioData);
    console.log("[KaiFlow] Portfolio data saved to cache");

    setFlowData({
      hasFinancialData: true,
      holdingsCount: savedData.holdings?.length || 0,
      holdings: holdingSymbols,
      portfolioData,
      parsedPortfolio: undefined, // Clear parsed data
    });
    clearImportBackgroundSnapshot(userId);
    importResumeAppliedRef.current = false;
    importSnapshotUpdatedAtRef.current = null;
    activeImportRunIdRef.current = null;
    activeImportCursorRef.current = 0;
    if (activeImportTaskIdRef.current) {
      AppBackgroundTaskService.dismissTask(activeImportTaskIdRef.current);
      activeImportTaskIdRef.current = null;
    }

    if (mode === "import") {
      setOnboardingFlowActiveCookie(false);
      router.push(ROUTES.KAI_DASHBOARD);
      return;
    }

    setState("dashboard");
  }, [mode, router, userId, setPortfolioData]);

  // Handle skip import - preserve existing data if available
  const handleSkipImport = useCallback(() => {
    if (mode === "import") {
      setOnboardingFlowActiveCookie(false);
      router.push(ROUTES.KAI_HOME);
      return;
    }

    setState("dashboard");
    // Only reset flowData if there's no existing portfolio data
    // This preserves data when user clicks "Upload New Statement" then skips
    if (!flowData.portfolioData) {
      setFlowData({ hasFinancialData: false });
    }
  }, [flowData.portfolioData, mode, router]);

  const handleConnectPlaid = useCallback(async () => {
    if (!effectiveVaultOwnerToken) {
      toast.error("Please unlock your Vault first.");
      return;
    }

    setIsConnectingPlaid(true);
    try {
      const redirectUri =
        typeof window !== "undefined"
          ? new URL(ROUTES.KAI_PLAID_OAUTH_RETURN, window.location.origin).toString()
          : undefined;
      const linkToken = await PlaidPortfolioService.createLinkToken({
        userId,
        vaultOwnerToken: effectiveVaultOwnerToken,
        redirectUri,
      });

      if (!linkToken.configured || !linkToken.link_token) {
        throw new Error("Plaid is not configured for this environment.");
      }
      if (linkToken.resume_session_id) {
        savePlaidOAuthResumeSession({
          version: 1,
          userId,
          resumeSessionId: linkToken.resume_session_id,
          returnPath: ROUTES.KAI_DASHBOARD,
          startedAt: new Date().toISOString(),
        });
      }

      const Plaid = await loadPlaidLink();
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          callback();
        };

        const handler = Plaid.create({
          token: linkToken.link_token,
          onSuccess: (publicToken: string, metadata: Record<string, unknown>) => {
            void PlaidPortfolioService.exchangePublicToken({
              userId,
              publicToken,
              vaultOwnerToken: effectiveVaultOwnerToken,
              metadata,
              resumeSessionId: linkToken.resume_session_id || null,
            })
              .then((status) => {
                clearPlaidOAuthResumeSession();
                setPlaidStatus(status);
                const plaidPortfolio = status.aggregate?.portfolio_data || null;
                setFlowData((current) => ({
                  ...current,
                  hasFinancialData:
                    current.hasFinancialData || hasPortfolioHoldings(plaidPortfolio),
                  holdingsCount:
                    (current.portfolioData?.holdings?.length || 0) ||
                    (Array.isArray(plaidPortfolio?.holdings) ? plaidPortfolio.holdings.length : 0),
                  holdings:
                    current.portfolioData?.holdings?.map((holding) => holding.symbol) ||
                    plaidPortfolio?.holdings?.map((holding) => holding.symbol) ||
                    [],
                }));
                toast.success("Brokerage connected with Plaid.");
                if (mode === "import") {
                  setOnboardingFlowActiveCookie(false);
                  router.push(ROUTES.KAI_DASHBOARD);
                } else {
                  setState("dashboard");
                }
                finish(resolve);
              })
              .catch((exchangeError) => {
                finish(() =>
                  reject(
                    exchangeError instanceof Error
                      ? exchangeError
                      : new Error("Plaid connection failed.")
                  )
                );
              })
              .finally(() => {
                handler.destroy?.();
              });
          },
          onExit: (exitError: Record<string, unknown> | null) => {
            handler.destroy?.();
            clearPlaidOAuthResumeSession();
            if (exitError && typeof exitError === "object") {
              const detail =
                typeof exitError.error_message === "string"
                  ? exitError.error_message
                  : "Plaid Link closed with an error.";
              finish(() => reject(new Error(detail)));
              return;
            }
            finish(resolve);
          },
        });

        handler.open();
      });
    } catch (plaidError) {
      clearPlaidOAuthResumeSession();
      toast.error("Could not connect Plaid.", {
        description:
          plaidError instanceof Error ? plaidError.message : "Please try again.",
      });
    } finally {
      setIsConnectingPlaid(false);
      await loadPlaidStatusSnapshot();
    }
  }, [effectiveVaultOwnerToken, loadPlaidStatusSnapshot, mode, router, userId]);

  // Handle re-import (upload new statement)
  const handleReimport = useCallback(() => {
    const snapshot = loadImportBackgroundSnapshot(userId);
    if (snapshot?.taskId) {
      AppBackgroundTaskService.dismissTask(snapshot.taskId);
    }
    clearImportBackgroundSnapshot(userId);
    importResumeAppliedRef.current = false;
    importSnapshotUpdatedAtRef.current = null;
    activeImportTaskIdRef.current = null;
    activeImportRunIdRef.current = null;
    activeImportCursorRef.current = 0;
    lastImportFileRef.current = null;
    setStreaming(createInitialStreamingState());
    setError(null);
    setFlowData((prev) => ({
      ...prev,
      parsedPortfolio: undefined,
    }));

    if (mode === "dashboard") {
      router.push(ROUTES.KAI_IMPORT);
      return;
    }
    setState("import_required");
  }, [mode, router, userId]);

  const handlePreloadSchema = useCallback(async () => {
    if (isPreloadingSchema) return;

    setIsPreloadingSchema(true);
    setError(null);

    try {
      const template = await fetchDemoModePortfolioTemplate(effectiveVaultOwnerToken);

      setFlowData((previous) => ({
        ...previous,
        parsedPortfolio: template,
      }));
      setState("reviewing");
      setError(null);
      toast.success("Sample brokerage data loaded. Review and save to Vault.");
    } catch (preloadError) {
      console.error("[KaiFlow] Failed to preload schema data:", preloadError);
      toast.error("Could not load sample data. Please try again.");
    } finally {
      setPendingSchemaPreload(false);
      setIsPreloadingSchema(false);
    }
  }, [
    effectiveVaultOwnerToken,
    isPreloadingSchema,
  ]);

  useEffect(() => {
    if (mode !== "import" || state !== "reviewing") return;
    if (flowData.parsedPortfolio) return;

    const timer = window.setTimeout(() => {
      if (stateRef.current !== "reviewing" || flowData.parsedPortfolio) return;
      setError("Could not open review data. Please load sample data again.");
      setState("import_required");
    }, 250);

    return () => window.clearTimeout(timer);
  }, [mode, state, flowData.parsedPortfolio]);

  useEffect(() => {
    if (!resumePreloadAfterVault) return;
    if (!vaultKey || !effectiveVaultOwnerToken) return;
    setResumePreloadAfterVault(false);
    void handlePreloadSchema();
  }, [resumePreloadAfterVault, vaultKey, effectiveVaultOwnerToken, handlePreloadSchema]);

  // Handle analyze stock - starts streaming analysis
  const handleAnalyzeStock = useCallback((symbol: string, options?: AnalysisLaunchOptions) => {
    console.log("[KaiFlow] handleAnalyzeStock called with:", symbol);
    console.log("[KaiFlow] vaultOwnerToken present:", !!effectiveVaultOwnerToken);
    
    if (!symbol || !effectiveVaultOwnerToken) {
      toast.error("Please unlock your Vault first.");
      return;
    }
    
    // Get context for confirmation dialog
    getStockContext(symbol, effectiveVaultOwnerToken)
      .then((context) => {
        console.log("[KaiFlow] Context received:", context?.ticker || "no ticker");
        
        // Store analysis params in Zustand store for the analysis page
        const params = {
          ticker: symbol.toUpperCase(),
          userId,
          riskProfile: context.user_risk_profile || "balanced",
          userContext: context,
          portfolioSource: options?.portfolioSource,
          portfolioContext: options?.portfolioContext ?? null,
        };
        console.log("[KaiFlow] Params to store:", JSON.stringify(params));
        
        useKaiSession.getState().setAnalysisParams(params);
        
        // Navigate to analysis view (DebateStreamView will read from Zustand store)
        console.log("[KaiFlow] Navigating to /kai/analysis");
        router.push(ROUTES.KAI_ANALYSIS);
      })
      .catch((error) => {
        console.error("[KaiFlow] Error getting context:", error);
        toast.error("Could not start analysis", {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      });
  }, [effectiveVaultOwnerToken, userId, router]);

  // Handle back to dashboard from analysis
  const handleBackToDashboard = useCallback(() => {
    setState("dashboard");
  }, []);

  // =============================================================================
  // RENDER
  // =============================================================================

  if (state === "checking") {
    return (
      <div className="min-h-[400px] flex items-center justify-center">
        <HushhLoader variant="inline" label={toInvestorLoading("ACCOUNT_STATE")} />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col">
      {/* Error display */}
      {error && state !== "importing" && state !== "import_complete" && (
        <SurfaceCard tone="critical" className="mb-4">
          <SurfaceCardContent className="space-y-3 pt-5">
            <div className="flex items-start gap-2 text-red-600 dark:text-red-400">
              <svg
                className="mt-0.5 h-5 w-5 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="text-sm font-medium">{error}</span>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-left text-sm font-medium text-red-700 underline underline-offset-4 hover:no-underline dark:text-red-300"
            >
              Dismiss
            </button>
          </SurfaceCardContent>
        </SurfaceCard>
      )}

      {/* State-based rendering */}
      {state === "import_required" && (
        <PortfolioImportView
          onFileSelect={handleFileUpload}
          onSkip={handleSkipImport}
          onPreloadSchema={() => void handlePreloadSchema()}
          onConnectPlaid={() => void handleConnectPlaid()}
          isUploading={false}
          isPreloadingSchema={isPreloadingSchema}
          isConnectingPlaid={isConnectingPlaid}
          plaidConfigured={plaidConfigured}
          plaidConnectedInstitutionCount={plaidStatus?.aggregate?.item_count || 0}
        />
      )}

      {state === "importing" && (
        <ImportProgressView
          stage={streaming.stage}
          stageTrail={streaming.stageTrail}
          rawStreamLines={streaming.rawStreamLines}
          isStreaming={
            streaming.stage === "uploading" ||
            streaming.stage === "indexing" ||
            streaming.stage === "scanning" ||
            streaming.stage === "thinking" ||
            streaming.stage === "extracting" ||
            streaming.stage === "normalizing" ||
            streaming.stage === "validating"
          }
          progressPct={streaming.progressPct}
          statusMessage={streaming.statusMessage}
          liveHoldings={streaming.liveHoldings}
          holdingsExtracted={streaming.holdingsExtracted}
          holdingsTotal={streaming.holdingsTotal}
          thoughts={streaming.thoughts}
          thoughtCount={streaming.thoughtCount}
          errorMessage={streaming.errorMessage}
          onRetry={streaming.stage === "error" ? handleRetryImport : undefined}
          onCancel={handleCancelImport}
        />
      )}

      {state === "import_complete" && (
        <ImportProgressView
          stage="complete"
          stageTrail={streaming.stageTrail}
          rawStreamLines={streaming.rawStreamLines}
          isStreaming={false}
          progressPct={streaming.progressPct}
          statusMessage={streaming.statusMessage}
          liveHoldings={streaming.liveHoldings}
          holdingsExtracted={streaming.holdingsExtracted}
          holdingsTotal={streaming.holdingsTotal}
          thoughts={streaming.thoughts}
          thoughtCount={streaming.thoughtCount}
          onContinue={handleReviewParsedPortfolio}
          onBackToDashboard={handleBackToDashboardFromImport}
        />
      )}

      {state === "reviewing" && flowData.parsedPortfolio && (
        <PortfolioReviewView
          portfolioData={flowData.parsedPortfolio}
          userId={userId}
          vaultKey={vaultKey ?? undefined}
          vaultOwnerToken={effectiveVaultOwnerToken}
          onSaveComplete={handleSaveComplete}
          onReimport={handleReimport}
          onBack={() => setState("import_required")}
        />
      )}

      {state === "reviewing" && !flowData.parsedPortfolio && (
        <div className="flex min-h-[360px] w-full flex-col items-center justify-center gap-3 px-6 text-center">
          <HushhLoader variant="inline" label="Preparing your review..." />
          <p className="text-sm text-muted-foreground">
            Sample data loaded, but the review sheet is not ready yet.
          </p>
          <button
            type="button"
            onClick={() => setState("import_required")}
            className="text-sm font-semibold text-primary underline underline-offset-4"
          >
            Back to import
          </button>
        </div>
      )}

      {isDashboardMode &&
        state === "dashboard" &&
        (Boolean(flowData.hasFinancialData) || Boolean(plaidPortfolioData)) && (
        <DashboardMasterView
          userId={userId}
          vaultOwnerToken={effectiveVaultOwnerToken ?? ""}
          portfolioData={
            (flowData.portfolioData ?? plaidPortfolioData ?? { holdings: [] }) as PortfolioData
          }
          onAnalyzeStock={handleAnalyzeStock}
          onReupload={handleReimport}
        />
      )}

      {isDashboardMode &&
        state === "dashboard" &&
        !flowData.hasFinancialData &&
        !plaidPortfolioData && (
        <PortfolioImportView
          onFileSelect={handleFileUpload}
          onSkip={handleSkipImport}
          onPreloadSchema={() => void handlePreloadSchema()}
          onConnectPlaid={() => void handleConnectPlaid()}
          isUploading={false}
          isPreloadingSchema={isPreloadingSchema}
          isConnectingPlaid={isConnectingPlaid}
          plaidConfigured={plaidConfigured}
          plaidConnectedInstitutionCount={plaidStatus?.aggregate?.item_count || 0}
        />
      )}

      {isDashboardMode && state === "analysis" && flowData.analysisResult && (
        <AnalysisView
          result={flowData.analysisResult}
          onBack={handleBackToDashboard}
          onAnalyzeAnother={(symbol: string) => handleAnalyzeStock(symbol)}
        />
      )}

      {isDashboardMode && state === "analysis" && !flowData.analysisResult && (
        <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
          <HushhLoader variant="inline" label={toInvestorLoading("ANALYSIS")} />
          <p className="text-sm text-muted-foreground">
            Building your recommendation...
          </p>
        </div>
      )}

      {user && (
        <VaultUnlockDialog
          user={user}
          open={vaultDialogOpen}
          onOpenChange={setVaultDialogOpen}
          title="Create or unlock Vault to import portfolio"
          description="You need to create or unlock your Vault before importing your statement."
          enableGeneratedDefault
          onSuccess={() => {
            setVaultDialogOpen(false);
            if (pendingImportFile) {
              setResumeImportAfterVault(true);
              return;
            }
            if (pendingSchemaPreload) {
              setResumePreloadAfterVault(true);
            }
          }}
        />
      )}
    </div>
  );
}
