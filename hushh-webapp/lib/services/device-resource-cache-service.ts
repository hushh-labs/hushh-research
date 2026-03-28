"use client";

interface DeviceResourceCacheRecord<T = unknown> {
  key: string;
  userId: string;
  resourceKey: string;
  version: 1;
  cachedAt: string;
  ttlMs: number;
  value: T;
}

export interface DeviceResourceCacheHit<T = unknown> {
  resourceKey: string;
  value: T;
  cachedAt: string;
  ttlMs: number;
}

const DB_NAME = "hushh-device-resource-cache";
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
      reject(request.error ?? new Error("Failed to open device resource cache"));
  });
}

function readRecord<T>(database: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to read device cache record"));
  });
}

function writeRecord<T>(database: IDBDatabase, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Failed to write device cache record"));
  });
}

function deleteRecord(database: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Failed to delete device cache record"));
  });
}

function listRecordsByUser(
  database: IDBDatabase,
  userId: string
): Promise<DeviceResourceCacheRecord[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index("userId");
    const request = index.getAll(userId);
    request.onsuccess = () =>
      resolve((request.result as DeviceResourceCacheRecord[] | undefined) ?? []);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to list device cache records"));
  });
}

export class DeviceResourceCacheService {
  static async read<T>(params: {
    userId: string;
    resourceKey: string;
  }): Promise<T | null> {
    try {
      const database = await openDb();
      if (!database) {
        return null;
      }

      const record = await readRecord<DeviceResourceCacheRecord<T>>(
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

      return record.value;
    } catch (error) {
      console.warn("[DeviceResourceCacheService] Failed to read device cache:", error);
      return null;
    }
  }

  static async write<T>(params: {
    userId: string;
    resourceKey: string;
    value: T;
    ttlMs: number;
  }): Promise<void> {
    try {
      const database = await openDb();
      if (!database) {
        return;
      }

      await writeRecord<DeviceResourceCacheRecord<T>>(database, {
        key: buildStorageKey(params.userId, params.resourceKey),
        userId: params.userId,
        resourceKey: params.resourceKey,
        version: 1,
        cachedAt: new Date().toISOString(),
        ttlMs: params.ttlMs,
        value: params.value,
      });
    } catch (error) {
      console.warn("[DeviceResourceCacheService] Failed to write device cache:", error);
    }
  }

  static async readLatestByPrefix<T>(params: {
    userId: string;
    resourcePrefix: string;
  }): Promise<DeviceResourceCacheHit<T> | null> {
    try {
      const database = await openDb();
      if (!database) {
        return null;
      }

      const records = await listRecordsByUser(database, params.userId);
      let latest: DeviceResourceCacheRecord<T> | null = null;
      const expiredKeys: string[] = [];

      for (const record of records) {
        if (!record.resourceKey.startsWith(params.resourcePrefix)) {
          continue;
        }

        const ageMs = Date.now() - Date.parse(record.cachedAt);
        if (!Number.isFinite(ageMs) || ageMs > record.ttlMs) {
          expiredKeys.push(record.key);
          continue;
        }

        if (!latest || Date.parse(record.cachedAt) > Date.parse(latest.cachedAt)) {
          latest = record as DeviceResourceCacheRecord<T>;
        }
      }

      if (expiredKeys.length > 0) {
        await Promise.all(expiredKeys.map((key) => deleteRecord(database, key))).catch(
          () => undefined
        );
      }

      if (!latest) {
        return null;
      }

      return {
        resourceKey: latest.resourceKey,
        value: latest.value,
        cachedAt: latest.cachedAt,
        ttlMs: latest.ttlMs,
      };
    } catch (error) {
      console.warn(
        "[DeviceResourceCacheService] Failed to read device cache prefix:",
        error
      );
      return null;
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
      console.warn("[DeviceResourceCacheService] Failed to invalidate device cache:", error);
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
      console.warn("[DeviceResourceCacheService] Failed to invalidate device cache prefix:", error);
    }
  }
}
