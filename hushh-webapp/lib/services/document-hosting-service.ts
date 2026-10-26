import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { ApiService } from "@/lib/services/api-service";
import type { DocumentDescriptor, DocumentTerms, DocumentWrap } from "@/lib/consent/document-hosting-crypto";
import type { WrappedExportKeyBundle } from "@/lib/vault/export-encrypt";
import { resolveRuntimeFrontendUrl } from "@/lib/runtime/settings";

export function protectedDocumentUrl(requestId: string): string | null {
  if (!/^[0-9a-f-]{36}$/.test(requestId)) return null;
  try {
    const origin = new URL(resolveRuntimeFrontendUrl());
    if (origin.protocol !== "https:" || origin.username || origin.password) return null;
    return new URL(`/one/documents/open?ref=${requestId}`, origin).href;
  } catch { return null; }
}

export function approvedProtectedDocumentUrl(requestId: string, hostedUrl: string | null): string | null {
  const canonical = protectedDocumentUrl(requestId);
  return canonical && (hostedUrl === `/one/documents/open?ref=${requestId}` || hostedUrl === canonical) ? canonical : null;
}

export const DOCUMENT_HOSTING_ROOT = "/api/connectors/google_drive/sharing";
export type DocumentSession = { userId: string; vaultKey: string; vaultOwnerToken: string; isCurrent: () => boolean };
export type HostingReadiness = { enabled: boolean; nativeViewerEnabled?: boolean; supportedMimeTypes: string[]; maxFileBytes: number; maxRequestCiphertextBytes: number; maxFiles: number; activityDisclosureVersion: string; copyDisclosureVersion: string };
export type HostedSourceFile = { fileRef: string; documentId: string; name: string; mimeType: string; size: number; providerFileId: string; sourceRevision: string; sourceSha256: string | null };
export type HostedApprovedFile = Pick<HostedSourceFile, "fileRef" | "name" | "mimeType" | "size">;
export type HostedSourceSelection = { requestId: string; revision: number; files: HostedSourceFile[] };
export type HostedRecipientKey = { connectorKeyId: string; connectorPublicKey: string; connectorWrappingAlg: string; publicKeyFingerprint: string };
export type HostedTermsProjection = {
  requestId: string; revision: number; receiveThrough: "one" | "both"; status: string;
  ownerUserId: string; recipientUserId: string; accessExpiresAt: string; amountCents: number | null; currency: "usd";
  recipientKey: HostedRecipientKey | null; preparationDigest: string | null; contentCommitment: string | null;
  terms: DocumentTerms | null; termsDigest: string | null; packageDigest: string | null;
  files: HostedApprovedFile[]; hostedUrl: string | null;
  generationId: string | null; sourceSelectionDigest: string | null;
  ownerSetup?: { ownerPriceRequired: boolean; ownerPayoutAccountReady: boolean; paymentsReady: boolean };
  recoveryRequested?: boolean;
  driveRevokeStatus?: string; deliverySummary?: { expected: number; confirmed: number; unsettled: number } | null;
};
export type HostedPreparationProjection = Omit<HostedTermsProjection, "files"> & { files: HostedSourceFile[] };
export type HostedPackage = { terms: DocumentTerms; termsDigest: string; packageDigest: string; preparationDigest: string; contentCommitment: string;
  artifacts: DocumentDescriptor[]; wraps: DocumentWrap[]; wrapDigests: Array<{ artifactId: string; role: string; sha256: string }>;
  interactionId: string; accessExpiresAt: string };
export type HostedOwnerPackage = Omit<HostedPackage, "interactionId"> & { originalTermsDigest: string; originalPackageDigest: string };
export type PrivateDocumentManifest = { version: 1; files: Array<{ fileRef: string; name: string; mimeType: "application/pdf"; sourceRevision: string;
  sourceSha256: string; originalArtifactId: string; watermarkedArtifactId: string; watermarkedSha256: string }> };
export type HostedDocumentActivity = { sequence: number; kind: string; createdAt: string; actorUserId?: string; country?: string | null; provenance?: string; interactionId?: string };
export type HostedDocumentActivityPage = { items: HostedDocumentActivity[]; nextCursor: string | null };
export class DocumentHostingError extends Error { constructor(readonly code: string) { super(code); this.name = "DocumentHostingError"; } }
export function requireDocumentSession(session: DocumentSession, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (!session.isCurrent()) throw new DOMException("Session changed", "AbortError");
}
const requestPath = (id: string, suffix: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new DocumentHostingError("invalid_request");
  return `${DOCUMENT_HOSTING_ROOT}/requests/${id}/delivery/${suffix}`;
};
async function send<T>(session: DocumentSession, path: string, signal?: AbortSignal, body?: unknown, method?: string, firebaseToken?: string): Promise<T> {
  requireDocumentSession(session, signal);
  const binary = body instanceof Uint8Array;
  const response = await ApiService.apiFetch(path, { method: method ?? (body === undefined ? "GET" : "POST"), cache: "no-store", signal,
    headers: { ...(firebaseToken ? { Authorization: `Bearer ${firebaseToken}`, "X-Hushh-Consent": session.vaultOwnerToken } : { Authorization: `Bearer ${session.vaultOwnerToken}` }), ...(body === undefined ? {} : { "Content-Type": binary ? "application/octet-stream" : "application/json" }) },
    isEffectCurrent: session.isCurrent, ...(body === undefined ? {} : { body: binary ? new Uint8Array(body).buffer : JSON.stringify(body) }) });
  requireDocumentSession(session, signal);
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    const code = value?.detail?.code;
    throw new DocumentHostingError(typeof code === "string" && /^[A-Za-z_]{1,90}$/.test(code) ? code : "document_unavailable");
  }
  const result = await response.json() as T;
  requireDocumentSession(session, signal);
  return result;
}
/** Authority mutations invalidate their owner's Feed and consent projections, including standalone readers. */
async function sendConsentMutation<T>(session: DocumentSession, path: string, signal: AbortSignal | undefined, body: unknown, method?: string, firebaseToken?: string): Promise<T> {
  const result = await send<T>(session, path, signal, body, method, firebaseToken);
  requireDocumentSession(session, signal);
  CacheSyncService.onConsentMutated(session.userId);
  return result;
}
export const DocumentHostingService = {
  readiness: (session: DocumentSession, signal?: AbortSignal) => send<HostingReadiness>(session, `${DOCUMENT_HOSTING_ROOT}/delivery-readiness`, signal),
  create: (session: DocumentSession, body: Record<string, unknown>, signal?: AbortSignal, firebaseToken?: string) => sendConsentMutation<{ requestId: string; delivery: HostedTermsProjection }>(session, `${DOCUMENT_HOSTING_ROOT}/delivery-requests`, signal, body, "POST", firebaseToken),
  terms: (session: DocumentSession, requestId: string, signal?: AbortSignal) => send<HostedTermsProjection>(session, requestPath(requestId, "terms"), signal),
  sourceSelection: (session: DocumentSession, requestId: string, signal?: AbortSignal) => send<HostedSourceSelection>(session, requestPath(requestId, "source-selection"), signal),
  approve: <const Body extends Record<string, unknown>>(session: DocumentSession, requestId: string, body: Body, signal?: AbortSignal) => sendConsentMutation<Body extends { phase: "prepare" } ? HostedPreparationProjection : HostedTermsProjection>(session, requestPath(requestId, "approve"), signal, body),
  sourceSession: (session: DocumentSession, requestId: string, expectedRevision: number, signal?: AbortSignal) => send<{ accessToken: string; tokenExpiresAt: string; expiresAt: string; requestId: string; revision: number; sourceSelectionDigest: string; connectionGeneration: number }>(session, requestPath(requestId, "source-session"), signal, { expectedRevision }),
  recipientKey: (session: DocumentSession, requestId: string, signal?: AbortSignal) => send<HostedRecipientKey>(session, requestPath(requestId, "recipient-key"), signal),
  recoveryRecipientKey: (session: DocumentSession, requestId: string, signal?: AbortSignal) => send<HostedRecipientKey>(session, requestPath(requestId, "recipient-key?purpose=recovery"), signal),
  ownerPackage: (session: DocumentSession, requestId: string, signal?: AbortSignal) => send<HostedOwnerPackage>(session, requestPath(requestId, "owner-package"), signal),
  recoveryAmendment: (session: DocumentSession, requestId: string, body: Record<string, unknown>, signal?: AbortSignal) => sendConsentMutation<HostedTermsProjection>(session, requestPath(requestId, "recovery-amendment"), signal, body),
  challenge: <T>(session: DocumentSession, requestId: string, body: Record<string, unknown>, signal?: AbortSignal) => send<T>(session, requestPath(requestId, "key-challenge"), signal, body),
  async upload(session: DocumentSession, requestId: string, expectedRevision: number, descriptor: DocumentDescriptor, ciphertext: Uint8Array, signal?: AbortSignal): Promise<void> {
    const upload = await send<{ uploadId: string }>(session, requestPath(requestId, "uploads"), signal, { expectedRevision, idempotencyKey: crypto.randomUUID(), descriptor });
    await send(session, requestPath(requestId, `uploads/${encodeURIComponent(upload.uploadId)}`), signal, ciphertext, "PUT");
    await send(session, requestPath(requestId, `uploads/${encodeURIComponent(upload.uploadId)}/finalize`), signal, {});
  },
  stagePackage: (session: DocumentSession, requestId: string, body: Record<string, unknown>, signal?: AbortSignal) => sendConsentMutation<HostedTermsProjection>(session, requestPath(requestId, "package"), signal, body),
  package: (session: DocumentSession, requestId: string, signal?: AbortSignal) => send<HostedPackage>(session, requestPath(requestId, "package"), signal),
  async artifact(session: DocumentSession, requestId: string, artifactId: string, signal?: AbortSignal): Promise<Uint8Array> {
    requireDocumentSession(session, signal);
    const response = await ApiService.apiFetch(requestPath(requestId, `artifacts/${encodeURIComponent(artifactId)}`), {
      cache: "no-store", signal, responseType: "arraybuffer", headers: { Authorization: `Bearer ${session.vaultOwnerToken}` }, isEffectCurrent: session.isCurrent });
    requireDocumentSession(session, signal);
    if (!response.ok) throw new DocumentHostingError("document_unavailable");
    const declared = Number(response.headers.get("content-length"));
    if (declared > 4 * 1024 * 1024 + 128 * 1024) { await response.body?.cancel(); throw new DocumentHostingError("document_size_invalid"); }
    if (!response.body) throw new DocumentHostingError("document_unavailable");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    let bytes: Uint8Array;
    try {
      for (;;) {
        requireDocumentSession(session, signal);
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.length;
        if (length > 4 * 1024 * 1024 + 128 * 1024) { chunk.value.fill(0); throw new DocumentHostingError("document_size_invalid"); }
        chunks.push(chunk.value);
      }
      bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    } finally { chunks.forEach(chunk => chunk.fill(0)); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    try { requireDocumentSession(session, signal); if (bytes.length > 4 * 1024 * 1024 + 128 * 1024) throw new DocumentHostingError("document_size_invalid"); return bytes; }
    catch (cause) { bytes.fill(0); throw cause; }
  },
  activity: (session: DocumentSession, requestId: string, body: { interactionId: string; artifactId: string; eventId: string;
    kind: "preview_rendered" | "decrypt_failed" | "download_requested" | "handoff_reported"; outcome: "success" | "cancelled" | "failed" }, signal?: AbortSignal) => send(session, requestPath(requestId, "activity"), signal, body),
  async timeline(session: DocumentSession, requestId: string, signal?: AbortSignal, cursor = "0"): Promise<HostedDocumentActivityPage> {
    if (!/^(0|[1-9][0-9]{0,15})$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new DocumentHostingError("document_activity_cursor_invalid");
    const page = await send<HostedDocumentActivityPage>(session, requestPath(requestId, `activity?cursor=${cursor}`), signal);
    if (!Array.isArray(page.items) || page.items.length > 50) throw new DocumentHostingError("document_activity_invalid");
    let previous = Number(cursor);
    for (const item of page.items) {
      if (!Number.isSafeInteger(item.sequence) || item.sequence <= previous || typeof item.kind !== "string" || !Number.isFinite(Date.parse(item.createdAt))) throw new DocumentHostingError("document_activity_invalid");
      previous = item.sequence;
    }
    if (page.nextCursor !== null && (page.items.length !== 50 || page.nextCursor !== String(previous))) throw new DocumentHostingError("document_activity_cursor_invalid");
    requireDocumentSession(session, signal);
    return page;
  },
  revoke: (session: DocumentSession, requestId: string, expectedRevision: number, scope: "one" | "drive" | "both", signal?: AbortSignal) => sendConsentMutation<HostedTermsProjection>(session, requestPath(requestId, "revoke"), signal, { expectedRevision, scope, idempotencyKey: crypto.randomUUID() }),
};
export type DocumentKeyChallenge = { phase: "issued"; challengeId: string; bundle: WrappedExportKeyBundle; expiresAt: string };
