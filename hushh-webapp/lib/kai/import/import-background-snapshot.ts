import type { ImportStage } from "@/components/kai/views/import-progress-view";
import type { PortfolioData as ReviewPortfolioData } from "@/components/kai/views/portfolio-review-view";
import { findHoldingValidationIssue, holdingValueIssue } from "@/lib/kai/holding-validation";
import type { LiveHoldingPreview } from "./live-holdings-preview";
import {
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";

export const IMPORT_REVIEW_CHANGED = "kai:import-review-changed";

export interface QualityReport {
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

// Streaming state
export interface StreamingState {
  stage: ImportStage;
  stageTrail: string[];
  rawStreamLines: string[];
  streamedText: string;
  totalChars: number;
  chunkCount: number;
  progressPct?: number;
  statusMessage?: string;
  thoughts: string[]; // Array of thought summaries from Gemini thinking mode
  thoughtCount: number;
  qualityReport?: QualityReport;
  liveHoldings: LiveHoldingPreview[];
  holdingsExtracted: number;
  holdingsTotal?: number;
  errorMessage?: string;
}

export type ImportBackgroundStatus = "running" | "completed" | "failed" | "canceled";

export interface PersistedImportBackgroundSnapshot {
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

export function createInitialStreamingState(): StreamingState {
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

export function loadImportBackgroundSnapshot(
  userId: string,
): PersistedImportBackgroundSnapshot | null {
  const raw = getSessionItem(KAI_IMPORT_BACKGROUND_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      raw,
    ) as Partial<PersistedImportBackgroundSnapshot>;
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
        typeof parsed.latestCursor === "number" &&
        Number.isFinite(parsed.latestCursor)
          ? Math.max(0, Math.floor(parsed.latestCursor))
          : 0,
      status:
        parsed.status === "completed" ||
        parsed.status === "failed" ||
        parsed.status === "canceled"
          ? parsed.status
          : "running",
      startedAt:
        typeof parsed.startedAt === "string" &&
        parsed.startedAt.trim().length > 0
          ? parsed.startedAt
          : new Date().toISOString(),
      updatedAt:
        typeof parsed.updatedAt === "string" &&
        parsed.updatedAt.trim().length > 0
          ? parsed.updatedAt
          : new Date().toISOString(),
      errorMessage:
        typeof parsed.errorMessage === "string" &&
        parsed.errorMessage.trim().length > 0
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

export function saveImportBackgroundSnapshot(
  snapshot: PersistedImportBackgroundSnapshot,
): void {
  // Recovery persists run identity and status, never provisional source records.
  const persisted = snapshot.status === "completed" ? snapshot : {
    ...snapshot,
    streaming: { ...snapshot.streaming, liveHoldings: [], rawStreamLines: [],
      streamedText: "", thoughts: [], qualityReport: undefined },
    parsedPortfolio: undefined,
  };
  setSessionItem(KAI_IMPORT_BACKGROUND_KEY, JSON.stringify(persisted));
  if (snapshot.status !== "running" && typeof window !== "undefined") {
    window.dispatchEvent(new Event(IMPORT_REVIEW_CHANGED));
  }
}

export function clearImportBackgroundSnapshot(userId: string): void {
  void userId;
  removeSessionItem(KAI_IMPORT_BACKGROUND_KEY);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(IMPORT_REVIEW_CHANGED));
}

export function getPendingImportReview(userId: string) {
  const draft = loadImportBackgroundSnapshot(userId);
  if (!draft || draft.status !== "completed" || !draft.runId || !draft.parsedPortfolio) return null;
  const period = draft.parsedPortfolio.account_info?.statement_period_end;
  const date = period ? new Date(period) : null;
  const month = date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString(undefined, { month: "long", timeZone: "UTC" })
    : null;
  const holdings = draft.parsedPortfolio.holdings || [];
  const issue = findHoldingValidationIssue(holdings)?.issue;
  const count = issue ? holdings.filter(holding => !holding.pending_delete &&
    holdingValueIssue(holding)?.field === issue.field).length : 0;
  return { runId: draft.runId, timestamp: draft.updatedAt, month, correction: issue ? { field: issue.field, count } : null };
}
