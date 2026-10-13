"use client";

import { decryptExport, encryptForExport } from "@/lib/vault/export-encrypt";
import { openSecureResourceDb, DURABLE_GENERATION_STORE, DURABLE_RESOURCE_STORE } from "./secure-resource-cache-service";

type Envelope = {
  key: string; userId: string; resourceKey: string; generation: number; revision: number;
  payload: Awaited<ReturnType<typeof encryptForExport>>;
};
export type DurableVersion = { generation: number; revision: number };
const keyOf = (userId: string, resourceKey: string) => JSON.stringify([userId, resourceKey]);
const aad = (e: Omit<Envelope, "payload">) => JSON.stringify(["owner-durable-resource.v1", e.userId, e.resourceKey, e.generation, e.revision]);
const resetListeners = new Set<(owner: string) => void>();
let resetChannel: BroadcastChannel | null = null;
export function subscribeDurableOwnerReset(listener: (owner: string) => void): () => void {
  resetListeners.add(listener);
  if (!resetChannel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    resetChannel = new BroadcastChannel("hussh-owner-durable-reset.v1");
    resetChannel.onmessage = event => {
      if (typeof event.data === "string" && event.data.length <= 200)
        for (const callback of resetListeners) callback(event.data);
    };
  }
  return () => { resetListeners.delete(listener); if (!resetListeners.size) { resetChannel?.close(); resetChannel = null; } };
}
function notifyReset(owner: string) {
  for (const listener of resetListeners) listener(owner);
  if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    const channel = resetChannel ?? new BroadcastChannel("hussh-owner-durable-reset.v1");
    channel.postMessage(owner);
    if (!resetChannel) channel.close();
  }
}
async function database() {
  const db = await openSecureResourceDb();
  if (!db) throw new Error("Encrypted device storage is unavailable.");
  return db;
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Encrypted storage transaction did not commit."));
  });
}
function get<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Durable resources have explicit deletion, never a cache TTL. No keys or plaintext on disk. */
export class SecureDurableResourceService {
  static async version(userId: string, resourceKey: string): Promise<DurableVersion> {
    const db = await database();
    try {
      const tx = db.transaction([DURABLE_RESOURCE_STORE, DURABLE_GENERATION_STORE], "readonly");
      const done = completed(tx);
      const [generation, record] = await Promise.all([
        get<number>(tx.objectStore(DURABLE_GENERATION_STORE), userId),
        get<Envelope>(tx.objectStore(DURABLE_RESOURCE_STORE), keyOf(userId, resourceKey)),
      ]);
      await done;
      return { generation: generation ?? 0, revision: record?.revision ?? 0 };
    } finally { db.close(); }
  }
  static async list(userId: string, prefix: string): Promise<string[]> {
    const db = await database();
    try {
      const tx = db.transaction(DURABLE_RESOURCE_STORE, "readonly");
      const done = completed(tx);
      const records = await new Promise<Envelope[]>((resolve, reject) => {
        const request = tx.objectStore(DURABLE_RESOURCE_STORE).index("userId").getAll(userId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await done;
      return records.filter(e => e.resourceKey.startsWith(prefix)).map(e => e.resourceKey);
    } finally { db.close(); }
  }
  static async read<T>(userId: string, resourceKey: string, vaultKey: string): Promise<(DurableVersion & { value: T }) | null> {
    const db = await database();
    let e: Envelope | undefined;
    try {
      const tx = db.transaction(DURABLE_RESOURCE_STORE, "readonly");
      const done = completed(tx);
      e = await get<Envelope>(tx.objectStore(DURABLE_RESOURCE_STORE), keyOf(userId, resourceKey));
      await done;
    } finally { db.close(); }
    if (!e) return null;
    if (e.userId !== userId || e.resourceKey !== resourceKey || e.key !== keyOf(userId, resourceKey))
      throw new Error("Encrypted resource binding is invalid.");
    const value = JSON.parse(await decryptExport(e.payload.ciphertext, e.payload.iv, e.payload.tag, vaultKey, { additionalData: aad(e) })) as T;
    // Reset or replacement during decryption invalidates this read too.
    const current = await this.version(userId, resourceKey);
    if (current.generation !== e.generation || current.revision !== e.revision)
      throw new Error("Encrypted resource changed. Read it again.");
    return { value, generation: e.generation, revision: e.revision };
  }
  static async write<T>(params: { userId: string; resourceKey: string; vaultKey: string; value: T; expected: DurableVersion; isCurrent: () => boolean }): Promise<DurableVersion> {
    const { userId, resourceKey, expected } = params;
    const binding = { key: keyOf(userId, resourceKey), userId, resourceKey, generation: expected.generation, revision: expected.revision + 1 };
    const payload = await encryptForExport(JSON.stringify(params.value), params.vaultKey, { additionalData: aad(binding) });
    if (!params.isCurrent()) throw new Error("Receipt authority changed.");
    const db = await database();
    try {
      const tx = db.transaction([DURABLE_RESOURCE_STORE, DURABLE_GENERATION_STORE], "readwrite");
      const done = completed(tx);
      const [generation, prior] = await Promise.all([
        get<number>(tx.objectStore(DURABLE_GENERATION_STORE), userId),
        get<Envelope>(tx.objectStore(DURABLE_RESOURCE_STORE), binding.key),
      ]);
      if (!params.isCurrent() || (generation ?? 0) !== expected.generation || (prior?.revision ?? 0) !== expected.revision) {
        tx.abort();
        await done.catch(() => undefined);
        throw new Error("Receipt snapshot changed or was reset. Sync again.");
      }
      tx.objectStore(DURABLE_RESOURCE_STORE).put({ ...binding, payload });
      await done;
      return { generation: binding.generation, revision: binding.revision };
    } finally { db.close(); }
  }
  /** Account Reset/delete: atomically fence late writes and remove device recovery envelopes. */
  static async purgeUser(userId: string): Promise<void> {
    const db = await database();
    try {
      const tx = db.transaction([DURABLE_RESOURCE_STORE, DURABLE_GENERATION_STORE, "resource_cache"], "readwrite");
      const done = completed(tx);
      const generationRequest = tx.objectStore(DURABLE_GENERATION_STORE).get(userId);
      generationRequest.onsuccess = () => tx.objectStore(DURABLE_GENERATION_STORE).put((generationRequest.result ?? 0) + 1, userId);
      for (const storeName of [DURABLE_RESOURCE_STORE, "resource_cache"]) {
        const store = tx.objectStore(storeName);
        const cursor = store.index("userId").openCursor(userId);
        cursor.onsuccess = () => { const value = cursor.result; if (value) { value.delete(); value.continue(); } };
      }
      await done;
      notifyReset(userId);
    } finally { db.close(); }
  }
}
