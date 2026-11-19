/**
 * Kai Analysis History Service
 *
 * Keeps exact saved analyses in encrypted device storage.
 * Reads and supports explicit deletion of legacy PKM analyses.
 */

import { SharedAnalysisReportStore, reportSyncNotConfigured } from "@/lib/kai/shared-report-store";
import { sharedReportHistory, invalidateSharedReports } from "@/lib/kai/shared-report-history";
import { PersonalKnowledgeModelService } from "./personal-knowledge-model-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { currentDomainContractVersion } from "@/lib/personal-knowledge-model/upgrade-contracts";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { compactAnalysisHistoryEntryForStorage, getAnalysisHistoryEntryRouteId, extractRunId, extractStreamId } from "@/lib/kai/analysis-history-record";
export { compactAnalysisHistoryEntryForStorage, getAnalysisHistoryEntryRouteId, findAnalysisHistoryEntryByRouteId } from "@/lib/kai/analysis-history-record";
import { publishPendingFeedResults, getAnalysisByRouteId } from "@/lib/kai/report-history-operations";
import { updateDeviceHistory, DEVICE_HISTORY_KEY, type DeviceHistory, type HistoryOwner } from "@/lib/kai/device-report-history";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { SecureDurableResourceService } from "./secure-durable-resource-service";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";

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
  /** Encrypted with the result; never contains an owner token or report contents. */
  feed_publication_pending?: boolean;
  feed_result_viewed?: boolean;
  shared_report_managed?: boolean;
  shared_report_ref?: { libraryId: string; namespace: string; objectId: string; generation: string };
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
        const routeId = getAnalysisHistoryEntryRouteId(entry);
        if (Object.values(history).some(current => getAnalysisHistoryEntryRouteId(current) === routeId)) return false;
        history[routeId] = { ...entry, ticker };
        return true;
      });
      return params.isCurrent();
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
    const generation = getAuthSessionGeneration();
    const isCurrent = () => isVaultSessionEpochCurrent(epoch) && getAuthSessionGeneration() === generation;
    const [legacy, stored, shared] = await Promise.all([
      this.getLegacyHistory(params).catch(() => ({} as AnalysisHistoryMap)),
      SecureDurableResourceService.read<DeviceHistory>(
        params.userId, DEVICE_HISTORY_KEY, params.vaultKey, isCurrent,
      ).catch(() => null),
      params.vaultOwnerToken ? sharedReportHistory({ ...params, vaultOwnerToken: params.vaultOwnerToken, isCurrent })
        .then(values => ({ status: "ready", values })).catch(error => ({ status: reportSyncNotConfigured(error) ? "not_enabled" : "unavailable", values: [] }))
        : Promise.resolve({ status: "unavailable", values: [] }),
    ]);
    if (stored && params.vaultOwnerToken && isCurrent()) {
      void this.publishPendingFeedResults(params, isCurrent).catch(() => undefined);
    }
    if (!isCurrent()) return {};

    const history = { ...legacy };
    const deleted = new Set(shared.values.filter(value => value.state === "deleted").map(value => `run:${value.runId}`));
    for (const entry of [...Object.values(stored?.value ?? {}).filter(entry => shared.status === "ready" || (shared.status === "not_enabled" && !entry.shared_report_ref && !entry.shared_report_managed)),
      ...shared.values.flatMap(value => value.state === "available" ? [value.record] : [])]) {
      const ticker = sanitizeTicker(entry.ticker);
      if (!ticker) continue;
      const routeId = getAnalysisHistoryEntryRouteId(entry);
      history[ticker] = [
        entry,
        ...(history[ticker] ?? []).filter(candidate => getAnalysisHistoryEntryRouteId(candidate) !== routeId),
      ];
    }
    for (const [ticker, entries] of Object.entries(history)) history[ticker] = entries.filter(entry => !deleted.has(getAnalysisHistoryEntryRouteId(entry)) && (shared.status !== "unavailable" || !getAnalysisHistoryEntryRouteId(entry).startsWith("run:")));
    for (const entries of Object.values(history)) entries.sort((a, b) => (toEpochMs(b.timestamp) ?? 0) - (toEpochMs(a.timestamp) ?? 0));
    return history;
  }

  static publishPendingFeedResults(params: HistoryOwner, isCurrent: () => boolean): Promise<void> {
    return publishPendingFeedResults(params, isCurrent);
  }

  static getAnalysisByRouteId(params: HistoryOwner, routeId: string): Promise<AnalysisHistoryEntry | null> {
    return getAnalysisByRouteId(params, routeId, owner => this.getLegacyHistory(owner));
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
    const generation = getAuthSessionGeneration();
    const isCurrent = () => isVaultSessionEpochCurrent(epoch) && getAuthSessionGeneration() === generation;
    let removedShared = false;
    if (streamId && vaultOwnerToken) {
      try {
        const shared = await SharedAnalysisReportStore.open({ userId, vaultKey, vaultOwnerToken, isCurrent });
        const { ApiService } = await import("./api-service");
        await shared.remove(streamId, receipt => ApiService.removeSavedKaiAnalysis({
          runId: streamId, receipt, userId, vaultOwnerToken, isEffectCurrent: isCurrent,
        }));
        removedShared = true;
        invalidateSharedReports();
      } catch (error) {
        if (!(error instanceof Error) || !["FILES_SETUP_REQUIRED", "REPORT_SYNC_SETUP_REQUIRED"].includes(error.message)) return false;
      }
    }
    try {
      const removedFromDevice = await updateDeviceHistory(params, isCurrent, (history) => {
        let removed = false;
        for (const [key, entry] of Object.entries(history)) {
          if (sanitizeTicker(entry.ticker) !== sanitizeTicker(ticker)) continue;
          const matches = streamId
            ? extractStreamId(entry) === streamId || extractRunId(entry) === streamId
            : toEpochMs(entry.timestamp) === toEpochMs(timestamp) && toEpochMs(timestamp) !== null;
          if (matches) { delete history[key]; removed = true; }
        }
        return removed;
      });
      if (removedFromDevice || removedShared) return true;
    } catch {
      return false;
    }
    if (!isCurrent()) return false;

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

}

export default KaiHistoryService;
