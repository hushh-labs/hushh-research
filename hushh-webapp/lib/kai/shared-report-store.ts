import { SharedFilesStore, type SharedObjectReceipt } from "@/lib/files/shared/store";
import { ApiService } from "@/lib/services/api-service";
import type { AnalysisHistoryEntry } from "@/lib/services/kai-history-service";
import { reportJson, sharedReport, verifiedReport, SHARED_REPORT_GROUP, SHARED_REPORT_SETTINGS, type SharedReport } from "./shared-report-contract";

export function reportSyncNotConfigured(error: unknown): boolean {
  return error instanceof Error && ["FILES_SETUP_REQUIRED", "REPORT_SYNC_SETUP_REQUIRED"].includes(error.message);
}

export type ReportAccess = { userId: string; vaultKey: string; vaultOwnerToken: string; isCurrent: () => boolean };

export class SharedAnalysisReportStore {
  constructor(private readonly files: SharedFilesStore) {}

  static async open(access: ReportAccess, setup = false): Promise<SharedAnalysisReportStore> {
    const check = () => { if (!access.isCurrent()) throw new DOMException("Report access changed", "AbortError"); };
    check();
    const status = await ApiService.getPersonalAgentStatus();
    check();
    if (status.hostingMode !== "shared") throw new Error("Report sync requires Shared storage.");
    const files = new SharedFilesStore({ owner: access.userId, vaultKey: access.vaultKey,
      ownerToken: access.vaultOwnerToken, check }, { bootstrap: setup ? "create" : "existing" });
    const store = new SharedAnalysisReportStore(files);
    if (setup) { await ApiService.verifyKaiReportStorage({ vaultOwnerToken: access.vaultOwnerToken, isEffectCurrent: access.isCurrent }); check(); await store.enable(); }
    else {
      const settings = await files.read<{ schema: string; enabled: boolean }>(SHARED_REPORT_SETTINGS, "sync");
      if (settings.value === null) throw new Error("REPORT_SYNC_SETUP_REQUIRED");
      if (settings.value?.schema !== "kai-analysis-report-settings.v1" || settings.value.enabled !== true || Object.keys(settings.value).sort().join() !== "enabled,schema") throw new Error("REPORT_SETTINGS_INVALID");
    }
    check();
    return store;
  }

  private async enable(): Promise<void> {
    await this.files.activate();
    await this.files.serialize(async () => {
      const current = await this.files.read(SHARED_REPORT_SETTINGS, "sync");
      const settings = { schema: "kai-analysis-report-settings.v1", enabled: true };
      await this.files.writeHeld(SHARED_REPORT_SETTINGS, "sync", settings, current.generation);
      const stored = await this.files.read(SHARED_REPORT_SETTINGS, "sync");
      if (reportJson(stored.value) !== reportJson(settings)) throw new Error("Report sync setup could not be confirmed.");
    });
  }

  async get(runId: string): Promise<SharedReport | null> {
    const stored = await this.files.read(SHARED_REPORT_GROUP, runId);
    return stored.value === null ? null : verifiedReport(stored.value, runId);
  }

  async page(cursor = ""): Promise<{ values: SharedReport[]; cursor: string }> {
    const page = await this.files.page(SHARED_REPORT_GROUP, cursor);
    return { values: page.values.map(value => verifiedReport(value)), cursor: page.cursor };
  }

  async save(runId: string, entry: AnalysisHistoryEntry, publish?: (receipt: SharedObjectReceipt) => Promise<void>): Promise<SharedObjectReceipt> {
    const expected = sharedReport(runId, entry);
    return this.files.serialize(async () => {
      const current = await this.files.read(SHARED_REPORT_GROUP, runId);
      if (current.value !== null) {
        const value = verifiedReport(current.value, runId);
        if (value.state === "deleted") throw new Error("REPORT_REMOVED");
        if (reportJson(value) !== reportJson(expected)) throw new Error("The saved report differs from this run.");
      } else await this.files.writeHeld(SHARED_REPORT_GROUP, runId, expected, current.generation);
      const readback = await this.files.read(SHARED_REPORT_GROUP, runId);
      if (reportJson(verifiedReport(readback.value, runId)) !== reportJson(expected)) throw new Error("Report sync could not be confirmed.");
      const receipt = await this.files.verifiedObject(SHARED_REPORT_GROUP, runId, readback.generation);
      if (publish) await publish(receipt);
      return receipt;
    });
  }

  async remove(runId: string, removeFeed?: (receipt: SharedObjectReceipt) => Promise<void>): Promise<void> {
    await this.files.serialize(async () => {
      const current = await this.files.read(SHARED_REPORT_GROUP, runId);
      const previous = current.value === null ? null : verifiedReport(current.value, runId);
      const tombstone: SharedReport = previous?.state === "deleted" ? previous :
        { schema: "kai-analysis-report.v1", state: "deleted", runId, deletedAt: new Date().toISOString() };
      if (previous?.state !== "deleted") await this.files.writeHeld(SHARED_REPORT_GROUP, runId, tombstone, current.generation);
      const readback = await this.files.read(SHARED_REPORT_GROUP, runId);
      if (reportJson(verifiedReport(readback.value, runId)) !== reportJson(tombstone)) throw new Error("Report removal could not be confirmed.");
      if (removeFeed) await removeFeed(await this.files.verifiedObject(SHARED_REPORT_GROUP, runId, readback.generation));
    });
  }
}
