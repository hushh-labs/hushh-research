"use client";

import { decryptData, encryptData } from "@/lib/vault/encrypt";

interface SecureResourceCacheRecord {
  key: string;
  userId: string;
  resourceKey: string;
  version: 1;
  cachedAt: string;
  ttlMs: number;
  payload: Awaited<ReturnType<typeof encryptData>>;
}

const DB_NAME = "hushh-secure-resource-cache";
const DB_VERSION = 1;
const STORE_NAME = "resource_cache";

function buildStorageKey(userId: string, resourceKey: string): string {
  return `${userId}:${resourceKey}`;
}

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || typeof window.indexedDB === "undefined") {
    return null;
  }

  return await new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("userId", "userId", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open secure resource cache"));
  });
}

function readRecord<T>(
  database: IDBDatabase,
  key: string
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to read secure cache record"));
  });
}

function writeRecord<T>(database: IDBDatabase, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Failed to write secure cache record"));
  });
}

function deleteRecord(database: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Failed to delete secure cache record"));
  });
}

function listRecordsByUser(
  database: IDBDatabase,
  userId: string
): Promise<SecureResourceCacheRecord[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index("userId");
    const request = index.getAll(userId);
    request.onsuccess = () =>
      resolve((request.result as SecureResourceCacheRecord[] | undefined) ?? []);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to list secure cache records"));
  });
}

export class SecureResourceCacheService {
  static async read<T>(params: {
    userId: string;
    resourceKey: string;
    vaultKey: string;
  }): Promise<T | null> {
    try {
      const database = await openDb();
      if (!database) {
        return null;
      }

      const record = await readRecord<SecureResourceCacheRecord>(
        database,
        buildStorageKey(params.userId, params.resourceKey)
      );
      if (!record) {
        return null;
      }

      const ageMs = Date.now() - Date.parse(record.cachedAt);
      if (!Number.isFinite(ageMs) || ageMs > record.ttlMs) {
        await deleteRecord(database, record.key).catch(() => undefined);
        return null;
      }

      const decrypted = await decryptData(record.payload, params.vaultKey);
      return JSON.parse(decrypted) as T;
    } catch (error) {
      console.warn("[SecureResourceCacheService] Failed to read secure cache:", error);
      return null;
    }
  }

  static async write<T>(params: {
    userId: string;
    resourceKey: string;
    value: T;
    ttlMs: number;
    vaultKey: string;
  }): Promise<void> {
    try {
      const database = await openDb();
      if (!database) {
        return;
      }

      const payload = await encryptData(JSON.stringify(params.value), params.vaultKey);
      await writeRecord<SecureResourceCacheRecord>(database, {
        key: buildStorageKey(params.userId, params.resourceKey),
        userId: params.userId,
        resourceKey: params.resourceKey,
        version: 1,
        cachedAt: new Date().toISOString(),
        ttlMs: params.ttlMs,
        payload,
      });
    } catch (error) {
      console.warn("[SecureResourceCacheService] Failed to write secure cache:", error);
    }
  }

  static async invalidateResource(userId: string, resourceKey: string): Promise<void> {
    try {
      const database = await openDb();
      if (!database) {
        return;
      }
      await deleteRecord(database, buildStorageKey(userId, resourceKey));
    } catch (error) {
      console.warn("[SecureResourceCacheService] Failed to invalidate secure cache:", error);
    }
  }

  static async invalidateResourcePrefix(userId: string, resourcePrefix: string): Promise<void> {
    try {
      const database = await openDb();
      if (!database) {
        return;
      }
      const records = await listRecordsByUser(database, userId);
      await Promise.all(
        records
          .filter((record) => record.resourceKey.startsWith(resourcePrefix))
          .map((record) => deleteRecord(database, record.key))
      );
    } catch (error) {
      console.warn("[SecureResourceCacheService] Failed to invalidate secure cache prefix:", error);
    }
  }

  static async invalidateUser(userId: string): Promise<void> {
    try {
      const database = await openDb();
      if (!database) {
        return;
      }
      const records = await listRecordsByUser(database, userId);
      await Promise.all(records.map((record) => deleteRecord(database, record.key)));
    } catch (error) {
      console.warn("[SecureResourceCacheService] Failed to invalidate user cache:", error);
    }
  }
}
