import type { AnalysisHistoryEntry } from "@/lib/services/kai-history-service";

export const SHARED_REPORT_GROUP = "kai-analysis-reports.v1";
export const SHARED_REPORT_SETTINGS = "kai-analysis-report-settings.v1";
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;
export type SharedReport =
  | { schema: "kai-analysis-report.v1"; state: "available"; runId: string; record: AnalysisHistoryEntry }
  | { schema: "kai-analysis-report.v1"; state: "deleted"; runId: string; deletedAt: string };

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;
const fail = (): never => { throw new Error("The saved report could not be verified."); };

/** Bound structure as well as bytes before accepting decrypted, untrusted JSON. */
export function reportJson(value: unknown): string {
  let entries = 0;
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64 || ++entries > 100_000) fail();
    if (item === null || typeof item === "boolean" || typeof item === "string") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (Array.isArray(item)) { item.forEach(child => visit(child, depth + 1)); return; }
    if (object(item)) { Object.values(item).forEach(child => visit(child, depth + 1)); return; }
    fail();
  };
  visit(value, 0);
  const result = JSON.stringify(value, (_key, item: unknown) => object(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  if (new TextEncoder().encode(result).length > MAX_REPORT_BYTES) throw new Error("This report is too large to sync.");
  return result;
}

export function verifiedReport(value: unknown, expectedRunId?: string): SharedReport {
  reportJson(value);
  if (!object(value) || value.schema !== "kai-analysis-report.v1" ||
    !text(value.runId, 128) || !/^[a-zA-Z0-9_-]+$/.test(value.runId) ||
    (expectedRunId !== undefined && value.runId !== expectedRunId)) return fail();
  if (value.state === "deleted") {
    if (Object.keys(value).sort().join() !== "deletedAt,runId,schema,state" ||
      !text(value.deletedAt, 40) || !Number.isFinite(Date.parse(value.deletedAt))) return fail();
    return value as SharedReport;
  }
  if (value.state !== "available" || Object.keys(value).sort().join() !== "record,runId,schema,state" || !object(value.record)) return fail();
  const record = value.record;
  const allowed = new Set(["ticker", "timestamp", "decision", "confidence", "consensus_reached", "agent_votes", "final_statement", "raw_card", "debate_transcript"]);
  if (Object.keys(record).some(key => !allowed.has(key)) || !text(record.ticker, 64) ||
    !text(record.timestamp, 40) || !Number.isFinite(Date.parse(record.timestamp)) ||
    !text(record.decision, 160) || typeof record.confidence !== "number" || !Number.isFinite(record.confidence) ||
    typeof record.consensus_reached !== "boolean" || typeof record.final_statement !== "string" ||
    !object(record.agent_votes) || Object.values(record.agent_votes).some(vote => typeof vote !== "string") ||
    !object(record.raw_card) || record.raw_card.debate_run_id !== value.runId) return fail();
  if (record.debate_transcript !== undefined && (!object(record.debate_transcript) ||
    Object.keys(record.debate_transcript).sort().join() !== "round1,round2" ||
    !object(record.debate_transcript.round1) || !object(record.debate_transcript.round2))) return fail();
  return value as SharedReport;
}

/** Local publication state is not part of an immutable shared report. */
export function sharedReport(runId: string, entry: AnalysisHistoryEntry): SharedReport {
  const { feed_publication_pending: _pending, feed_result_viewed: _viewed, shared_report_ref: _reference, shared_report_managed: _managed, ...record } = entry;
  // Match the JSON representation already persisted by encrypted device storage.
  return verifiedReport(JSON.parse(JSON.stringify({ schema: "kai-analysis-report.v1", state: "available", runId, record })), runId);
}
