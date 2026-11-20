import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { ApiService } from "@/lib/services/api-service";
import { apiJson } from "@/lib/services/api-client";

export type SharedFileAudience = "owner" | "requester";
export type SharedFileMatch = {
  requestId: string;
  fileRef: string;
  audience: SharedFileAudience;
  name: string;
  recordedAt: string;
  status: "shared" | "access_changed";
  openUrl: string;
};
export type SharedFileSearchCriteria = { query: string; personRef?: string; fromAt?: string | null; beforeAt?: string | null };
const FILE_REF = /^(bulk|legacy):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:\d{1,5}$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("File unavailable");
  return value as Record<string, unknown>;
}
function parseFile(value: unknown, audience: SharedFileAudience): SharedFileMatch {
  const file = record(value);
  if (typeof file.requestId !== "string" || !DOCUMENT_REQUEST_UUID.test(file.requestId) ||
      typeof file.fileRef !== "string" || !FILE_REF.test(file.fileRef) || file.audience !== audience ||
      typeof file.name !== "string" || !file.name || file.name.length > 255 ||
      typeof file.recordedAt !== "string" || !Number.isFinite(Date.parse(file.recordedAt)) ||
      !["shared", "access_changed"].includes(file.status as string) || typeof file.openUrl !== "string" ||
      !/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(file.openUrl)) throw new Error("File unavailable");
  return { requestId: file.requestId, fileRef: file.fileRef, audience, name: file.name,
    recordedAt: file.recordedAt, status: file.status as SharedFileMatch["status"], openUrl: file.openUrl };
}
function endpoint(audience: SharedFileAudience): string {
  return `/api/connectors/google_drive/sharing/${audience === "owner" ? "shared-files" : "received-files"}`;
}
async function read(path: string, token: string, body: unknown): Promise<unknown> {
  if (!token) throw new Error("Owner authorization unavailable");
  return apiJson<unknown>(path, { method: "POST", headers: { ...ApiService.getAuthHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
}
/** Private criteria stay in a POST body. Results/cursors are memory-only. */
export class DriveSharedFileSearchService {
  static async search(token: string, audience: SharedFileAudience, criteria: SharedFileSearchCriteria, cursor: string | null = null): Promise<{ files: SharedFileMatch[]; nextCursor: string | null }> {
    const page = record(await read(endpoint(audience) + "/search", token, { ...criteria, cursor }));
    if (!Array.isArray(page.files) || page.files.length > 20 ||
        !(page.nextCursor === null || typeof page.nextCursor === "string" && page.nextCursor.length > 0 && page.nextCursor.length <= 4096) || page.nextCursor !== null && page.nextCursor === cursor) throw new Error("File search unavailable");
    return { files: page.files.map(file => parseFile(file, audience)), nextCursor: page.nextCursor as string | null };
  }
  static async open(token: string, selected: Pick<SharedFileMatch, "audience" | "requestId" | "fileRef">): Promise<SharedFileMatch> {
    if (!DOCUMENT_REQUEST_UUID.test(selected.requestId) || !FILE_REF.test(selected.fileRef)) throw new Error("File unavailable");
    const file = parseFile(await read(endpoint(selected.audience) + "/file", token, { requestId: selected.requestId, fileRef: selected.fileRef }), selected.audience);
    if (file.requestId !== selected.requestId || file.fileRef !== selected.fileRef) throw new Error("File unavailable");
    return file;
  }
}
