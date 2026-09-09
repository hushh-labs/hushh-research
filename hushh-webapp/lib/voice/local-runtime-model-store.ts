import {
  isVoiceModelPackManifest,
  type VoiceModelPackManifest,
} from "./local-runtime-contract";
import { emitLocalRuntimeEvent, type LocalRuntimeObserver } from "./local-runtime-observability";

const MODEL_CACHE_NAME = "one-voice-model-packs-v1";
const ACTIVE_PACK_STORE = "one-voice-active-packs-v1";
const ACTIVE_PACK_DB = "one-voice-runtime-v1";
const PREVIOUS_PACK_PREFIX = "previous:";

export type ModelPackStorage = {
  read(key: string): Promise<ArrayBuffer | null>;
  write(key: string, value: ArrayBuffer): Promise<void>;
  remove(key: string): Promise<void>;
};

type ActivePackMetadataStorage = {
  get(packId: string): Promise<string | null>;
  set(packId: string, version: string): Promise<void>;
  remove(packId: string): Promise<void>;
};

class MemoryModelPackStorage implements ModelPackStorage {
  private readonly values = new Map<string, ArrayBuffer>();

  async read(key: string): Promise<ArrayBuffer | null> {
    const value = this.values.get(key);
    return value ? value.slice(0) : null;
  }

  async write(key: string, value: ArrayBuffer): Promise<void> {
    this.values.set(key, value.slice(0));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class BrowserCacheModelPackStorage implements ModelPackStorage {
  private readonly fallback = new MemoryModelPackStorage();

  async read(key: string): Promise<ArrayBuffer | null> {
    const cacheStorage = globalThis.caches;
    if (!cacheStorage) return this.fallback.read(key);
    const response = await (await cacheStorage.open(MODEL_CACHE_NAME)).match(
      this.requestFor(key),
    );
    return response ? response.arrayBuffer() : null;
  }

  async write(key: string, value: ArrayBuffer): Promise<void> {
    const cacheStorage = globalThis.caches;
    if (!cacheStorage) {
      await this.fallback.write(key, value);
      return;
    }
    await (
      await cacheStorage.open(MODEL_CACHE_NAME)
    ).put(this.requestFor(key), new Response(value.slice(0)));
  }

  async remove(key: string): Promise<void> {
    const cacheStorage = globalThis.caches;
    if (!cacheStorage) {
      await this.fallback.remove(key);
      return;
    }
    await (await cacheStorage.open(MODEL_CACHE_NAME)).delete(this.requestFor(key));
  }

  private requestFor(key: string): Request {
    return new Request(`https://local-model.invalid/${encodeURIComponent(key)}`);
  }
}

class MemoryActivePackMetadataStorage implements ActivePackMetadataStorage {
  private readonly values = new Map<string, string>();

  async get(packId: string): Promise<string | null> {
    return this.values.get(packId) ?? null;
  }

  async set(packId: string, version: string): Promise<void> {
    this.values.set(packId, version);
  }

  async remove(packId: string): Promise<void> {
    this.values.delete(packId);
  }
}

class IndexedDbActivePackMetadataStorage
  implements ActivePackMetadataStorage
{
  private readonly fallback = new MemoryActivePackMetadataStorage();
  private databasePromise: Promise<IDBDatabase | null> | null = null;

  async get(packId: string): Promise<string | null> {
    const database = await this.open();
    if (!database) return this.fallback.get(packId);
    return this.run<string | null>(database, "readonly", (store) =>
      this.requestValue(store.get(packId)),
    );
  }

  async set(packId: string, version: string): Promise<void> {
    const database = await this.open();
    if (!database) {
      await this.fallback.set(packId, version);
      return;
    }
    await this.run<void>(database, "readwrite", (store) => {
      const request = store.put(version, packId);
      return new Promise<void>((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error("idb_write_failed"));
      });
    });
  }

  async remove(packId: string): Promise<void> {
    const database = await this.open();
    if (!database) {
      await this.fallback.remove(packId);
      return;
    }
    await this.run<void>(database, "readwrite", (store) => {
      const request = store.delete(packId);
      return new Promise<void>((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error("idb_delete_failed"));
      });
    });
  }

  private async open(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === "undefined") return null;
    if (!this.databasePromise) {
      this.databasePromise = new Promise<IDBDatabase | null>((resolve) => {
        const request = indexedDB.open(ACTIVE_PACK_DB, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(ACTIVE_PACK_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
    }
    return this.databasePromise;
  }

  private run<T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const transaction = database.transaction(ACTIVE_PACK_STORE, mode);
    return operation(transaction.objectStore(ACTIVE_PACK_STORE));
  }

  private requestValue<T>(request: IDBRequest<T>): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("idb_read_failed"));
    });
  }
}

export class LocalModelPackStore {
  private readonly storage: ModelPackStorage;
  private readonly metadata: ActivePackMetadataStorage;

  constructor(options?: {
    storage?: ModelPackStorage;
    metadata?: ActivePackMetadataStorage;
    observer?: LocalRuntimeObserver;
  }) {
    this.storage = options?.storage ?? new BrowserCacheModelPackStorage();
    this.metadata = options?.metadata ?? new IndexedDbActivePackMetadataStorage();
    this.observer = options?.observer;
  }

  private readonly observer?: LocalRuntimeObserver;

  async install(
    manifest: VoiceModelPackManifest,
    options?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
  ): Promise<void> {
    if (!isVoiceModelPackManifest(manifest)) {
      throw new Error("model_pack_manifest_invalid");
    }
    const startedAt = performance.now();
    this.observe({
      event: "model_pack_download_started",
      packId: manifest.pack_id,
      packVersion: manifest.version,
      byteCount: manifest.size_bytes,
    });
    const fetchImpl = options?.fetchImpl ?? fetch;
    const stagingKey = this.stagingKey(manifest);
    let existing = (await this.storage.read(stagingKey)) ?? new ArrayBuffer(0);
    let response = await fetchImpl(manifest.artifact_url, {
      headers: existing.byteLength ? { Range: `bytes=${existing.byteLength}-` } : {},
      cache: "no-store",
      signal: options?.signal,
    });

    if (!response.ok) {
      this.observe({
        event: "model_pack_download_failed",
        packId: manifest.pack_id,
        packVersion: manifest.version,
        reason: "http_status",
        elapsedMs: performance.now() - startedAt,
      });
      throw new Error("model_pack_download_failed");
    }
    if (existing.byteLength && response.status !== 206) {
      existing = new ArrayBuffer(0);
      response = await fetchImpl(manifest.artifact_url, {
        cache: "no-store",
        signal: options?.signal,
      });
      if (!response.ok) {
        this.observe({
          event: "model_pack_download_failed",
          packId: manifest.pack_id,
          packVersion: manifest.version,
          reason: "resume_restart_failed",
          elapsedMs: performance.now() - startedAt,
        });
        throw new Error("model_pack_download_failed");
      }
    }
    if (existing.byteLength && !hasExpectedRangeStart(response, existing.byteLength)) {
      existing = new ArrayBuffer(0);
      response = await fetchImpl(manifest.artifact_url, {
        cache: "no-store",
        signal: options?.signal,
      });
      if (!response.ok || response.status !== 200) {
        this.observe({
          event: "model_pack_download_failed",
          packId: manifest.pack_id,
          packVersion: manifest.version,
          reason: "range_restart_failed",
          elapsedMs: performance.now() - startedAt,
        });
        throw new Error("model_pack_download_failed");
      }
    }

    const downloaded = await this.readResponse(response, existing, async (value) => {
      await this.storage.write(stagingKey, value);
    });
    if (downloaded.byteLength !== manifest.size_bytes) {
      this.observe({
        event: "model_pack_download_failed",
        packId: manifest.pack_id,
        packVersion: manifest.version,
        reason: "size_mismatch",
        elapsedMs: performance.now() - startedAt,
      });
      throw new Error("model_pack_size_mismatch");
    }
    if (!(await hasSha256(downloaded, manifest.checksum))) {
      await this.storage.remove(stagingKey);
      this.observe({
        event: "model_pack_download_failed",
        packId: manifest.pack_id,
        packVersion: manifest.version,
        reason: "checksum_mismatch",
        elapsedMs: performance.now() - startedAt,
      });
      throw new Error("model_pack_checksum_mismatch");
    }

    // The verified artifact is copied to its immutable key only after the
    // complete checksum succeeds. The active pointer changes separately.
    await this.storage.write(this.packKey(manifest), downloaded);
    await this.storage.remove(stagingKey);
    this.observe({
      event: "model_pack_download_completed",
      packId: manifest.pack_id,
      packVersion: manifest.version,
      byteCount: downloaded.byteLength,
      elapsedMs: performance.now() - startedAt,
    });
  }

  async activate(manifest: VoiceModelPackManifest): Promise<void> {
    const bytes = await this.readInstalled(manifest);
    if (!bytes) throw new Error("model_pack_not_installed");
    const current = await this.metadata.get(manifest.pack_id);
    if (current && current !== manifest.version) {
      await this.metadata.set(this.previousKey(manifest.pack_id), current);
    }
    await this.metadata.set(manifest.pack_id, manifest.version);
    this.observe({
      event: "model_pack_activation_completed",
      packId: manifest.pack_id,
      packVersion: manifest.version,
    });
  }

  async rollback(
    packId: string,
    manifests: readonly VoiceModelPackManifest[],
  ): Promise<string | null> {
    const previous = await this.metadata.get(this.previousKey(packId));
    if (!previous) return null;
    const manifest = manifests.find(
      (candidate) => candidate.pack_id === packId && candidate.version === previous,
    );
    if (!manifest || !(await this.hasInstalled(manifest))) {
      await this.metadata.remove(this.previousKey(packId));
      return null;
    }
    await this.metadata.set(packId, previous);
    await this.metadata.remove(this.previousKey(packId));
    this.observe({
      event: "model_pack_rollback_completed",
      packId,
      packVersion: previous,
    });
    return previous;
  }

  async getActive(packId: string): Promise<string | null> {
    return this.metadata.get(packId);
  }

  async hasInstalled(manifest: VoiceModelPackManifest): Promise<boolean> {
    const bytes = await this.storage.read(this.packKey(manifest));
    if (!bytes || bytes.byteLength !== manifest.size_bytes) return false;
    return hasSha256(bytes, manifest.checksum);
  }

  async readInstalled(manifest: VoiceModelPackManifest): Promise<ArrayBuffer | null> {
    const bytes = await this.storage.read(this.packKey(manifest));
    if (!bytes || bytes.byteLength !== manifest.size_bytes) return null;
    if (!(await hasSha256(bytes, manifest.checksum))) return null;
    return bytes;
  }

  async remove(manifest: VoiceModelPackManifest): Promise<void> {
    await this.storage.remove(this.packKey(manifest));
    if ((await this.metadata.get(manifest.pack_id)) === manifest.version) {
      await this.metadata.remove(manifest.pack_id);
    }
  }

  private packKey(manifest: VoiceModelPackManifest): string {
    return `pack:${manifest.pack_id}:${manifest.version}`;
  }

  private stagingKey(manifest: VoiceModelPackManifest): string {
    return `staging:${manifest.pack_id}:${manifest.version}`;
  }

  private previousKey(packId: string): string {
    return `${PREVIOUS_PACK_PREFIX}${packId}`;
  }

  private observe(event: Parameters<LocalRuntimeObserver>[0]): void {
    this.observer?.(event);
    if (!this.observer) emitLocalRuntimeEvent(event);
  }

  private async readResponse(
    response: Response,
    prefix: ArrayBuffer,
    checkpoint: (value: ArrayBuffer) => Promise<void>,
  ): Promise<ArrayBuffer> {
    if (!response.body) {
      const body = await response.arrayBuffer();
      const combined = concatBuffers(prefix, body);
      await checkpoint(combined);
      return combined;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [new Uint8Array(prefix)];
    let total = prefix.byteLength;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!next.value?.byteLength) continue;
        chunks.push(next.value);
        total += next.value.byteLength;
        await checkpoint(concatChunks(chunks, total));
      }
    } finally {
      reader.releaseLock();
    }
    return concatChunks(chunks, total);
  }
}

function concatBuffers(left: ArrayBuffer, right: ArrayBuffer): ArrayBuffer {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(new Uint8Array(left), 0);
  result.set(new Uint8Array(right), left.byteLength);
  return result.buffer;
}

function concatChunks(chunks: readonly Uint8Array[], total: number): ArrayBuffer {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

function hasExpectedRangeStart(response: Response, expectedStart: number): boolean {
  const contentRange = response.headers.get("Content-Range")?.trim() ?? "";
  const match = contentRange.match(/^bytes\s+(\d+)-\d+\/\d+$/i);
  return match ? Number(match[1]) === expectedStart : false;
}

async function hasSha256(bytes: ArrayBuffer, expected: string): Promise<boolean> {
  if (!globalThis.crypto?.subtle) throw new Error("sha256_unavailable");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const actualHex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const normalized = expected.trim().toLowerCase();
  if (normalized === actualHex) return true;
  const digestBytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of digestBytes) binary += String.fromCharCode(byte);
  const actualBase64 =
    typeof btoa === "function"
      ? btoa(binary)
      : typeof Buffer !== "undefined"
        ? Buffer.from(digestBytes).toString("base64")
        : "";
  return normalized === actualBase64.toLowerCase();
}

export function createMemoryModelPackStore(): {
  store: LocalModelPackStore;
  storage: ModelPackStorage;
  metadata: ActivePackMetadataStorage;
} {
  const storage = new MemoryModelPackStorage();
  const metadata = new MemoryActivePackMetadataStorage();
  return { store: new LocalModelPackStore({ storage, metadata }), storage, metadata };
}
