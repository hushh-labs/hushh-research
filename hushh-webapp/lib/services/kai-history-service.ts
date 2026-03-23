/**
 * Kai Analysis History Service
 *
 * Manages analysis history within the encrypted PKM financial domain.
 * Uses FIFO strategy: max 3 analyses per ticker, newest first.
 *
 * Canonical storage path:
 *   financial.analysis_history
 *
 * Structure inside encrypted blob:
 * {
 *   "financial": {
 *     "analysis_history": {
 *     "AMZN": [entry3, entry2, entry1],  // newest first, max 3
 *     "AAPL": [entry2, entry1],
 *     }
 *   }
 * }
 */

import { PersonalKnowledgeModelService } from "./personal-knowledge-model-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";


const MAX_HISTORY_PER_TICKER = 3;
const FINANCIAL_DOMAIN = "financial";
const FINANCIAL_SCHEMA_VERSION = 3;
const FINANCIAL_CONTRACT_VERSION = 1;
const FINANCIAL_INTENT_MAP = [
  "portfolio",
  "profile",
  "documents",
  "analysis_history",
  "runtime",
  "analysis.decisions",
] as const;

// ============================================================================
// Types
// ============================================================================

export interface AnalysisHistoryEntry {
  ticker: string;
  timestamp: string; // ISO date
  decision: "buy" | "hold" | "reduce" | string;
  confidence: number;
  consensus_reached: boolean;
  agent_votes: Record<string, string>;
  final_statement: string;
  raw_card: Record<string, any>; // Full decision card data
  debate_transcript?: {
    round1: Record<string, any>;
    round2: Record<string, any>;
  };
}

export type AnalysisHistoryMap = Record<string, AnalysisHistoryEntry[]>;

function sanitizeTicker(value: unknown): string {
  const ticker = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!ticker || ticker === "UNDEFINED" || ticker === "NULL") return "";
  return ticker;
}

function sanitizeHistoryMap(rawMap: Record<string, unknown>): AnalysisHistoryMap {
  const sanitized: AnalysisHistoryMap = {};

  for (const [rawKey, maybeEntries] of Object.entries(rawMap)) {
    if (!Array.isArray(maybeEntries)) continue;

    const keyTicker = sanitizeTicker(rawKey);
    const entries = maybeEntries
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
      .map((entry) => {
        const ticker = sanitizeTicker(entry.ticker) || keyTicker;
        if (!ticker) return null;

        const rawTimestamp = typeof entry.timestamp === "string" ? entry.timestamp.trim() : "";
        const timestamp = rawTimestamp.length > 0 ? rawTimestamp : new Date(0).toISOString();
        const decision =
          typeof entry.decision === "string" && entry.decision.trim().length > 0
            ? entry.decision.trim()
            : "hold";
        const confidenceRaw =
          typeof entry.confidence === "number" ? entry.confidence : Number(entry.confidence);
        const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : 0;

        const normalized: AnalysisHistoryEntry = {
          ticker,
          timestamp,
          decision,
          confidence,
          consensus_reached: Boolean(entry.consensus_reached),
          agent_votes:
            entry.agent_votes && typeof entry.agent_votes === "object" && !Array.isArray(entry.agent_votes)
              ? (entry.agent_votes as Record<string, string>)
              : {},
          final_statement:
            typeof entry.final_statement === "string" ? entry.final_statement : "",
          raw_card:
            entry.raw_card && typeof entry.raw_card === "object" && !Array.isArray(entry.raw_card)
              ? (entry.raw_card as Record<string, unknown>)
              : {},
        };

        if (
          entry.debate_transcript &&
          typeof entry.debate_transcript === "object" &&
          !Array.isArray(entry.debate_transcript)
        ) {
          normalized.debate_transcript = entry.debate_transcript as AnalysisHistoryEntry["debate_transcript"];
        }

        return normalized;
      })
      .filter((entry): entry is AnalysisHistoryEntry => entry !== null);

    for (const entry of entries) {
      const bucket = sanitized[entry.ticker] || [];
      bucket.push(entry);
      sanitized[entry.ticker] = bucket;
    }
  }

  return sanitized;
}

function normalizeTickerKey(
  historyMap: AnalysisHistoryMap,
  ticker: string
): string | null {
  const wanted = String(ticker || "").trim().toUpperCase();
  const canonicalWanted = wanted.replace(/[^A-Z0-9]/g, "");
  if (!wanted && !canonicalWanted) return null;
  if (Object.prototype.hasOwnProperty.call(historyMap, wanted)) return wanted;
  const matched = Object.keys(historyMap).find((key) => {
    const keyUpper = key.toUpperCase();
    if (keyUpper === wanted) return true;
    return keyUpper.replace(/[^A-Z0-9]/g, "") === canonicalWanted;
  });
  return matched ?? null;
}

function toEpochMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const epoch = Date.parse(trimmed);
  return Number.isFinite(epoch) ? epoch : null;
}

function timestampsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftTrimmed = typeof left === "string" ? left.trim() : "";
  const rightTrimmed = typeof right === "string" ? right.trim() : "";
  if (!leftTrimmed || !rightTrimmed) return false;
  if (leftTrimmed === rightTrimmed) return true;

  const leftEpoch = toEpochMs(leftTrimmed);
  const rightEpoch = toEpochMs(rightTrimmed);
  if (leftEpoch === null || rightEpoch === null) return false;

  // Keep a small tolerance for source formatting differences.
  return Math.abs(leftEpoch - rightEpoch) <= 1000;
}

function extractStreamId(entry: AnalysisHistoryEntry): string | null {
  const rawCard = entry.raw_card;
  if (!rawCard || typeof rawCard !== "object") return null;
  const diagnostics = (rawCard as Record<string, unknown>).stream_diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return null;
  const streamId = (diagnostics as Record<string, unknown>).stream_id;
  if (typeof streamId !== "string") return null;
  const trimmed = streamId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractRunId(entry: AnalysisHistoryEntry): string | null {
  const rawCard = entry.raw_card;
  if (!rawCard || typeof rawCard !== "object") return null;
  const direct = (rawCard as Record<string, unknown>).debate_run_id;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  return extractStreamId(entry);
}

function buildHistorySummary(
  historyMap: AnalysisHistoryMap,
  lastTicker?: string,
  lastTimestamp?: string
): Record<string, unknown> {
  const tickers = Object.keys(historyMap);
  const totalAnalyses = Object.values(historyMap).reduce((sum, arr) => sum + arr.length, 0);

  const summary: Record<string, unknown> = {
    domain_contract_version: FINANCIAL_CONTRACT_VERSION,
    intent_map: [...FINANCIAL_INTENT_MAP],
    analysis_total_analyses: totalAnalyses,
    analysis_tickers_analyzed: tickers,
    analysis_last_updated: new Date().toISOString(),
    // Compatibility keys retained for existing dashboards.
    total_analyses: totalAnalyses,
    tickers_analyzed: tickers,
    last_updated: new Date().toISOString(),
  };

  if (lastTicker) {
    summary.last_analysis_ticker = lastTicker;
  }
  if (lastTimestamp) {
    summary.last_analysis_date = lastTimestamp;
  }

  return summary;
}

function selectFinancialDomain(fullBlob: Record<string, unknown>): Record<string, unknown> {
  const raw = fullBlob[FINANCIAL_DOMAIN];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return { ...(raw as Record<string, unknown>) };
}

function extractHistoryMap(fullBlob: Record<string, unknown>): AnalysisHistoryMap {
  const financialRaw = fullBlob[FINANCIAL_DOMAIN];
  if (financialRaw && typeof financialRaw === "object" && !Array.isArray(financialRaw)) {
    const financial = financialRaw as Record<string, unknown>;
    const canonicalHistory = financial.analysis_history;
    if (
      canonicalHistory &&
      typeof canonicalHistory === "object" &&
      !Array.isArray(canonicalHistory)
    ) {
      return sanitizeHistoryMap(canonicalHistory as Record<string, unknown>);
    }
  }

  return {};
}

function extractHistoryMapFromFinancialDomain(financialDomain: Record<string, unknown>): AnalysisHistoryMap {
  const canonicalHistory = financialDomain.analysis_history;
  if (
    canonicalHistory &&
    typeof canonicalHistory === "object" &&
    !Array.isArray(canonicalHistory)
  ) {
    return sanitizeHistoryMap(canonicalHistory as Record<string, unknown>);
  }
  return {};
}

function buildFinancialDomainWithHistory(params: {
  fullBlob: Record<string, unknown>;
  historyMap: AnalysisHistoryMap;
  nowIso: string;
}): Record<string, unknown> {
  const existingFinancial = selectFinancialDomain(params.fullBlob);
  const existingAnalysisRaw = existingFinancial.analysis;
  const existingAnalysis =
    existingAnalysisRaw && typeof existingAnalysisRaw === "object" && !Array.isArray(existingAnalysisRaw)
      ? (existingAnalysisRaw as Record<string, unknown>)
      : {};

  return {
    ...existingFinancial,
    schema_version: FINANCIAL_SCHEMA_VERSION,
    domain_intent: {
      primary: "financial",
      source: "domain_registry_prepopulate",
      contract_version: FINANCIAL_CONTRACT_VERSION,
      updated_at: params.nowIso,
    },
    analysis_history: {
      ...params.historyMap,
      domain_intent: {
        primary: "financial",
        secondary: "analysis_history",
        source: "kai_analysis_stream",
        updated_at: params.nowIso,
      },
    },
    analysis: {
      ...existingAnalysis,
      domain_intent: {
        primary: "financial",
        secondary: "analysis",
        source: "kai_analysis_stream",
        updated_at: params.nowIso,
      },
      decisions:
        existingAnalysis.decisions &&
        typeof existingAnalysis.decisions === "object" &&
        !Array.isArray(existingAnalysis.decisions)
          ? existingAnalysis.decisions
          : {},
    },
    updated_at: params.nowIso,
  };
}

// ============================================================================
// Service
// ============================================================================

export class KaiHistoryService {
  /**
   * Save a new analysis result to history.
   * Implements FIFO: prepends new entry, pops oldest if > MAX_HISTORY_PER_TICKER.
   *
   * Uses fetch-decrypt-merge-encrypt-save cycle to avoid overwriting other domains.
   */
  static async saveAnalysis(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken?: string;
    entry: AnalysisHistoryEntry;
  }): Promise<boolean> {
    const { userId, vaultKey, vaultOwnerToken, entry } = params;

    try {
      // 1. Fetch only the financial domain we need for history persistence.
      const existingFinancialDomain = await PersonalKnowledgeModelService.loadDomainData({
        userId,
        domain: FINANCIAL_DOMAIN,
        vaultKey,
        vaultOwnerToken,
      }).catch((e) => {
        console.warn("[KaiHistory] Could not fetch/decrypt financial domain, starting fresh:", e);
        return null;
      });
      const fullBlob =
        existingFinancialDomain &&
        typeof existingFinancialDomain === "object" &&
        !Array.isArray(existingFinancialDomain)
          ? { [FINANCIAL_DOMAIN]: existingFinancialDomain }
          : ({} as Record<string, unknown>);

      // 2. Get or create the history map
      const historyMap: AnalysisHistoryMap = extractHistoryMap(fullBlob);

      // 3. Get or create the ticker array
      const tickerHistory = historyMap[entry.ticker] || [];
      const incomingRunId = extractRunId(entry);

      if (incomingRunId) {
        const existingIndex = tickerHistory.findIndex(
          (candidate) => extractRunId(candidate) === incomingRunId
        );
        if (existingIndex >= 0) {
          const existing = tickerHistory[existingIndex];
          if (existing) {
            const sameTimestamp = timestampsMatch(existing.timestamp, entry.timestamp);
            const sameDecision = String(existing.decision || "") === String(entry.decision || "");
            const sameConfidence = Number(existing.confidence || 0) === Number(entry.confidence || 0);
            if (sameTimestamp && sameDecision && sameConfidence) {
              // Idempotent no-op for duplicate save attempts.
              return true;
            }
          }
          tickerHistory.splice(existingIndex, 1);
        }
      }

      // 4. Prepend new entry (newest first)
      tickerHistory.unshift(entry);

      // 5. FIFO: remove oldest if exceeds max
      if (tickerHistory.length > MAX_HISTORY_PER_TICKER) {
        tickerHistory.splice(MAX_HISTORY_PER_TICKER);
      }

      // 6. Update the map
      historyMap[entry.ticker] = tickerHistory;
      const summary = buildHistorySummary(historyMap, entry.ticker, entry.timestamp);
      const nowIso = new Date().toISOString();
      const nextFinancialDomain = buildFinancialDomainWithHistory({
        fullBlob,
        historyMap,
        nowIso,
      });

      // 7. Re-encrypt and store merged domain
      const result = await PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
        userId,
        vaultKey,
        domain: FINANCIAL_DOMAIN,
        domainData: nextFinancialDomain,
        summary,
        baseFullBlob: fullBlob,
        cacheFullBlob: false,
        vaultOwnerToken,
      });

      // Invalidate caches after successful save
      if (result.success) {
        CacheSyncService.onAnalysisHistoryStored(userId, historyMap, entry.ticker);
        CacheSyncService.onAnalysisHistoryMutated(userId, entry.ticker, {
          preserveHistoryCache: true,
        });
      }

      return result.success;
    } catch (error) {
      console.error("[KaiHistory] Failed to save analysis:", error);
      return false;
    }
  }

  /**
   * Get analysis history for a specific ticker.
   *
   * @returns Array of AnalysisHistoryEntry (newest first), or empty array.
   */
  static async getTickerHistory(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken?: string;
    ticker: string;
  }): Promise<AnalysisHistoryEntry[]> {
    try {
      const historyMap = await this.getAllHistory(params);
      return historyMap[params.ticker] || [];
    } catch {
      return [];
    }
  }

  /**
   * Get all analysis history across all tickers.
   */
  static async getAllHistory(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken?: string;
  }): Promise<AnalysisHistoryMap> {
    const { userId, vaultKey, vaultOwnerToken } = params;
    const cached = CacheSyncService.getAnalysisHistorySnapshot(userId);
    if (cached) {
      return sanitizeHistoryMap(cached as unknown as Record<string, unknown>);
    }

    try {
      const financialDomain = await PersonalKnowledgeModelService.loadDomainData({
        userId,
        domain: FINANCIAL_DOMAIN,
        vaultKey,
        vaultOwnerToken,
      });
      const historyMap =
        financialDomain &&
        typeof financialDomain === "object" &&
        !Array.isArray(financialDomain)
          ? extractHistoryMapFromFinancialDomain(financialDomain as Record<string, unknown>)
          : {};
      CacheSyncService.onAnalysisHistoryStored(userId, historyMap);
      return historyMap;
    } catch (error) {
      console.error("[KaiHistory] Failed to get history:", error);
      return {};
    }
  }

  /**
   * Delete a specific analysis entry.
   */
  static async deleteEntry(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken?: string;
    ticker: string;
    timestamp: string;
    streamId?: string | null;
  }): Promise<boolean> {
    const { userId, vaultKey, vaultOwnerToken, ticker, timestamp, streamId } = params;

    try {
      // 1. Fetch only the financial domain needed for the delete operation.
      const financialDomain = await PersonalKnowledgeModelService.loadDomainData({
        userId,
        domain: FINANCIAL_DOMAIN,
        vaultKey,
        vaultOwnerToken,
      }).catch(() => ({} as Record<string, unknown>));
      const fullBlob =
        financialDomain && typeof financialDomain === "object" && !Array.isArray(financialDomain)
          ? { [FINANCIAL_DOMAIN]: financialDomain }
          : ({} as Record<string, unknown>);

      // 2. Modify
      const historyMap: AnalysisHistoryMap = extractHistoryMap(fullBlob);
      const tickerKey = normalizeTickerKey(historyMap, ticker);
      if (!tickerKey) return false;

      const wantedTimestamp = String(timestamp || "").trim();
      const wantedStreamId =
        typeof streamId === "string" && streamId.trim().length > 0
          ? streamId.trim()
          : null;

      const currentTickerHistory = historyMap[tickerKey] ?? [];
      if (currentTickerHistory.length === 0) return false;

      const originalLen = currentTickerHistory.length;
      let nextTickerHistory = currentTickerHistory;

      if (wantedTimestamp.length === 0 && wantedStreamId === null) {
        // Fallback: if no stable identifiers are available, remove the newest entry.
        nextTickerHistory = currentTickerHistory.slice(1);
      } else {
        nextTickerHistory = currentTickerHistory.filter((entry) => {
          const byTimestamp =
            wantedTimestamp.length > 0 &&
            timestampsMatch(String(entry.timestamp || ""), wantedTimestamp);
          const byStreamId =
            wantedStreamId !== null && extractStreamId(entry) === wantedStreamId;
          return !(byTimestamp || byStreamId);
        });

        // Last-resort guard for broken historical rows that cannot be matched by timestamp/stream id.
        if (nextTickerHistory.length === originalLen) {
          // No stream_id means we likely came from the latest-row table action.
          // Drop newest entry so users are never stuck with an undeletable row.
          if (wantedStreamId === null) {
            nextTickerHistory = currentTickerHistory.slice(1);
          } else if (originalLen === 1) {
            nextTickerHistory = [];
          }
        }
      }

      historyMap[tickerKey] = nextTickerHistory;

      if (historyMap[tickerKey].length === 0) {
        delete historyMap[tickerKey];
      }

      if (historyMap[tickerKey]?.length === originalLen && historyMap[tickerKey]) {
        return false; // No change
      }

      // 3. Encrypt & Save
      const nowIso = new Date().toISOString();
      const result = await PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
        userId,
        vaultKey,
        domain: FINANCIAL_DOMAIN,
        domainData: buildFinancialDomainWithHistory({
          fullBlob,
          historyMap,
          nowIso,
        }),
        summary: buildHistorySummary(historyMap),
        baseFullBlob: fullBlob,
        cacheFullBlob: false,
        vaultOwnerToken,
      });

      if (result.success) {
        CacheSyncService.onAnalysisHistoryStored(userId, historyMap, tickerKey);
        CacheSyncService.onAnalysisHistoryMutated(userId, tickerKey, {
          preserveHistoryCache: true,
        });
      }

      return result.success;
    } catch (error) {
      console.error("[KaiHistory] Failed to delete entry:", error);
      return false;
    }
  }

  /**
   * Delete all history for a specific ticker.
   */
  static async deleteTickerHistory(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken?: string;
    ticker: string;
  }): Promise<boolean> {
    const { userId, vaultKey, vaultOwnerToken, ticker } = params;

    try {
      // 1. Fetch only the financial domain needed for the delete operation.
      const financialDomain = await PersonalKnowledgeModelService.loadDomainData({
        userId,
        domain: FINANCIAL_DOMAIN,
        vaultKey,
        vaultOwnerToken,
      }).catch(() => ({} as Record<string, unknown>));
      const fullBlob =
        financialDomain && typeof financialDomain === "object" && !Array.isArray(financialDomain)
          ? { [FINANCIAL_DOMAIN]: financialDomain }
          : ({} as Record<string, unknown>);

      // 2. Modify
      const historyMap: AnalysisHistoryMap = extractHistoryMap(fullBlob);
      const tickerKey = normalizeTickerKey(historyMap, ticker);
      if (!tickerKey) return false;

      delete historyMap[tickerKey];
      // 3. Encrypt & Save
      const nowIso = new Date().toISOString();
      const result = await PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
        userId,
        vaultKey,
        domain: FINANCIAL_DOMAIN,
        domainData: buildFinancialDomainWithHistory({
          fullBlob,
          historyMap,
          nowIso,
        }),
        summary: buildHistorySummary(historyMap),
        baseFullBlob: fullBlob,
        cacheFullBlob: false,
        vaultOwnerToken,
      });

      if (result.success) {
        CacheSyncService.onAnalysisHistoryStored(userId, historyMap, tickerKey);
        CacheSyncService.onAnalysisHistoryMutated(userId, tickerKey, {
          preserveHistoryCache: true,
        });
      }

      return result.success;
    } catch (error) {
      console.error("[KaiHistory] Failed to delete ticker history:", error);
      return false;
    }
  }
}

export default KaiHistoryService;
