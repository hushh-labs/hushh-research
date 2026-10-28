import { traceDriveRequest, observeDriveRequestState } from "@/lib/consent/drive-request-diagnostics";
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { ApiService } from "@/lib/services/api-service";
import { nativeStreamFetch } from "@/lib/services/native-sse-fetch";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";

const PATH = "/api/connectors/google_drive/searches";
const STATES = ["queued", "running", "completed", "stopped", "failed", "limited"] as const;
const TERMINAL_STATES = new Set<DriveSearchStatus["status"]>(["completed", "stopped", "failed", "limited"]);
const EVALUATION_STATES = ["pending", "running", "ready", "no_match", "failed", "obsolete"] as const;
const STREAM_MAX_BYTES = 1_048_576;
const STREAM_FRAME_MAX_CHARS = 16_384;
type DriveSearchSelectionCoverage = {
  requestedResultLimit: number;
  resultOrder: "createdTime desc" | "modifiedTime desc";
  selectionFinalized: boolean;
  candidateCount: number;
  candidateCountScope: "retained_pool" | "all_unique_matches";
  candidatePoolPruned: boolean;
};
export type DriveSearchCoverage = {
  corpora: Array<"user" | "member_shared_drives">;
  fileKind: string;
  requestedPeriod: { start: string; end: string; timezone: string } | null;
  /**
   * title_date_then_created_then_modified: an autoshare search. Every match
   * whose title date (else created, else modified time) is inside the picked
   * period is shared after payment, with no owner file review.
   */
  dateBasis:
    | "title_date_then_created_or_modified"
    | "title_date_then_created_then_modified"
    | "content_period_unverified";
  timeIntent?: "file_activity" | "document_coverage";
  ownerReviewRequired?: boolean;
  contentPeriodVerified: false;
  providerRowsScanned: number;
  excludedByDateCount: number;
  /** Files in matching folders omitted because their titles did not match the request. */
  excludedByTopicCount?: number;
  /** Owner-only: request search checked live Drive sharing capability. */
  shareabilityVerified?: boolean;
  deduplicatedCount: number;
  unavailableShortcutCount: number;
  providerPagesExhausted: boolean;
} & Partial<DriveSearchSelectionCoverage>;
export type DriveSearchStatus = {
  jobId: string;
  status: (typeof STATES)[number];
  revision: number;
  matched: number;
  pagesScanned: number;
  incompleteSearch: boolean;
  canStop: boolean;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  errorCode: string | null;
  unshareableCount?: number;
  /** Live V1 content checking; absent for older search jobs. */
  evaluation?: { status: (typeof EVALUATION_STATES)[number]; evaluatedCount: number; pendingCount: number; verifiedCount: number };
  coverage?: DriveSearchCoverage;
};
export type DriveSearchFile = {
  position: number;
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  openUrl: string | null;
  shareable?: boolean;
  /** Owner-only V1 document assessment; not a calibrated probability. */
  confidenceScore?: number;
  /** Relative usefulness of this verified file for the request. */
  weightageOutOf10?: number;
  unavailableReason?: "shortcut_target_unavailable" | "source_not_shareable" | "shareability_unverified" | null;
};
/** A single saved result, resolved and rechecked by the owner-authenticated chat route. */
export type DriveSearchSelection = { jobId: string; position: number };
export type DriveSearchResults = {
  jobId: string;
  revision: number;
  files: DriveSearchFile[];
  matched: number;
  nextCursor: string | null;
};
export class DriveSearchError extends Error {
  constructor(public readonly code: string) { super("Drive search could not finish."); }
}
/** An older backend or a stream proxy can still serve the durable GET status. */
export class DriveSearchStreamUnavailable extends Error {
  constructor() { super("Drive search progress stream is unavailable."); }
}
type Guard = () => void;
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DriveSearchError("invalid_response");
  return value as RecordValue;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    throw new DriveSearchError("invalid_response");
  return value;
}
function id(value: unknown): string {
  const result = text(value, 36);
  if (!DOCUMENT_REQUEST_UUID.test(result)) throw new DriveSearchError("invalid_response");
  return result;
}
function count(value: unknown, max = 10_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new DriveSearchError("invalid_response");
  return value;
}
function position(value: unknown): number {
  const result = count(value);
  if (result === 0) throw new DriveSearchError("invalid_response");
  return result;
}
function date(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result))) throw new DriveSearchError("invalid_response");
  return result;
}
function selectionCoverage(item: RecordValue): Partial<DriveSearchSelectionCoverage> {
  const fields = ["requestedResultLimit", "resultOrder", "selectionFinalized", "candidateCount",
    "candidateCountScope", "candidatePoolPruned"];
  if (!fields.some(field => item[field] !== undefined)) return {};
  const requestedResultLimit = count(item.requestedResultLimit, 1000);
  if (requestedResultLimit < 1 ||
    (item.resultOrder !== "createdTime desc" && item.resultOrder !== "modifiedTime desc") ||
    typeof item.selectionFinalized !== "boolean" || typeof item.candidatePoolPruned !== "boolean" ||
    item.candidateCountScope !== (item.candidatePoolPruned ? "retained_pool" : "all_unique_matches"))
    throw new DriveSearchError("invalid_response");
  return { requestedResultLimit, resultOrder: item.resultOrder,
    selectionFinalized: item.selectionFinalized,
    candidateCount: count(item.candidateCount, Number.MAX_SAFE_INTEGER),
    candidateCountScope: item.candidateCountScope as DriveSearchSelectionCoverage["candidateCountScope"],
    candidatePoolPruned: item.candidatePoolPruned };
}

/** The server may prove a final top-N selection without exhausting older provider pages. */
export function isDriveSearchSelectionReady(
  search: DriveSearchStatus | null | undefined,
): search is DriveSearchStatus & { status: "completed"; incompleteSearch: false } {
  if (search?.status !== "completed" || search.incompleteSearch ||
    search.coverage?.shareabilityVerified !== true) return false;
  try {
    const selection = selectionCoverage(search.coverage);
    if (selection.requestedResultLimit === undefined) return search.coverage.providerPagesExhausted === true;
    return selection.selectionFinalized === true && search.matched <= selection.requestedResultLimit &&
      search.matched <= selection.candidateCount!;
  } catch { return false; }
}
function coverage(value: unknown): DriveSearchCoverage {
  const item = record(value);
  if (!Array.isArray(item.corpora) || item.corpora.length > 2 ||
    item.corpora.some(corpus => corpus !== "user" && corpus !== "member_shared_drives") ||
    new Set(item.corpora).size !== item.corpora.length ||
    !["title_date_then_created_or_modified", "title_date_then_created_then_modified",
      "content_period_unverified"].includes(item.dateBasis as string) ||
    item.contentPeriodVerified !== false ||
    item.timeIntent !== undefined && item.timeIntent !== "file_activity" && item.timeIntent !== "document_coverage" ||
    item.ownerReviewRequired !== undefined && typeof item.ownerReviewRequired !== "boolean" ||
    // Only the autoshare date selection lets document coverage skip owner review.
    item.dateBasis === "title_date_then_created_then_modified" && item.ownerReviewRequired !== false ||
    item.timeIntent === "document_coverage" && item.ownerReviewRequired !== true &&
      item.dateBasis !== "title_date_then_created_then_modified" ||
    item.dateBasis === "content_period_unverified" &&
      (item.timeIntent !== "document_coverage" || item.ownerReviewRequired !== true) ||
    typeof item.providerPagesExhausted !== "boolean" ||
    item.shareabilityVerified !== undefined && typeof item.shareabilityVerified !== "boolean")
    throw new DriveSearchError("invalid_response");
  let requestedPeriod: DriveSearchCoverage["requestedPeriod"] = null;
  if (item.requestedPeriod != null) {
    const period = record(item.requestedPeriod);
    const start = date(period.start), end = date(period.end);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end)
      throw new DriveSearchError("invalid_response");
    requestedPeriod = { start, end, timezone: text(period.timezone, 100) };
  }
  return { ...selectionCoverage(item),
    corpora: item.corpora as DriveSearchCoverage["corpora"], fileKind: text(item.fileKind, 32), requestedPeriod,
    dateBasis: item.dateBasis as DriveSearchCoverage["dateBasis"], contentPeriodVerified: false,
    ...(item.timeIntent === undefined ? {} : { timeIntent: item.timeIntent as DriveSearchCoverage["timeIntent"] }),
    ...(item.ownerReviewRequired === undefined ? {} : { ownerReviewRequired: item.ownerReviewRequired as boolean }),
    providerRowsScanned: count(item.providerRowsScanned, Number.MAX_SAFE_INTEGER),
    excludedByDateCount: count(item.excludedByDateCount, Number.MAX_SAFE_INTEGER),
    ...(item.excludedByTopicCount === undefined ? {} : {
      excludedByTopicCount: count(item.excludedByTopicCount, Number.MAX_SAFE_INTEGER),
    }),
    ...(item.shareabilityVerified === undefined ? {} : {
      shareabilityVerified: item.shareabilityVerified as boolean,
    }),
    deduplicatedCount: count(item.deduplicatedCount, Number.MAX_SAFE_INTEGER),
    unavailableShortcutCount: count(item.unavailableShortcutCount), providerPagesExhausted: item.providerPagesExhausted };
}
export function parseDriveSearchStatus(value: unknown): DriveSearchStatus {
  const item = record(value);
  if (!STATES.includes(item.status as DriveSearchStatus["status"]) ||
    typeof item.incompleteSearch !== "boolean" || typeof item.canStop !== "boolean")
    throw new DriveSearchError("invalid_response");
  if (item.unshareableCount !== undefined && count(item.unshareableCount) > count(item.matched))
    throw new DriveSearchError("invalid_response");
  const evaluation = item.evaluation === undefined ? undefined : (() => {
    const value = record(item.evaluation);
    if (!EVALUATION_STATES.includes(value.status as (typeof EVALUATION_STATES)[number]))
      throw new DriveSearchError("invalid_response");
    const matched = count(item.matched);
    const evaluatedCount = count(value.evaluatedCount);
    const pendingCount = count(value.pendingCount);
    const verifiedCount = count(value.verifiedCount);
    if (evaluatedCount > matched || pendingCount !== matched - evaluatedCount || verifiedCount > evaluatedCount)
      throw new DriveSearchError("invalid_response");
    return { status: value.status as (typeof EVALUATION_STATES)[number], evaluatedCount, pendingCount, verifiedCount };
  })();
  const result: DriveSearchStatus = {
    jobId: id(item.jobId), status: item.status as DriveSearchStatus["status"],
    revision: count(item.revision, Number.MAX_SAFE_INTEGER), matched: count(item.matched),
    pagesScanned: count(item.pagesScanned, Number.MAX_SAFE_INTEGER),
    incompleteSearch: item.incompleteSearch, canStop: item.canStop,
    createdAt: date(item.createdAt), expiresAt: date(item.expiresAt), updatedAt: date(item.updatedAt),
    errorCode: item.errorCode == null ? null : text(item.errorCode, 80),
    ...(item.unshareableCount === undefined ? {} : { unshareableCount: count(item.unshareableCount) }),
    ...(evaluation === undefined ? {} : { evaluation }),
    ...(item.coverage == null ? {} : { coverage: coverage(item.coverage) }),
  };
  if (result.coverage?.requestedResultLimit !== undefined &&
    (result.coverage.selectionFinalized
      ? result.status !== "completed" || result.incompleteSearch ||
        result.matched > result.coverage.requestedResultLimit || result.matched > result.coverage.candidateCount!
      : result.matched !== 0)) throw new DriveSearchError("invalid_response");
  return result;
}
function file(value: unknown): DriveSearchFile {
  const item = record(value);
  if (item.shareable !== undefined && typeof item.shareable !== "boolean")
    throw new DriveSearchError("invalid_response");
  if (item.unavailableReason != null &&
    item.unavailableReason !== "shortcut_target_unavailable" &&
    item.unavailableReason !== "source_not_shareable" &&
    item.unavailableReason !== "shareability_unverified")
    throw new DriveSearchError("invalid_response");
  const confidenceScore = item.confidenceScore === undefined ? undefined : count(item.confidenceScore, 100);
  const weightageOutOf10 = item.weightageOutOf10 === undefined ? undefined : item.weightageOutOf10;
  if (weightageOutOf10 !== undefined &&
    (typeof weightageOutOf10 !== "number" || !Number.isFinite(weightageOutOf10) ||
      weightageOutOf10 < 1 || weightageOutOf10 > 10) ||
    (confidenceScore === undefined) !== (weightageOutOf10 === undefined))
    throw new DriveSearchError("invalid_response");
  // Accept Google file links only. Provider response strings never become HTML.
  let openUrl: string | null = null;
  if (item.openUrl != null) {
    let url: URL;
    try { url = new URL(text(item.openUrl, 2048)); } catch { throw new DriveSearchError("invalid_response"); }
    if (url.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(url.hostname) ||
      url.username || url.password || url.port) throw new DriveSearchError("invalid_response");
    openUrl = url.href;
  }
  return { position: position(item.position), id: text(item.id, 256), name: text(item.name, 1000), mimeType: text(item.mimeType, 256),
    modifiedTime: item.modifiedTime == null ? null : date(item.modifiedTime), openUrl,
    ...(item.shareable === undefined ? {} : { shareable: item.shareable as boolean }),
    ...(confidenceScore === undefined ? {} : { confidenceScore,
      weightageOutOf10: weightageOutOf10 as number }),
    ...(item.unavailableReason == null ? {} : { unavailableReason: item.unavailableReason as DriveSearchFile["unavailableReason"] }) };
}

export function parseDriveSearchResults(value: unknown, jobId: string): DriveSearchResults {
  const result = record(value);
  if (id(result.jobId) !== jobId || !Array.isArray(result.files) || result.files.length > 25)
    throw new DriveSearchError("invalid_response");
  const files = result.files.map(file);
  if (new Set(files.map(item => item.id)).size !== files.length ||
    new Set(files.map(item => item.position)).size !== files.length)
    throw new DriveSearchError("invalid_response");
  return { jobId, revision: count(result.revision, Number.MAX_SAFE_INTEGER), files,
    matched: count(result.matched), nextCursor: result.nextCursor == null ? null : text(result.nextCursor, 1024) };
}

/** Owner-scoped responses remain in mounted component memory; never browser storage. */
export class DriveSearchService {
  private static async send(token: string, guard: Guard, suffix = "", body?: object): Promise<RecordValue> {
    guard();
    return traceDriveRequest(`${PATH}${suffix}`, body === undefined ? "GET" : "POST", async (diagnosticHeaders, observe) => {
      guard();
      const response = await ApiService.apiFetch(`${PATH}${suffix}`, {
        method: body === undefined ? "GET" : "POST", cache: "no-store",
        isEffectCurrent: () => { guard(); return true; },
        headers: { ...diagnosticHeaders, ...ApiService.getAuthHeaders(token), "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      guard();
      observe(response);
      const serialized = await response.text();
      guard();
      if (serialized.length > 262_144) throw new DriveSearchError("invalid_response");
      let payload: RecordValue;
      try { payload = record(JSON.parse(serialized)); } catch { throw new DriveSearchError("invalid_response"); }
      observe(response, payload);
      if (!response.ok) {
        const detail = payload.detail && typeof payload.detail === "object" ? record(payload.detail) : payload;
        const code = typeof detail.code === "string" && /^[a-z_]{1,80}$/.test(detail.code) ? detail.code : "request_failed";
        throw new DriveSearchError(code);
      }
      return payload;
    }, body);
  }
  static async create(token: string, query: string, clientRequestId: string, guard: Guard) {
    id(clientRequestId);
    if (!query.trim() || new TextEncoder().encode(query).byteLength > 2048) throw new DriveSearchError("invalid_argument");
    const value = parseDriveSearchStatus(await this.send(token, guard, "", { clientRequestId, query, backgroundConsent: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    observeDriveRequestState(`${PATH}/${value.jobId}`, value, guard);
    return value;
  }
  static async recent(token: string, guard: Guard): Promise<DriveSearchStatus[]> {
    const value = await this.send(token, guard);
    if (!Array.isArray(value.jobs) || value.jobs.length > 25) throw new DriveSearchError("invalid_response");
    const jobs = value.jobs.map(parseDriveSearchStatus);
    if (new Set(jobs.map(job => job.jobId)).size !== jobs.length) throw new DriveSearchError("invalid_response");
    return jobs;
  }
  static async get(token: string, jobId: string, guard: Guard) {
    const value = parseDriveSearchStatus(await this.send(token, guard, `/${id(jobId)}`));
    if (value.jobId !== jobId) throw new DriveSearchError("invalid_response");
    observeDriveRequestState(`${PATH}/${jobId}`, value, guard);
    return value;
  }
  /** Live status is advisory; callers still load the owner review for file decisions. */
  static async streamStatus(
    token: string,
    jobId: string,
    guard: Guard,
    onStatus: (status: DriveSearchStatus) => void,
    signal?: AbortSignal,
  ): Promise<"complete" | "interrupted"> {
    id(jobId);
    guard();
    let response: Response;
    try {
      response = await nativeStreamFetch(`${PATH}/${jobId}/stream`, {
        method: "GET", cache: "no-store", signal,
        headers: { ...ApiService.getAuthHeaders(token), Accept: "text/event-stream" },
      });
    } catch (cause) {
      if (signal?.aborted) return "interrupted";
      throw cause;
    }
    guard();
    if ([404, 405, 503].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new DriveSearchStreamUnavailable();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new DriveSearchError("request_failed");
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined);
      throw new DriveSearchStreamUnavailable();
    }
    const reader = response.body.getReader();
    const cancel = () => void reader.cancel().catch(() => undefined);
    signal?.addEventListener("abort", cancel, { once: true });
    const decoder = new TextDecoder();
    let remainder = "";
    let received = 0;
    let revision = -1;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch { return "interrupted"; }
        guard();
        if (chunk.done) return "interrupted";
        received += chunk.value.byteLength;
        if (received > STREAM_MAX_BYTES) throw new DriveSearchError("invalid_response");
        const parsed = parseSSEBlocks(decoder.decode(chunk.value, { stream: true }), remainder);
        remainder = parsed.remainder;
        if (remainder.length > STREAM_FRAME_MAX_CHARS) throw new DriveSearchError("invalid_response");
        for (const frame of parsed.events) {
          if (frame.data.length > STREAM_FRAME_MAX_CHARS) throw new DriveSearchError("invalid_response");
          if (frame.event !== "status") continue;
          let payload: unknown;
          try { payload = JSON.parse(frame.data); }
          catch { throw new DriveSearchError("invalid_response"); }
          const item = record(payload);
          if (item.event !== "status") throw new DriveSearchError("invalid_response");
          const status = parseDriveSearchStatus(item);
          if (status.jobId !== jobId) throw new DriveSearchError("invalid_response");
          if (status.revision <= revision) continue;
          revision = status.revision;
          observeDriveRequestState(`${PATH}/${jobId}`, status, guard);
          guard();
          onStatus(status);
          if (TERMINAL_STATES.has(status.status) &&
              !(status.status === "completed" &&
                (status.evaluation?.status === "pending" || status.evaluation?.status === "running")))
            return "complete";
        }
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancel();
    }
  }
  static async results(token: string, jobId: string, guard: Guard, cursor: string | null = null): Promise<DriveSearchResults> {
    const query = cursor == null ? "" : `?cursor=${encodeURIComponent(text(cursor, 1024))}`;
    return parseDriveSearchResults(await this.send(token, guard, `/${id(jobId)}/results${query}`), jobId);
  }
  static async stop(token: string, jobId: string, guard: Guard) {
    const value = parseDriveSearchStatus(await this.send(token, guard, `/${id(jobId)}/stop`, {}));
    if (value.jobId !== jobId || value.canStop) throw new DriveSearchError("invalid_response");
    return value;
  }
}
