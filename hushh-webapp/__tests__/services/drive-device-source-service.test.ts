// @vitest-environment node
import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
import { DriveDeviceSourceService } from "@/lib/services/drive-device-source-service";
import type { HostedSourceFile } from "@/lib/services/document-hosting-service";
beforeAll(() => { vi.stubGlobal("crypto", webcrypto); });
describe("@feature_one_document_hosting direct source boundary", () => {
  const bytes = new TextEncoder().encode("%PDF-synthetic-private-sentinel");
  const file: HostedSourceFile = { fileRef: "file", documentId: "document", providerFileId: "provider-file", name: "source.pdf", mimeType: "application/pdf", size: bytes.length, sourceRevision: "7", sourceSha256: null };
  const credential = { accessToken: "synthetic-token", tokenExpiresAt: "2099-01-01T00:00:00Z" };
  const metadata = { id: file.providerFileId, name: file.name, mimeType: file.mimeType, size: String(bytes.length), version: "7", headRevisionId: "rev7", capabilities: { canDownload: true }, trashed: false };
  it("reads original bytes only from the fixed provider and rejects a source revision change", async () => {
    const transport = vi.fn().mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(Response.json(metadata));
    vi.stubGlobal("fetch", transport);
    expect(await DriveDeviceSourceService.pdf(file, credential, new AbortController().signal, () => true)).toEqual(bytes);
    for (const [url, init] of transport.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/provider-file\?/);
      expect(init.credentials).toBe("omit");
      expect(init.body).toBeUndefined();
    }
    transport.mockReset().mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(Response.json({ ...metadata, version: "8" }));
    await expect(DriveDeviceSourceService.pdf(file, credential, new AbortController().signal, () => true)).rejects.toThrow("document_source_changed");
  });
  it("does not read any source after consent/session authority has ended", async () => {
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    await expect(DriveDeviceSourceService.pdf(file, credential, new AbortController().signal, () => false)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
