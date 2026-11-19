import type { AnalysisHistoryEntry, AnalysisHistoryMap } from "@/lib/services/kai-history-service";
import { getAnalysisHistoryEntryRouteId, findAnalysisHistoryEntryByRouteId } from "./analysis-history-record";
import { updateDeviceHistory, DEVICE_HISTORY_KEY, type DeviceHistory, type HistoryOwner } from "./device-report-history";
import { SharedAnalysisReportStore, reportSyncNotConfigured } from "./shared-report-store";
import { invalidateSharedReports } from "./shared-report-history";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { SecureDurableResourceService, subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";

  /** Retry only saved, owner-encrypted results; keep failures pending for the next unlock. */
export async function publishPendingFeedResults(params: HistoryOwner, isCurrent: () => boolean): Promise<void> {
    let ownerReset = false;
    const generation = getAuthSessionGeneration();
    const current = () => !ownerReset && isCurrent() && getAuthSessionGeneration() === generation;
    const unsubscribe = subscribeDurableOwnerReset(owner => { if (owner === params.userId) ownerReset = true; });
    try {
      if (!params.vaultOwnerToken || !current()) return;
      const stored = await SecureDurableResourceService.read<DeviceHistory>(
        params.userId, DEVICE_HISTORY_KEY, params.vaultKey, current,
      );
      if (!stored || !current()) return;
      const { ApiService } = await import("@/lib/services/api-service");
      const shared = await SharedAnalysisReportStore.open({ ...params, vaultOwnerToken: params.vaultOwnerToken, isCurrent: current });
      for (const [storageKey, entry] of Object.entries(stored.value)) {
        if ((!entry.feed_publication_pending && entry.shared_report_ref) || !current()) continue;
        const routeId = getAnalysisHistoryEntryRouteId(entry);
        if (!routeId.startsWith("run:")) continue;
        try {
          await updateDeviceHistory(params, current, history => {
            const saved = history[storageKey];
            if (!saved) throw new Error("REPORT_REMOVED");
            if (saved.shared_report_managed) return false;
            history[storageKey] = { ...saved, shared_report_managed: true }; return true;
          });
          const receipt = await shared.save(routeId.slice(4), entry, entry.feed_publication_pending ? async receipt => {
            const response = await ApiService.publishSavedKaiAnalysis({
              runId: routeId.slice(4), receipt, completionProof: entry.raw_card.completion_proof, reportTicker: entry.ticker, viewedInFinance: entry.feed_result_viewed === true, userId: params.userId,
              vaultOwnerToken: params.vaultOwnerToken!, isEffectCurrent: current,
            });
            if (!response.ok) throw new Error("Analysis notification could not be saved.");
          } : undefined);
          if (!current()) return;
          await updateDeviceHistory(params, current, history => {
            const current = history[storageKey];
            if (!current) return false;
            const { feed_publication_pending: _pending, ...confirmed } = current;
            const { leaseId: _lease, ...shared_report_ref } = receipt;
            history[storageKey] = { ...confirmed, shared_report_ref };
            return true;
          });
        } catch (error) {
          if (error instanceof Error && error.message === "REPORT_REMOVED") {
            await updateDeviceHistory(params, current, history => { delete history[storageKey]; return true; });
          }
          // Atomic saved marker survives network, server, CAS, lock and reset failures.
        }
      }
    } finally { invalidateSharedReports(); unsubscribe(); }
  }

export async function getAnalysisByRouteId(params: HistoryOwner, routeId: string, loadLegacy: (owner: HistoryOwner) => Promise<AnalysisHistoryMap>): Promise<AnalysisHistoryEntry | null> {
    const epoch = snapshotVaultSessionEpoch();
    const generation = getAuthSessionGeneration();
    const isCurrent = () => isVaultSessionEpochCurrent(epoch) && getAuthSessionGeneration() === generation;
    const stored = await SecureDurableResourceService.read<DeviceHistory>(params.userId, DEVICE_HISTORY_KEY, params.vaultKey, isCurrent).catch(() => null);
    const markViewed = (entry: AnalysisHistoryEntry) => {
      if (!routeId.startsWith("run:") || !isCurrent()) return;
      void updateDeviceHistory(params, isCurrent, history => {
        const match = Object.entries(history).find(([, entry]) => getAnalysisHistoryEntryRouteId(entry) === routeId);
        if (!match || match[1].feed_result_viewed) return false;
        history[match[0]] = { ...match[1], feed_result_viewed: true }; return true;
      }).catch(() => undefined);
      if (params.vaultOwnerToken) void import("@/lib/services/api-service").then(({ ApiService }) =>
        ApiService.markSavedKaiAnalysisRead({ runId: routeId.slice(4), completionProof: entry.raw_card.completion_proof, userId: params.userId,
          vaultOwnerToken: params.vaultOwnerToken!, isEffectCurrent: isCurrent })).catch(() => undefined);
    };
    const local = Object.values(stored?.value ?? {}).find(entry => getAnalysisHistoryEntryRouteId(entry) === routeId);
    if (routeId.startsWith("run:") && params.vaultOwnerToken) {
      try {
        const shared = await SharedAnalysisReportStore.open({ ...params, vaultOwnerToken: params.vaultOwnerToken, isCurrent });
        const report = await shared.get(routeId.slice(4));
        if (!isCurrent()) return null;
        if (report?.state === "deleted") return null;
        if (report?.state === "available") { markViewed(report.record); return report.record; }
      } catch (error) {
        if (!reportSyncNotConfigured(error) || !local || local.shared_report_ref || local.shared_report_managed) throw error;
      }
    }
    if (routeId.startsWith("run:") && !params.vaultOwnerToken) throw new Error("Unlock your vault to check this report.");
    if (local && !local.shared_report_ref && !local.shared_report_managed && isCurrent()) { markViewed(local); return local; }
    return findAnalysisHistoryEntryByRouteId(await loadLegacy(params), routeId);
  }

