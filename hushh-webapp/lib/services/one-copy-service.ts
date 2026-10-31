import { traceDriveRequest, observeDriveRequestState } from "@/lib/consent/drive-request-diagnostics";
import { ApiService } from "@/lib/services/api-service";
import { ONE_COPY_OPEN_BUDGET_MS, readOneCopyBytes, readOneCopyJson, withOneCopyDeadline } from "./one-copy-body";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { requireDocumentSession, protectedDocumentUrl, type DocumentSession } from "./document-hosting-service";

export function backgroundDocumentUrl(requestId: string): string | null {
  const link = protectedDocumentUrl(requestId);
  if (!link) return null;
  const url = new URL(link); url.searchParams.set("delivery", "background"); return url.href;
}
export type OneCopyFile = {
  fileRef: string; name: string; mimeType: string;
  status: "preparing" | "ready" | "unavailable" | "revoked";
  previewAvailable: boolean; sha256?: string; reason?: string; openUrl?: string;
  rendition?: "original" | "google_export"; exportFormat?: "PDF" | "XLSX" | "PPTX"; exportedAt?: string; sourceName?: string;
};
export type OneCopyActivity = { eventId: string; fileRef: string | null; kind: "preview_requested" | "download_requested" | "stream_completed" | "copy_ready" | "revoked"; createdAt: string; country: string | null; actorRole?: "owner" | "recipient" | "system" };
export type OneCopyActivityPage = { items: OneCopyActivity[]; nextCursor: string | null };
export type OneCopy = {
  requestId: string; actorRole: "owner" | "recipient"; status: "pending" | "preparing" | "ready" | "partial" | "unavailable" | "revoked";
  files: OneCopyFile[];
};
const states = new Set(["pending", "preparing", "ready", "partial", "unavailable", "revoked"]);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
function path(requestId: string): string {
  if (!uuid(requestId)) throw new Error("one_copy_unavailable");
  return `/api/connectors/google_drive/sharing/requests/${requestId}/one-copy`;
}
async function request(session: DocumentSession, target: string, signal?: AbortSignal, method = "GET", binary = false) {
  requireDocumentSession(session, signal);
  return traceDriveRequest(target, method, async (diagnosticHeaders, observe) => {
    requireDocumentSession(session, signal);
    const response = await ApiService.apiFetch(target, {
      method, signal, cache: "no-store", ...(binary ? { responseType: "arraybuffer" as const } : {}), headers: { ...diagnosticHeaders, Authorization: `Bearer ${session.vaultOwnerToken}` },
      isEffectCurrent: session.isCurrent,
  });
  try {
    requireDocumentSession(session, signal);
    observe(response);
    if (!response.ok) throw new Error("one_copy_unavailable");
  } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
  return response;
  });
}
/** Only exact authenticated content routes are used; no bearer credentials or provider URLs in links. */
export const OneCopyService = {
  async status(session: DocumentSession, requestId: string, signal?: AbortSignal, deadline?: number): Promise<OneCopy> {
    const response = await request(session, path(requestId), signal);
    const value = await readOneCopyJson(response, session, signal, deadline);
    requireDocumentSession(session, signal);
    if (value.requestId !== requestId || !["owner", "recipient"].includes(value.actorRole) || !states.has(value.status) || !Array.isArray(value.files) ||
      value.files.some((file: OneCopyFile) => !uuid(file.fileRef) || typeof file.name !== "string" ||
        typeof file.mimeType !== "string" || !["preparing", "ready", "unavailable", "revoked"].includes(file.status) ||
        typeof file.previewAvailable !== "boolean" ||
        (file.rendition !== undefined && !["original", "google_export"].includes(file.rendition)) ||
        (file.exportFormat !== undefined && !["PDF", "XLSX", "PPTX"].includes(file.exportFormat)) ||
        (file.exportedAt !== undefined && !Number.isFinite(Date.parse(file.exportedAt))) ||
        (file.sourceName !== undefined && typeof file.sourceName !== "string") || (file.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(file.sha256))))
      throw new Error("one_copy_unavailable");
    observeDriveRequestState(path(requestId), value, () => requireDocumentSession(session, signal));
    requireDocumentSession(session, signal);
    return value as OneCopy;
  },
  async content(session: DocumentSession, requestId: string, fileRef: string, disposition: "preview" | "download", signal: AbortSignal, deadline = Date.now() + ONE_COPY_OPEN_BUDGET_MS): Promise<Uint8Array> {
    if (!uuid(fileRef)) throw new Error("one_copy_unavailable");
    return withOneCopyDeadline(signal, deadline, async current => {
      const response = await request(session, `${path(requestId)}/files/${fileRef}/content?disposition=${disposition}`, current, "GET", true);
      const bytes = await readOneCopyBytes(response, session, current, deadline);
      try { requireDocumentSession(session, current); return bytes; }
      catch (error) { bytes.fill(0); throw error; }
    });
  },
  async activity(session: DocumentSession, requestId: string, signal: AbortSignal, cursor?: string): Promise<OneCopyActivityPage> {
    const response = await request(session, `${path(requestId)}/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, signal);
    const value = await readOneCopyJson(response, session, signal); requireDocumentSession(session, signal);
    if (!Array.isArray(value.items) || value.nextCursor !== null && typeof value.nextCursor !== "string" ||
      value.items.some((event: OneCopyActivity) => !uuid(event.eventId) || !["preview_requested", "download_requested", "stream_completed", "copy_ready", "revoked"].includes(event.kind) ||
        !Number.isFinite(Date.parse(event.createdAt)) || event.country !== null && !/^[A-Z]{2}$/.test(event.country) ||
        event.actorRole !== undefined && !["owner", "recipient", "system"].includes(event.actorRole))) throw new Error("one_copy_unavailable");
    return value as OneCopyActivityPage;
  },
  async revoke(session: DocumentSession, requestId: string, signal?: AbortSignal): Promise<void> {
    await request(session, `${path(requestId)}/revoke`, signal, "POST");
    requireDocumentSession(session, signal);
    CacheSyncService.onConsentMutated(session.userId);
  },
};
