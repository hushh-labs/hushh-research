import { Capacitor } from "@capacitor/core";
import { DOCUMENT_FILE_LIMIT, canonicalDocumentJson, documentHash } from "@/lib/consent/document-hosting-crypto";
import type { HostedSourceFile } from "./document-hosting-service";

export type DriveDeviceCredential = { accessToken: string; tokenExpiresAt: string };
const ROOT = "https://www.googleapis.com/drive/v3/files/";
function requireActive(credential: DriveDeviceCredential, signal: AbortSignal, isCurrent: () => boolean): void {
  signal.throwIfAborted();
  if (Capacitor.isNativePlatform()) throw new Error("document_prepare_browser_required");
  if (!isCurrent() || !credential.accessToken || !Number.isFinite(Date.parse(credential.tokenExpiresAt)) || Date.parse(credential.tokenExpiresAt) <= Date.now()) throw new DOMException("Source session expired", "AbortError");
}
async function bounded(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error(response.status === 403 ? "document_download_restricted" : "document_source_unavailable");
  const declared = Number(response.headers.get("content-length"));
  if (declared > maximum) { await response.body.cancel(); throw new Error("document_size_invalid"); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maximum) { chunk.value.fill(0); throw new Error("document_size_invalid"); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally { chunks.forEach(chunk => chunk.fill(0)); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
/** The authorized owner device talks DIRECTLY to Google's fixed media API. No One relay. */
export const DriveDeviceSourceService = {
  async pdf(file: HostedSourceFile, credential: DriveDeviceCredential, signal: AbortSignal, isCurrent: () => boolean): Promise<Uint8Array> {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(file.providerFileId) || file.mimeType !== "application/pdf" || file.size < 1 || file.size > DOCUMENT_FILE_LIMIT)
      throw new Error("document_pdf_unsupported");
    const request = async (query: string) => {
      requireActive(credential, signal, isCurrent);
      return fetch(`${ROOT}${encodeURIComponent(file.providerFileId)}?${query}`, { signal, cache: "no-store", credentials: "omit", redirect: "error",
        referrerPolicy: "no-referrer", headers: { Authorization: `Bearer ${credential.accessToken}` } });
    };
    const metadata = async () => {
      const bytes = await bounded(await request("fields=id,name,mimeType,size,version,headRevisionId,sha256Checksum,capabilities(canDownload),trashed&supportsAllDrives=true"), 16 * 1024, signal);
      try {
        requireActive(credential, signal, isCurrent);
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
        const capabilities = value.capabilities as { canDownload?: boolean } | undefined;
        if (value.id !== file.providerFileId || value.trashed !== false || capabilities?.canDownload !== true) throw new Error("document_download_restricted");
        if (value.mimeType !== file.mimeType || Number(value.size) !== file.size || (value.headRevisionId !== file.sourceRevision && value.version !== file.sourceRevision)) throw new Error("document_source_changed");
        return value;
      } finally { bytes.fill(0); }
    };
    const before = await metadata();
    const bytes = await bounded(await request("alt=media&supportsAllDrives=true"), DOCUMENT_FILE_LIMIT, signal);
    try {
      requireActive(credential, signal, isCurrent);
      const after = await metadata();
      const hash = await documentHash(bytes);
      if (bytes.length !== file.size || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-" ||
          canonicalDocumentJson(before) !== canonicalDocumentJson(after) || file.sourceSha256 && hash !== file.sourceSha256 ||
          typeof before.sha256Checksum === "string" && hash !== before.sha256Checksum)
        throw new Error("document_source_changed");
      return bytes;
    } catch (cause) { bytes.fill(0); throw cause; }
  },
};
