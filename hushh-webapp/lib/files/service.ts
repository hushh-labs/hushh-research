"use client";
import { ApiService } from "@/lib/services/api-service";

export type FileEntry = {
  id: string;
  name: string;
  originalName: string;
  parent: string;
  kind: "file" | "folder";
  size: number;
  received: number;
  receivedHash: string;
  state: "uploading" | "ready" | "trashed";
  revision: number;
  organization?: { state: string; code?: string };
};
export type FilesPage = {
  entries: FileEntry[];
  cursor: string;
  chunkBytes: number;
};
export type FilesSettings = {
  retention?: {
    retentionSeconds: number;
    retentionLocked: boolean;
    softDeleteSeconds: number;
    versioning: boolean;
    physicalDeletion: string;
  };
  revision: number;
  analysis: boolean;
  automatic: boolean;
  excluded: string[];
  backgroundAvailable?: boolean;
  backgroundProvider?: string;
};
export type OrganizationJob = {
  id: string;
  state: string;
  result?: { state: string; explanation: string };
  history?: Array<{ state: string; result?: { explanation: string } }>;
};

async function json<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await ApiService.ownerPodRequest(`files/${path}`, {
    method,
    signal,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(
      result?.detail?.code ?? `FILES_UNAVAILABLE:${response.status}`,
    );
  }
  return response.json() as Promise<T>;
}

export const FilesService = {
  history: (cursor = "", signal?: AbortSignal) =>
    json<{ entries: OrganizationJob[]; cursor: string }>(
      `jobs?${new URLSearchParams({ cursor })}`,
      undefined,
      "GET",
      signal,
    ),
  job: (fileId: string, signal?: AbortSignal) =>
    json<OrganizationJob>(
      `jobs?${new URLSearchParams({ file_id: fileId })}`,
      undefined,
      "GET",
      signal,
    ),
  organize: (fileId: string, cancel = false, signal?: AbortSignal) =>
    json<OrganizationJob>(
      "jobs",
      { file_id: fileId, cancel, request_id: crypto.randomUUID() },
      "POST",
      signal,
    ),
  usagePage: (cursor = "", signal?: AbortSignal) =>
    json<{ bytes: number; files: number; cursor: string }>(
      `usage?${new URLSearchParams({ cursor })}`,
      undefined,
      "GET",
      signal,
    ),
  list: (parent: string, cursor = "", trash = false, signal?: AbortSignal) =>
    json<FilesPage>(
      `list?${new URLSearchParams({ parent, cursor, trash: String(trash) })}`,
      undefined,
      "GET",
      signal,
    ),
  settings: (signal?: AbortSignal) =>
    json<FilesSettings>("settings", undefined, "GET", signal),
  configure: (settings: FilesSettings, signal?: AbortSignal) =>
    json<FilesSettings>("settings", settings, "PUT", signal),
  createFolder: (name: string, parent: string, signal?: AbortSignal) =>
    json<FileEntry>(
      "create",
      { name, parent, size: 0, folder: true, request_id: crypto.randomUUID() },
      "POST",
      signal,
    ),
  mutate: (
    entry: FileEntry,
    operation: string,
    fields: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) =>
    json<FileEntry>(
      "mutate",
      { file_id: entry.id, revision: entry.revision, operation, ...fields },
      "POST",
      signal,
    ),
  async upload(
    file: File,
    parent: string,
    onProgress: (received: number) => void,
    signal: AbortSignal,
    resume?: FileEntry,
  ): Promise<FileEntry> {
    const entry =
      resume ??
      (await json<FileEntry>(
        "create",
        {
          name: file.name,
          parent,
          size: file.size,
          request_id: crypto.randomUUID(),
        },
        "POST",
        signal,
      ));
    if (entry.size !== file.size || entry.originalName !== file.name)
      throw new Error("Choose the original file to resume this upload.");
    const chunkBytes = 4 * 1024 * 1024;
    // Verify the accepted prefix locally without retransmitting stored bytes.
    let chain = new Uint8Array(32);
    for (let offset = 0; offset < entry.received; offset += chunkBytes) {
      signal.throwIfAborted();
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          await file
            .slice(offset, Math.min(entry.received, offset + chunkBytes))
            .arrayBuffer(),
        ),
      );
      const input = new Uint8Array(64);
      input.set(chain);
      input.set(digest, 32);
      chain = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    }
    if (
      Array.from(chain, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ) !== entry.receivedHash
    )
      throw new Error(
        "This file does not match the uploaded portion. Choose the original file.",
      );
    onProgress(entry.received);
    for (
      let offset = entry.received;
      offset < file.size;
      offset += chunkBytes
    ) {
      signal.throwIfAborted();
      const response = await ApiService.ownerPodRequest(
        `files/chunk?${new URLSearchParams({ file_id: entry.id, index: String(offset / chunkBytes) })}`,
        {
          method: "PUT",
          body: file.slice(offset, offset + chunkBytes),
          signal,
          headers: { "Content-Type": "application/octet-stream" },
        },
      );
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(
          result?.detail?.code ??
            "Upload paused. Select the same file to resume.",
        );
      }
      onProgress(Math.min(file.size, offset + chunkBytes));
    }
    return json<FileEntry>("complete", { file_id: entry.id }, "POST", signal);
  },
  async download(
    entry: FileEntry,
    signal: AbortSignal,
    resume?: DownloadCheckpoint,
  ): Promise<void> {
    const picker = (
      window as unknown as {
        showSaveFilePicker?: (options: {
          suggestedName: string;
        }) => Promise<DownloadHandle>;
      }
    ).showSaveFilePicker;
    if (!picker && entry.size > 32 * 1024 * 1024)
      throw new Error(
        "Use a browser with direct file saving for this large download.",
      );
    if (
      resume &&
      (resume.fileId !== entry.id ||
        resume.size !== entry.size ||
        resume.contentHash !== entry.receivedHash)
    )
      throw new Error("The download no longer matches this file.");
    const handle =
      resume?.handle ??
      (picker ? await picker({ suggestedName: entry.name }) : null);
    let chain = new Uint8Array(32);
    let offset = resume?.offset ?? 0;
    if (resume) {
      const saved = await resume.handle.getFile();
      if (saved.size !== offset)
        throw new Error("The partial download changed. Start a new download.");
      for (let position = 0; position < offset; position += CHUNK_BYTES) {
        signal.throwIfAborted();
        chain = await hashChunk(
          chain,
          await saved
            .slice(position, Math.min(offset, position + CHUNK_BYTES))
            .arrayBuffer(),
        );
      }
      if (hex(chain) !== resume.prefixHash)
        throw new Error("The partial download changed. Start a new download.");
    }
    const writer = handle
      ? await handle.createWritable({ keepExistingData: Boolean(resume) })
      : null;
    const chunks: BlobPart[] = [];
    try {
      if (writer && offset) await writer.seek(offset);
      for (; offset < entry.size;) {
        signal.throwIfAborted();
        const response = await ApiService.ownerPodRequest(
          `files/chunk?${new URLSearchParams({ file_id: entry.id, index: String(offset / CHUNK_BYTES) })}`,
          { signal },
        );
        if (!response.ok)
          throw new Error("Download interrupted. Resume to continue.");
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== Math.min(CHUNK_BYTES, entry.size - offset))
          throw new Error("The download chunk was incomplete.");
        const nextHash = await hashChunk(chain, bytes);
        if (writer) await writer.write(new Uint8Array(bytes));
        else chunks.push(bytes);
        chain = nextHash;
        offset += bytes.byteLength;
      }
      if (hex(chain) !== entry.receivedHash)
        throw new Error("The downloaded file failed its integrity check.");
      if (writer) await writer.close();
      else {
        const url = URL.createObjectURL(
          new Blob(chunks, { type: "application/octet-stream" }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = entry.name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      if (writer && handle && offset < entry.size && !signal.aborted) {
        try {
          await writer.close();
        } catch {
          await writer.abort().catch(() => undefined);
          throw error;
        }
        throw new DownloadPaused({
          handle,
          fileId: entry.id,
          size: entry.size,
          contentHash: entry.receivedHash,
          offset,
          prefixHash: hex(chain),
        });
      }
      await writer?.abort().catch(() => undefined);
      throw error;
    }
  },
};

const CHUNK_BYTES = 4 * 1024 * 1024;
interface DownloadWriter {
  write(value: Uint8Array): Promise<void>;
  seek(position: number): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface DownloadHandle {
  getFile(): Promise<File>;
  createWritable(options: {
    keepExistingData: boolean;
  }): Promise<DownloadWriter>;
}
export type DownloadCheckpoint = {
  handle: DownloadHandle;
  fileId: string;
  size: number;
  contentHash: string;
  offset: number;
  prefixHash: string;
};
export class DownloadPaused extends Error {
  constructor(public readonly checkpoint: DownloadCheckpoint) {
    super(
      "Download paused. Keep this page open and choose Resume download to continue.",
    );
  }
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
async function hashChunk(
  chain: Uint8Array,
  bytes: ArrayBuffer,
): Promise<Uint8Array<ArrayBuffer>> {
  const value = new Uint8Array(64);
  value.set(chain);
  value.set(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), 32);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}
