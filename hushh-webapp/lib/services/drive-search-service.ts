import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { ApiService } from "@/lib/services/api-service";

const PATH = "/api/connectors/google_drive/searches";
const STATES = ["queued", "running", "completed", "stopped", "failed", "limited"] as const;
export type DriveSearchCoverage = {
  corpora: Array<"user" | "member_shared_drives">;
  fileKind: string;
  requestedPeriod: { start: string; end: string; timezone: string } | null;
  dateBasis: "title_date_then_created_or_modified";
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
};
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
function coverage(value: unknown): DriveSearchCoverage {
  const item = record(value);
  if (!Array.isArray(item.corpora) || item.corpora.length > 2 ||
    item.corpora.some(corpus => corpus !== "user" && corpus !== "member_shared_drives") ||
    new Set(item.corpora).size !== item.corpora.length ||
    item.dateBasis !== "title_date_then_created_or_modified" || item.contentPeriodVerified !== false ||
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
  return { corpora: item.corpora as DriveSearchCoverage["corpora"], fileKind: text(item.fileKind, 32), requestedPeriod,
    dateBasis: item.dateBasis, contentPeriodVerified: false,
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
  return {
    jobId: id(item.jobId), status: item.status as DriveSearchStatus["status"],
    revision: count(item.revision, Number.MAX_SAFE_INTEGER), matched: count(item.matched),
    pagesScanned: count(item.pagesScanned, Number.MAX_SAFE_INTEGER),
    incompleteSearch: item.incompleteSearch, canStop: item.canStop,
    createdAt: date(item.createdAt), expiresAt: date(item.expiresAt), updatedAt: date(item.updatedAt),
    errorCode: item.errorCode == null ? null : text(item.errorCode, 80),
    ...(item.unshareableCount === undefined ? {} : { unshareableCount: count(item.unshareableCount) }),
    ...(item.coverage == null ? {} : { coverage: coverage(item.coverage) }),
  };
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
    const response = await ApiService.apiFetch(`${PATH}${suffix}`, {
      method: body === undefined ? "GET" : "POST", cache: "no-store",
      isEffectCurrent: () => { guard(); return true; },
      headers: { ...ApiService.getAuthHeaders(token), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    guard();
    const serialized = await response.text();
    guard();
    if (serialized.length > 262_144) throw new DriveSearchError("invalid_response");
    let payload: RecordValue;
    try { payload = record(JSON.parse(serialized)); } catch { throw new DriveSearchError("invalid_response"); }
    if (!response.ok) {
      const detail = payload.detail && typeof payload.detail === "object" ? record(payload.detail) : payload;
      const code = typeof detail.code === "string" && /^[a-z_]{1,80}$/.test(detail.code) ? detail.code : "request_failed";
      throw new DriveSearchError(code);
    }
    return payload;
  }
  static async create(token: string, query: string, clientRequestId: string, guard: Guard) {
    id(clientRequestId);
    if (!query.trim() || new TextEncoder().encode(query).byteLength > 2048) throw new DriveSearchError("invalid_argument");
    return parseDriveSearchStatus(await this.send(token, guard, "", { clientRequestId, query, backgroundConsent: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
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
    return value;
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
