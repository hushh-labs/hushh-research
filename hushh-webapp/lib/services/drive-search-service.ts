import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { ApiService } from "@/lib/services/api-service";

const PATH = "/api/connectors/google_drive/searches";
const STATES = ["queued", "running", "completed", "stopped", "failed", "limited"] as const;
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
};
export type DriveSearchFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  openUrl: string | null;
};
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
function date(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result))) throw new DriveSearchError("invalid_response");
  return result;
}
function status(value: unknown): DriveSearchStatus {
  const item = record(value);
  if (!STATES.includes(item.status as DriveSearchStatus["status"]) ||
    typeof item.incompleteSearch !== "boolean" || typeof item.canStop !== "boolean")
    throw new DriveSearchError("invalid_response");
  return {
    jobId: id(item.jobId), status: item.status as DriveSearchStatus["status"],
    revision: count(item.revision, Number.MAX_SAFE_INTEGER), matched: count(item.matched),
    pagesScanned: count(item.pagesScanned, Number.MAX_SAFE_INTEGER),
    incompleteSearch: item.incompleteSearch, canStop: item.canStop,
    createdAt: date(item.createdAt), expiresAt: date(item.expiresAt), updatedAt: date(item.updatedAt),
    errorCode: item.errorCode == null ? null : text(item.errorCode, 80),
  };
}
function file(value: unknown): DriveSearchFile {
  const item = record(value);
  // Accept Google file links only. Provider response strings never become HTML.
  let openUrl: string | null = null;
  if (item.openUrl != null) {
    let url: URL;
    try { url = new URL(text(item.openUrl, 2048)); } catch { throw new DriveSearchError("invalid_response"); }
    if (url.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(url.hostname) ||
      url.username || url.password || url.port) throw new DriveSearchError("invalid_response");
    openUrl = url.href;
  }
  return { id: text(item.id, 256), name: text(item.name, 1000), mimeType: text(item.mimeType, 256),
    modifiedTime: item.modifiedTime == null ? null : date(item.modifiedTime), openUrl };
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
    return status(await this.send(token, guard, "", { clientRequestId, query, backgroundConsent: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
  }
  static async recent(token: string, guard: Guard): Promise<DriveSearchStatus[]> {
    const value = await this.send(token, guard);
    if (!Array.isArray(value.jobs) || value.jobs.length > 25) throw new DriveSearchError("invalid_response");
    const jobs = value.jobs.map(status);
    if (new Set(jobs.map(job => job.jobId)).size !== jobs.length) throw new DriveSearchError("invalid_response");
    return jobs;
  }
  static async get(token: string, jobId: string, guard: Guard) {
    const value = status(await this.send(token, guard, `/${id(jobId)}`));
    if (value.jobId !== jobId) throw new DriveSearchError("invalid_response");
    return value;
  }
  static async results(token: string, jobId: string, guard: Guard, cursor: string | null = null): Promise<DriveSearchResults> {
    const query = cursor == null ? "" : `?cursor=${encodeURIComponent(text(cursor, 1024))}`;
    const value = await this.send(token, guard, `/${id(jobId)}/results${query}`);
    if (id(value.jobId) !== jobId || !Array.isArray(value.files) || value.files.length > 25)
      throw new DriveSearchError("invalid_response");
    const files = value.files.map(file);
    if (new Set(files.map(item => item.id)).size !== files.length) throw new DriveSearchError("invalid_response");
    return { jobId, revision: count(value.revision, Number.MAX_SAFE_INTEGER), files,
      matched: count(value.matched), nextCursor: value.nextCursor == null ? null : text(value.nextCursor, 1024) };
  }
  static async stop(token: string, jobId: string, guard: Guard) {
    const value = status(await this.send(token, guard, `/${id(jobId)}/stop`, {}));
    if (value.jobId !== jobId || value.canStop) throw new DriveSearchError("invalid_response");
    return value;
  }
}
