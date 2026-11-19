import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { invalidateSharedReports } from "@/lib/kai/shared-report-history";
import { SecureDurableResourceService } from "@/lib/services/secure-durable-resource-service";

import {
  compactAnalysisHistoryEntryForStorage,
  findAnalysisHistoryEntryByRouteId,
  getAnalysisHistoryEntryRouteId,
  KaiHistoryService,
  type AnalysisHistoryEntry,
} from "@/lib/services/kai-history-service";

const pkm = vi.hoisted(() => ({ load: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadDomainData: pkm.load },
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: pkm.write },
}));

const cloud = vi.hoisted(() => ({
  enabled: false,
  reports: new Map<string, any>(),
  open: vi.fn(),
  save: vi.fn(async (_run: string, _entry: unknown, announce?: (receipt: unknown) => Promise<void>) => {
    if (cloud.reports.get(_run)?.state === "deleted") throw new Error("REPORT_REMOVED");
    const { feed_publication_pending: _pending, feed_result_viewed: _viewed, shared_report_ref: _ref, shared_report_managed: _managed, ...record } = _entry as Record<string, unknown>;
    cloud.reports.set(_run, { schema: "kai-analysis-report.v1", state: "available", runId: _run, record });
    const receipt = { libraryId: "library", namespace: "opaque", objectId: "object", generation: "1", leaseId: "lease" };
    await announce?.(receipt);
    return receipt;
  }),
}));
vi.mock("@/lib/kai/shared-report-store", () => ({
  SharedAnalysisReportStore: { open: cloud.open },
  reportSyncNotConfigured: (error: unknown) => error instanceof Error && ["FILES_SETUP_REQUIRED", "REPORT_SYNC_SETUP_REQUIRED"].includes(error.message),
}));
cloud.open.mockImplementation(async () => {
  if (!cloud.enabled) throw new Error("REPORT_SYNC_SETUP_REQUIRED");
  return { save: cloud.save, page: async () => ({ values: [...cloud.reports.values()], cursor: "" }),
    get: async (id: string) => cloud.reports.get(id) ?? null };
});

const publish = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({ ApiService: { publishSavedKaiAnalysis: publish, markSavedKaiAnalysisRead: vi.fn(async () => undefined) } }));

function entry(
  overrides: Partial<AnalysisHistoryEntry> = {},
): AnalysisHistoryEntry {
  return {
    ticker: "NVDA",
    timestamp: "2026-08-10T12:00:00.000Z",
    decision: "hold",
    confidence: 0.7,
    consensus_reached: true,
    agent_votes: {},
    final_statement: "Hold.",
    raw_card: {},
    ...overrides,
  };
}

describe("analysis history route identity", () => {
  it("prefers the persisted debate run id over stream diagnostics", () => {
    expect(
      getAnalysisHistoryEntryRouteId(
        entry({
          raw_card: {
            debate_run_id: "debate_123",
            stream_diagnostics: { stream_id: "stream_456" },
          },
        }),
      ),
    ).toBe("run:debate_123");
  });

  it("uses stream diagnostics, then a deterministic legacy identity", () => {
    expect(
      getAnalysisHistoryEntryRouteId(
        entry({
          raw_card: { stream_diagnostics: { stream_id: "stream_456" } },
        }),
      ),
    ).toBe("run:stream_456");
    expect(getAnalysisHistoryEntryRouteId(entry())).toBe(
      "saved:NVDA:2026-08-10T12:00:00.000Z",
    );
  });

  it("finds a saved entry after a query-backed route reload", () => {
    const saved = entry();
    const history = { NVDA: [saved] };

    expect(
      findAnalysisHistoryEntryByRouteId(
        history,
        "saved:NVDA:2026-08-10T12:00:00.000Z",
      ),
    ).toBe(saved);
  });
});

it("reads legacy PKM history and keeps exact new runs on this device without writing to PKM", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("crypto", webcrypto);
  // Web Crypto in Node expects buffer sources from its own realm.
  const bytes = new TextEncoder().encode("");
  vi.stubGlobal("Uint8Array", bytes.constructor);
  vi.stubGlobal("ArrayBuffer", bytes.buffer.constructor);
  try {
    const owner = { userId: "finance-history-owner", vaultKey: "ab".repeat(32), vaultOwnerToken: "memory-only-token" };
    const legacy = entry({ ticker: "MSFT", raw_card: { debate_run_id: "legacy" } });
    pkm.load.mockResolvedValue({ analysis_history: { MSFT: [legacy] } });
    const earlier = entry({ raw_card: { debate_run_id: "earlier" } });
    const latest = entry({ timestamp: "2026-08-11T12:00:00.000Z", raw_card: { debate_run_id: "latest" } });
    const deviceLegacy = entry({ ticker: "IBM", raw_card: { debate_run_id: "device-legacy" } });
    const resourceKey = "finance-analysis-history-v1";
    await SecureDurableResourceService.write({ ...owner, resourceKey,
      expected: await SecureDurableResourceService.version(owner.userId, resourceKey),
      value: { IBM: deviceLegacy }, isCurrent: () => true });
    const save = (result: AnalysisHistoryEntry) => KaiHistoryService.saveAnalysis({ ...owner, entry: result, isCurrent: () => true });

    await expect(save(latest)).resolves.toBe(true);
    await expect(save(earlier)).resolves.toBe(true);
    await expect(save(earlier)).resolves.toBe(true);
    await expect(KaiHistoryService.getAllHistory(owner)).resolves.toEqual({ MSFT: [legacy], IBM: [deviceLegacy], NVDA: [latest, earlier] });
    await expect(KaiHistoryService.getAllHistory({ ...owner, vaultKey: "bc".repeat(32) })).resolves.toEqual({ MSFT: [legacy] });
    await expect(KaiHistoryService.deleteEntry({ ...owner, ticker: "NVDA", timestamp: latest.timestamp, streamId: "latest" })).resolves.toBe(true);
    const history = await KaiHistoryService.getAllHistory(owner);
    expect(history).toEqual({ MSFT: [legacy], IBM: [deviceLegacy], NVDA: [earlier] });
    expect(findAnalysisHistoryEntryByRouteId(history, "run:earlier")).toEqual(earlier);
    expect(findAnalysisHistoryEntryByRouteId(history, "run:latest")).toBeNull();
    const pending = entry({ raw_card: { debate_run_id: "pending" }, feed_publication_pending: true });
    await expect(save(pending)).resolves.toBe(true);
    cloud.enabled = true;
    publish.mockRejectedValueOnce(new Error("offline"));
    await KaiHistoryService.publishPendingFeedResults({ ...owner, vaultOwnerToken: "memory-only-token" }, () => true);
    const waiting = await SecureDurableResourceService.read<Record<string, AnalysisHistoryEntry>>(owner.userId, resourceKey, owner.vaultKey, () => true);
    expect(waiting?.value["run:pending"]?.feed_publication_pending).toBe(true);
    publish.mockResolvedValueOnce({ ok: false });
    await KaiHistoryService.publishPendingFeedResults({ ...owner, vaultOwnerToken: "memory-only-token" }, () => true);
    expect((await SecureDurableResourceService.read<Record<string, AnalysisHistoryEntry>>(owner.userId, resourceKey, owner.vaultKey, () => true))?.value["run:pending"]?.feed_publication_pending).toBe(true);
    publish.mockResolvedValueOnce({ ok: true });
    await KaiHistoryService.publishPendingFeedResults({ ...owner, vaultOwnerToken: "memory-only-token" }, () => true);
    expect((await SecureDurableResourceService.read<Record<string, AnalysisHistoryEntry>>(owner.userId, resourceKey, owner.vaultKey, () => true))?.value["run:pending"]?.feed_publication_pending).toBeUndefined();
    const calls = publish.mock.calls.length;
    await KaiHistoryService.publishPendingFeedResults({ ...owner, vaultOwnerToken: "memory-only-token" }, () => true);
    expect(publish).toHaveBeenCalledTimes(calls);
    expect(pkm.write).not.toHaveBeenCalled();
  } finally {
    cloud.enabled = false;
    cloud.reports.clear();
    vi.unstubAllGlobals();
  }
});

describe("analysis history storage shape", () => {
  it("keeps replay text without duplicating decision metrics into the transcript", () => {
    const compacted = compactAnalysisHistoryEntryForStorage(
      entry({
        raw_card: { key_metrics: { revenue: 100 }, debate_run_id: "run-1" },
        debate_transcript: {
          round1: {
            fundamental: {
              stage: "complete",
              text: "Revenue is improving.",
              thoughts: [],
              statusMessage: "Analysis complete",
              keyMetrics: { revenue: 100 },
              quantMetrics: { margin: 0.4 },
              sources: ["SEC"],
            },
          },
          round2: {},
        },
      }),
    );

    expect(compacted.raw_card).toEqual({
      key_metrics: { revenue: 100 },
      debate_run_id: "run-1",
    });
    expect(compacted.debate_transcript?.round1.fundamental).toEqual({
      stage: "complete",
      text: "Revenue is improving.",
      thoughts: [],
      statusMessage: "Analysis complete",
    });
  });
});


it("never resurrects a deleted shared report from a pending or stale device copy, and opens another exact run on a fresh device", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("crypto", webcrypto);
  const bytes = new TextEncoder().encode("");
  vi.stubGlobal("Uint8Array", bytes.constructor);
  vi.stubGlobal("ArrayBuffer", bytes.buffer.constructor);
  const owner = { userId: "report-deletion-owner", vaultKey: "ad".repeat(32), vaultOwnerToken: "memory-only-token" };
  const pending = entry({ ticker: "AAPL", raw_card: { debate_run_id: "removed-run" }, feed_publication_pending: true });
  const other = entry({ ticker: "AAPL", timestamp: "2026-08-12T12:00:00.000Z", raw_card: { debate_run_id: "kept-run" } });
  pkm.load.mockResolvedValue({});
  cloud.enabled = true;
  publish.mockRejectedValue(new Error("ACK lost"));
  try {
    await KaiHistoryService.saveAnalysis({ ...owner, entry: pending, isCurrent: () => true });
    await KaiHistoryService.saveAnalysis({ ...owner, entry: other, isCurrent: () => true });
    await KaiHistoryService.publishPendingFeedResults(owner, () => true);
    expect(cloud.reports.get("removed-run").state).toBe("available");
    cloud.reports.set("removed-run", { schema: "kai-analysis-report.v1", state: "deleted", runId: "removed-run", deletedAt: "2026-08-12T13:00:00Z" });
    invalidateSharedReports();
    cloud.open.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(KaiHistoryService.getAnalysisByRouteId(owner, "run:removed-run")).rejects.toThrow("network unavailable");
    await expect(KaiHistoryService.getAnalysisByRouteId(owner, "run:removed-run")).resolves.toBeNull();
    await KaiHistoryService.publishPendingFeedResults(owner, () => true);
    const device = await SecureDurableResourceService.read<Record<string, AnalysisHistoryEntry>>(owner.userId, "finance-analysis-history-v1", owner.vaultKey, () => true);
    expect(device?.value["run:removed-run"]).toBeUndefined();
    expect(device?.value["run:kept-run"]).toBeDefined();
    // Same owner on a fresh device has no durable resource; source lookup remains run-specific.
    await SecureDurableResourceService.purgeUser(owner.userId);
    await expect(KaiHistoryService.getAnalysisByRouteId(owner, "run:kept-run")).resolves.toEqual(other);
    await expect(KaiHistoryService.getAnalysisByRouteId(owner, "run:removed-run")).resolves.toBeNull();
    cloud.open.mockRejectedValueOnce(new Error("REPORT_SETTINGS_INVALID"));
    await expect(KaiHistoryService.getAnalysisByRouteId(owner, "run:kept-run")).rejects.toThrow("REPORT_SETTINGS_INVALID");
  } finally {
    cloud.enabled = false; cloud.reports.clear(); invalidateSharedReports(); publish.mockReset(); vi.unstubAllGlobals();
  }
});
