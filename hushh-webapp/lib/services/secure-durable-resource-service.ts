"use client";

import { DurableResourceError, durableResourceError, type DurableResourceStage } from "./durable-resource-error";
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
  if (!db) throw new DurableResourceError("storage_unavailable", "version", "Encrypted device storage is unavailable.");
  return db;
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = event => reject(tx.error ?? (event.target as IDBRequest | null)?.error ?? new Error("Encrypted storage transaction did not commit."));
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
        done,
      ]);
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
      return records.filter(e => e.key === keyOf(userId, e.resourceKey) && e.resourceKey.startsWith(prefix)).map(e => e.resourceKey);
    } finally { db.close(); }
  }
  static async read<T>(userId: string, resourceKey: string, vaultKey: string): Promise<(DurableVersion & { value: T }) | null> {
    const db = await database();
    let e: Envelope | undefined;
    try {
      const tx = db.transaction(DURABLE_RESOURCE_STORE, "readonly");
      const done = completed(tx);
      [e] = await Promise.all([get<Envelope>(tx.objectStore(DURABLE_RESOURCE_STORE), keyOf(userId, resourceKey)), done]);
    } finally { db.close(); }
    if (!e) return null;
    if (e.userId !== userId || e.resourceKey !== resourceKey || e.key !== keyOf(userId, resourceKey))
      throw new DurableResourceError("binding_invalid", "readback", "Encrypted resource binding is invalid.");
    const value = JSON.parse(await decryptExport(e.payload.ciphertext, e.payload.iv, e.payload.tag, vaultKey, { additionalData: aad(e) })) as T;
    // Reset or replacement during decryption invalidates this read too.
    const current = await this.version(userId, resourceKey);
    if (current.generation !== e.generation || current.revision !== e.revision)
      throw new Error("Encrypted resource changed. Read it again.");
    return { value, generation: e.generation, revision: e.revision };
  }
  static async write<T>(params: { userId: string; resourceKey: string; vaultKey: string; value: T; expected: DurableVersion; isCurrent: () => boolean; validateReadback?: (value: unknown) => void }): Promise<DurableVersion> {
    const { userId, resourceKey, expected } = params;
    const binding = { key: keyOf(userId, resourceKey), userId, resourceKey, generation: expected.generation, revision: expected.revision + 1 };
    const stagingKey = JSON.stringify([userId, resourceKey, "pending", crypto.randomUUID()]);
    const serialized = JSON.stringify(params.value);
    let stage: DurableResourceStage = "encryption";
    let db: IDBDatabase | undefined;
    const ensureCurrent = () => {
      if (!params.isCurrent()) throw new DurableResourceError("authority_changed", "authority", "Receipt authority changed.");
    };
    const ensureVersion = (generation: number | undefined, prior: Envelope | undefined) => {
      ensureCurrent();
      if ((generation ?? 0) !== expected.generation || (prior?.revision ?? 0) !== expected.revision)
        throw new DurableResourceError("stale_version", "commit", "Receipt snapshot changed or was reset. Sync again.");
    };
    try {
      if (!/^[a-f0-9]{64}$/i.test(params.vaultKey))
        throw new DurableResourceError("key_unavailable", "encryption", "Unlock your vault to save receipts.");
      const payload = await encryptForExport(serialized, params.vaultKey, { additionalData: aad(binding) });
      ensureCurrent();
      stage = "write";
      db = await database();
      // Commit a candidate separately. The prior verified envelope remains authoritative.
      const pending: Envelope = { ...binding, key: stagingKey, payload };
      const tx = db.transaction([DURABLE_RESOURCE_STORE, DURABLE_GENERATION_STORE], "readwrite");
      const done = completed(tx);
      try {
        const [generation, prior] = await Promise.all([
          get<number>(tx.objectStore(DURABLE_GENERATION_STORE), userId),
          get<Envelope>(tx.objectStore(DURABLE_RESOURCE_STORE), binding.key),
        ]);
        ensureVersion(generation, prior);
        tx.objectStore(DURABLE_RESOURCE_STORE).put(pending);
        await done;
      } catch (error) {
        try { tx.abort(); } catch { /* Transaction already settled. */ }
        await done.catch(() => undefined);
        throw error;
      }
      stage = "readback";
      const readTx = db.transaction(DURABLE_RESOURCE_STORE, "readonly");
      const readDone = completed(readTx);
      const [readback] = await Promise.all([
        get<Envelope>(readTx.objectStore(DURABLE_RESOURCE_STORE), stagingKey), readDone,
      ]);
      ensureCurrent();
      if (!readback || JSON.stringify(readback) !== JSON.stringify(pending))
        throw new DurableResourceError("readback_failed", "readback", "Receipt snapshot read-back verification failed. Existing saved receipts were kept.");
      const plaintext = await decryptExport(readback.payload.ciphertext, readback.payload.iv, readback.payload.tag, params.vaultKey, { additionalData: aad(binding) });
      if (plaintext !== serialized)
        throw new DurableResourceError("readback_failed", "readback", "Receipt snapshot read-back verification failed. Existing saved receipts were kept.");
      params.validateReadback?.(JSON.parse(plaintext));
      ensureCurrent();
      stage = "commit";
      // Promote the exact verified ciphertext atomically, rechecking Reset/revision.
      const commitTx = db.transaction([DURABLE_RESOURCE_STORE, DURABLE_GENERATION_STORE], "readwrite");
      const commitDone = completed(commitTx);
      try {
        const store = commitTx.objectStore(DURABLE_RESOURCE_STORE);
        const [generation, prior, candidate] = await Promise.all([
          get<number>(commitTx.objectStore(DURABLE_GENERATION_STORE), userId),
          get<Envelope>(store, binding.key), get<Envelope>(store, stagingKey),
        ]);
        ensureVersion(generation, prior);
        if (!candidate || JSON.stringify(candidate) !== JSON.stringify(pending))
          throw new DurableResourceError("readback_failed", "commit", "Receipt candidate changed. Existing saved receipts were kept.");
        store.put({ ...binding, payload: candidate.payload });
        store.delete(stagingKey);
        await commitDone;
      } catch (error) {
        try { commitTx.abort(); } catch { /* Transaction already settled. */ }
        await commitDone.catch(() => undefined);
        throw error;
      }
      return { generation: binding.generation, revision: binding.revision };
    } catch (error) {
      // Delete only this candidate; never restore old data after a Reset.
      if (db) {
        try {
          const cleanup = db.transaction(DURABLE_RESOURCE_STORE, "readwrite");
          const cleanupDone = completed(cleanup);
          cleanup.objectStore(DURABLE_RESOURCE_STORE).delete(stagingKey);
          await cleanupDone;
        } catch { /* A failed cleanup leaves a non-authoritative encrypted candidate. */ }
      }
      throw durableResourceError(error, stage);
    } finally { db?.close(); }
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
