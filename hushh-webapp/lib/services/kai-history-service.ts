/**
 * Kai Analysis History Service
 *
 * Keeps the latest analysis per ticker in encrypted device storage.
 * Reads and supports explicit deletion of legacy PKM analyses.
 */

import { PersonalKnowledgeModelService } from "./personal-knowledge-model-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { currentDomainContractVersion } from "@/lib/personal-knowledge-model/upgrade-contracts";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { getAnalysisHistoryRunRouteId } from "@/lib/kai/analysis-route-intent";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { SecureDurableResourceService } from "./secure-durable-resource-service";

const DEVICE_HISTORY_KEY = "finance-analysis-history-v1";
const FINANCIAL_DOMAIN = "financial";
const FINANCIAL_SCHEMA_VERSION = 3;
const FINANCIAL_CONTRACT_VERSION =
  currentDomainContractVersion(FINANCIAL_DOMAIN);
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

type HistoryOwner = { userId: string; vaultKey: string; vaultOwnerToken?: string };
type DeviceHistory = Record<string, AnalysisHistoryEntry>;

async function updateDeviceHistory(
  { userId, vaultKey }: HistoryOwner,
  isCurrent: () => boolean,
  update: (history: DeviceHistory) => boolean,
): Promise<boolean> {
  const expected = await SecureDurableResourceService.version(userId, DEVICE_HISTORY_KEY);
  const stored = await SecureDurableResourceService.read<DeviceHistory>(userId, DEVICE_HISTORY_KEY, vaultKey, isCurrent);
  const history = stored?.value ?? {};
  if (!isCurrent()) throw new Error("Analysis history access changed.");
  if (!update(history)) return false;
  await SecureDurableResourceService.write({
    userId, vaultKey, resourceKey: DEVICE_HISTORY_KEY, expected, value: history, isCurrent,
  });
  return true;
}

function compactTranscriptRound(
  round: Record<string, any>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(round || {}).map(([agent, rawState]) => {
      const state =
        rawState && typeof rawState === "object" && !Array.isArray(rawState)
          ? (rawState as Record<string, unknown>)
          : {};
      return [
        agent,
        {
          stage: typeof state.stage === "string" ? state.stage : "complete",
          text: typeof state.text === "string" ? state.text : "",
          thoughts: Array.isArray(state.thoughts)
            ? state.thoughts.map((value) => String(value))
            : [],
          ...(typeof state.statusMessage === "string"
            ? { statusMessage: state.statusMessage }
            : {}),
          ...(typeof state.error === "string" ? { error: state.error } : {}),
        },
      ];
    }),
  );
}

/**
 * Persist the decision card once and keep only the text needed to replay each
 * analyst turn. Rich metrics already live in `raw_card`; copying them into
 * every transcript agent doubled the encrypted financial blob and made each
 * later history append progressively slower.
 */
export function compactAnalysisHistoryEntryForStorage(
  entry: AnalysisHistoryEntry,
): AnalysisHistoryEntry {
  if (!entry.debate_transcript) return entry;
  return {
    ...entry,
    debate_transcript: {
      round1: compactTranscriptRound(entry.debate_transcript.round1),
      round2: compactTranscriptRound(entry.debate_transcript.round2),
    },
  };
}

/**
 * Stable, URL-safe identity for a stored analysis. Runs use their persisted
 * run id; older records retain a deterministic ticker-and-timestamp fallback.
 */
export function getAnalysisHistoryEntryRouteId(
  entry: AnalysisHistoryEntry,
): string {
  const runId = extractRunId(entry);
  if (runId) return getAnalysisHistoryRunRouteId(runId);
  return `saved:${entry.ticker.toUpperCase()}:${entry.timestamp}`;
}

export function findAnalysisHistoryEntryByRouteId(
  historyMap: AnalysisHistoryMap,
  routeId: string,
): AnalysisHistoryEntry | null {
  const wanted = String(routeId || "").trim();
  if (!wanted) return null;
  return (
    Object.values(historyMap)
      .flat()
      .find((entry) => getAnalysisHistoryEntryRouteId(entry) === wanted) ?? null
  );
}

function sanitizeTicker(value: unknown): string {
  const ticker = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!ticker || ticker === "UNDEFINED" || ticker === "NULL") return "";
  return ticker;
}

function sanitizeHistoryMap(
  rawMap: Record<string, unknown>,
): AnalysisHistoryMap {
  const sanitized: AnalysisHistoryMap = {};

  for (const [rawKey, maybeEntries] of Object.entries(rawMap)) {
    if (!Array.isArray(maybeEntries)) continue;

    const keyTicker = sanitizeTicker(rawKey);
    const entries = maybeEntries
      .filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
      .map((entry) => {
        const ticker = sanitizeTicker(entry.ticker) || keyTicker;
        if (!ticker) return null;

        const rawTimestamp =
          typeof entry.timestamp === "string" ? entry.timestamp.trim() : "";
        const timestamp =
          rawTimestamp.length > 0 ? rawTimestamp : new Date(0).toISOString();
        const decision =
          typeof entry.decision === "string" && entry.decision.trim().length > 0
            ? entry.decision.trim()
            : "hold";
        const confidenceRaw =
          typeof entry.confidence === "number"
            ? entry.confidence
            : Number(entry.confidence);
        const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : 0;

        const normalized: AnalysisHistoryEntry = {
          ticker,
          timestamp,
          decision,
          confidence,
          consensus_reached: Boolean(entry.consensus_reached),
          agent_votes:
            entry.agent_votes &&
            typeof entry.agent_votes === "object" &&
            !Array.isArray(entry.agent_votes)
              ? (entry.agent_votes as Record<string, string>)
              : {},
          final_statement:
            typeof entry.final_statement === "string"
              ? entry.final_statement
              : "",
          raw_card:
            entry.raw_card &&
            typeof entry.raw_card === "object" &&
            !Array.isArray(entry.raw_card)
              ? (entry.raw_card as Record<string, unknown>)
              : {},
        };

        if (
          entry.debate_transcript &&
          typeof entry.debate_transcript === "object" &&
          !Array.isArray(entry.debate_transcript)
        ) {
          normalized.debate_transcript =
            entry.debate_transcript as AnalysisHistoryEntry["debate_transcript"];
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
  ticker: string,
): string | null {
  const wanted = String(ticker || "")
    .trim()
    .toUpperCase();
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

function timestampsMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
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

function buildHistorySummary(historyMap: AnalysisHistoryMap): Record<string, unknown> {
  const tickers = Object.keys(historyMap);
  const totalAnalyses = Object.values(historyMap).reduce(
    (sum, arr) => sum + arr.length,
    0,
  );

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

  return summary;
}

function flattenHistoryEntries(
  historyMap: AnalysisHistoryMap,
): AnalysisHistoryEntry[] {
  return Object.values(historyMap)
    .flatMap((entries) => entries)
    .sort((left, right) => {
      const leftEpoch = toEpochMs(left.timestamp) ?? 0;
      const rightEpoch = toEpochMs(right.timestamp) ?? 0;
      return rightEpoch - leftEpoch;
    });
}

function buildDecisionProjection(
  historyMap: AnalysisHistoryMap,
): Array<Record<string, unknown>> {
  return flattenHistoryEntries(historyMap).map((entry, index) => ({
    id: index + 1,
    ticker: entry.ticker,
    decision_type: String(entry.decision || "").toUpperCase(),
    confidence: Number(entry.confidence || 0),
    created_at: entry.timestamp,
    metadata: {
      consensus_reached: entry.consensus_reached,
      source: "analysis_history",
    },
  }));
}

function buildDecisionWriteProjections(historyMap: AnalysisHistoryMap) {
  return [
    {
      projectionType: "decision_history_v1",
      projectionVersion: 1,
      payload: {
        decisions: buildDecisionProjection(historyMap),
      },
    },
  ] as const;
}

function selectFinancialDomain(
  fullBlob: Record<string, unknown>,
): Record<string, unknown> {
  const raw = fullBlob[FINANCIAL_DOMAIN];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return { ...(raw as Record<string, unknown>) };
}

function extractHistoryMap(
  fullBlob: Record<string, unknown>,
): AnalysisHistoryMap {
  const financialRaw = fullBlob[FINANCIAL_DOMAIN];
  if (
    financialRaw &&
    typeof financialRaw === "object" &&
    !Array.isArray(financialRaw)
  ) {
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

function extractHistoryMapFromFinancialDomain(
  financialDomain: Record<string, unknown>,
): AnalysisHistoryMap {
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
    existingAnalysisRaw &&
    typeof existingAnalysisRaw === "object" &&
    !Array.isArray(existingAnalysisRaw)
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
  static async saveAnalysis(params: HistoryOwner & {
    entry: AnalysisHistoryEntry;
    isCurrent: () => boolean;
  }): Promise<boolean> {
    const entry = compactAnalysisHistoryEntryForStorage(params.entry);
    const ticker = sanitizeTicker(entry.ticker);
    if (!ticker) return false;

    try {
      await updateDeviceHistory(params, params.isCurrent, (history) => {
        const current = history[ticker];
        if (current && (
          getAnalysisHistoryEntryRouteId(current) === getAnalysisHistoryEntryRouteId(entry) ||
          (toEpochMs(current.timestamp) ?? 0) > (toEpochMs(entry.timestamp) ?? 0)
        )) return false;
        history[ticker] = { ...entry, ticker };
        return true;
      });
      return true;
    } catch {
      // The run manager owns retries and the user-facing recovery state.
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
  static async getAllHistory(params: HistoryOwner): Promise<AnalysisHistoryMap> {
    const epoch = snapshotVaultSessionEpoch();
    const isCurrent = () => isVaultSessionEpochCurrent(epoch);
    const [legacy, stored] = await Promise.all([
      this.getLegacyHistory(params).catch(() => ({} as AnalysisHistoryMap)),
      SecureDurableResourceService.read<DeviceHistory>(
        params.userId, DEVICE_HISTORY_KEY, params.vaultKey, isCurrent,
      ).catch(() => null),
    ]);
    if (!isCurrent()) return {};

    const history = { ...legacy };
    for (const [ticker, entry] of Object.entries(stored?.value ?? {})) {
      const routeId = getAnalysisHistoryEntryRouteId(entry);
      history[ticker] = [
        entry,
        ...(history[ticker] ?? []).filter(candidate => getAnalysisHistoryEntryRouteId(candidate) !== routeId),
      ];
    }
    return history;
  }

  private static async getLegacyHistory(params: HistoryOwner): Promise<AnalysisHistoryMap> {
    const { userId, vaultKey, vaultOwnerToken } = params;
    const epoch = snapshotVaultSessionEpoch();
    const cached = CacheSyncService.getAnalysisHistorySnapshot(userId);
    if (cached) {
      return sanitizeHistoryMap(cached as unknown as Record<string, unknown>);
    }

    const financialDomain = await PersonalKnowledgeModelService.loadDomainData({
      userId, domain: FINANCIAL_DOMAIN, vaultKey, vaultOwnerToken,
    });
    if (!isVaultSessionEpochCurrent(epoch)) return {};
    const historyMap =
      financialDomain && typeof financialDomain === "object" && !Array.isArray(financialDomain)
        ? extractHistoryMapFromFinancialDomain(financialDomain as Record<string, unknown>)
        : {};
    CacheSyncService.onAnalysisHistoryStored(userId, historyMap);
    return historyMap;
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
    const { userId, vaultKey, vaultOwnerToken, ticker, timestamp, streamId } =
      params;

    const epoch = snapshotVaultSessionEpoch();
    try {
      const removedFromDevice = await updateDeviceHistory(params, () => isVaultSessionEpochCurrent(epoch), (history) => {
        const key = sanitizeTicker(ticker);
        const entry = history[key];
        if (!entry) return false;
        const matches = streamId
          ? extractStreamId(entry) === streamId || extractRunId(entry) === streamId
          : toEpochMs(entry.timestamp) === toEpochMs(timestamp) && toEpochMs(timestamp) !== null;
        if (!matches) return false;
        delete history[key];
        return true;
      });
      if (removedFromDevice) return true;
    } catch {
      return false;
    }
    if (!isVaultSessionEpochCurrent(epoch)) return false;

    try {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId,
        vaultKey,
        vaultOwnerToken,
        domain: FINANCIAL_DOMAIN,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "kai_history_delete_entry_button",
        },
        build: async ({ currentDomainData, baseFullBlob }) => {
          const fullBlob =
            baseFullBlob && Object.keys(baseFullBlob).length > 0
              ? baseFullBlob
              : currentDomainData && Object.keys(currentDomainData).length > 0
                ? { [FINANCIAL_DOMAIN]: currentDomainData }
                : ({} as Record<string, unknown>);

          const historyMap: AnalysisHistoryMap = extractHistoryMap(fullBlob);
          const tickerKey = normalizeTickerKey(historyMap, ticker);
          if (!tickerKey) {
            throw new Error("KAI_HISTORY_NOT_FOUND");
          }

          const wantedTimestamp = String(timestamp || "").trim();
          const wantedStreamId =
            typeof streamId === "string" && streamId.trim().length > 0
              ? streamId.trim()
              : null;

          const currentTickerHistory = historyMap[tickerKey] ?? [];
          if (currentTickerHistory.length === 0) {
            throw new Error("KAI_HISTORY_NOT_FOUND");
          }

          const originalLen = currentTickerHistory.length;
          const nextTickerHistory = currentTickerHistory.filter((entry) =>
            wantedStreamId !== null
              ? extractStreamId(entry) !== wantedStreamId && extractRunId(entry) !== wantedStreamId
              : !timestampsMatch(entry.timestamp, wantedTimestamp),
          );

          historyMap[tickerKey] = nextTickerHistory;
          if (historyMap[tickerKey].length === 0) {
            delete historyMap[tickerKey];
          }
          if (
            historyMap[tickerKey]?.length === originalLen &&
            historyMap[tickerKey]
          ) {
            throw new Error("KAI_HISTORY_NOT_FOUND");
          }

          const nowIso = new Date().toISOString();
          return {
            domainData: buildFinancialDomainWithHistory({
              fullBlob,
              historyMap,
              nowIso,
            }),
            summary: buildHistorySummary(historyMap),
            writeProjections: [...buildDecisionWriteProjections(historyMap)],
          };
        },
      });

      if (result.success) {
        const nextMap = extractHistoryMap(result.fullBlob);
        const resolvedTickerKey = normalizeTickerKey(nextMap, ticker) || ticker;
        CacheSyncService.onAnalysisHistoryStored(
          userId,
          nextMap,
          resolvedTickerKey,
        );
        CacheSyncService.onAnalysisHistoryMutated(userId, resolvedTickerKey, {
          preserveHistoryCache: true,
        });
      }

      return result.success;
    } catch (error) {
      if (error instanceof Error && error.message === "KAI_HISTORY_NOT_FOUND") {
        return false;
      }
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

    const epoch = snapshotVaultSessionEpoch();
    try {
      const legacyTicker = normalizeTickerKey(await this.getLegacyHistory(params), ticker);
      const removedFromDevice = await updateDeviceHistory(params, () => isVaultSessionEpochCurrent(epoch), (history) => {
        const key = sanitizeTicker(ticker);
        if (!Object.hasOwn(history, key)) return false;
        delete history[key];
        return true;
      });
      if (!legacyTicker) return removedFromDevice;
    } catch {
      return false;
    }
    if (!isVaultSessionEpochCurrent(epoch)) return false;

    try {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId,
        vaultKey,
        vaultOwnerToken,
        domain: FINANCIAL_DOMAIN,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "kai_history_delete_ticker_button",
        },
        build: async ({ currentDomainData, baseFullBlob }) => {
          const fullBlob =
            baseFullBlob && Object.keys(baseFullBlob).length > 0
              ? baseFullBlob
              : currentDomainData && Object.keys(currentDomainData).length > 0
                ? { [FINANCIAL_DOMAIN]: currentDomainData }
                : ({} as Record<string, unknown>);

          const historyMap: AnalysisHistoryMap = extractHistoryMap(fullBlob);
          const tickerKey = normalizeTickerKey(historyMap, ticker);
          if (!tickerKey) {
            throw new Error("KAI_HISTORY_NOT_FOUND");
          }

          delete historyMap[tickerKey];
          const nowIso = new Date().toISOString();
          return {
            domainData: buildFinancialDomainWithHistory({
              fullBlob,
              historyMap,
              nowIso,
            }),
            summary: buildHistorySummary(historyMap),
            writeProjections: [...buildDecisionWriteProjections(historyMap)],
          };
        },
      });

      if (result.success) {
        const nextMap = extractHistoryMap(result.fullBlob);
        CacheSyncService.onAnalysisHistoryStored(userId, nextMap);
        CacheSyncService.onAnalysisHistoryMutated(userId, ticker, {
          preserveHistoryCache: true,
        });
      }

      return result.success;
    } catch (error) {
      if (error instanceof Error && error.message === "KAI_HISTORY_NOT_FOUND") {
        return false;
      }
      console.error("[KaiHistory] Failed to delete ticker history:", error);
      return false;
    }
  }
}

export default KaiHistoryService;
