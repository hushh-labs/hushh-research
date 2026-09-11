"use client";

import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";
import { decryptData, encryptData, type EncryptedPayload } from "@/lib/vault/encrypt";

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
const DB_VERSION = 2;
const STORE_NAME = "resource_cache";

/**
 * Added in DB_VERSION 2 for the local-first onboarding buffer.
 *
 * `local_device_keys` holds one NON-EXTRACTABLE AES-GCM `CryptoKey` per Firebase
 * UID. IndexedDB stores a `CryptoKey` natively, so only the handle is persisted —
 * the raw key material never becomes reachable from JavaScript and never leaves
 * the browser. `onboarding_buffer` holds the ciphertext written under that key.
 *
 * Both are keyed and indexed by `userId` exactly like `resource_cache`, so a
 * shared device with two accounts keeps two disjoint namespaces.
 */
const LOCAL_KEY_STORE_NAME = "local_device_keys";
const BUFFER_STORE_NAME = "onboarding_buffer";

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
      if (!db.objectStoreNames.contains(LOCAL_KEY_STORE_NAME)) {
        db.createObjectStore(LOCAL_KEY_STORE_NAME, { keyPath: "userId" });
      }
      if (!db.objectStoreNames.contains(BUFFER_STORE_NAME)) {
        const buffer = db.createObjectStore(BUFFER_STORE_NAME, { keyPath: "key" });
        buffer.createIndex("userId", "userId", { unique: false });
      }
    };

    // A version bump only proceeds once every older connection closes, and the
    // connections handed out here are long-lived. Without both handlers the
    // v1 -> v2 upgrade blocks and this promise never settles: `onversionchange`
    // makes each live connection yield, `onblocked` turns the residual case into
    // an observable error instead of a hang.
    request.onblocked = () =>
      reject(
        new Error(
          "Secure resource cache is open in another tab. Reload to continue.",
        ),
      );

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open secure resource cache"));
  });
}

function readRecord<T>(
  database: IDBDatabase,
  key: string,
  storeName: string = STORE_NAME
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to read secure cache record"));
  });
}

function writeRecord<T>(
  database: IDBDatabase,
  value: T,
  storeName: string = STORE_NAME
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    store.put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Failed to write secure cache record"));
  });
}

function deleteRecord(
  database: IDBDatabase,
  key: string,
  storeName: string = STORE_NAME
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    store.delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Failed to delete secure cache record"));
  });
}

function listRecordsByUser<T = SecureResourceCacheRecord>(
  database: IDBDatabase,
  userId: string,
  storeName: string = STORE_NAME
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const index = store.index("userId");
    const request = index.getAll(userId);
    request.onsuccess = () => resolve((request.result as T[] | undefined) ?? []);
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
      await this.writeRequired(params);
    } catch (error) {
      console.warn("[SecureResourceCacheService] Failed to write secure cache:", error);
    }
  }

  /**
   * Writes an encrypted snapshot and lets the caller observe a failure.
   *
   * Ordinary cache writes remain deliberately best-effort. A bounded migration
   * is different: it must not claim that a plaintext origin can be retired
   * unless the encrypted handoff was durably committed. Keep this narrow
   * primitive here instead of weakening the failure contract for all cache
   * consumers.
   */
  static async writeRequired<T>(params: {
    userId: string;
    resourceKey: string;
    value: T;
    ttlMs: number;
    vaultKey: string;
  }): Promise<void> {
    const database = await openDb();
    if (!database) {
      throw new Error("Secure resource cache is unavailable on this device.");
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

// ---------------------------------------------------------------------------
// Local-first onboarding buffer (dev-only sequence, kill-switched OFF by
// default — see `lib/onboarding/local-first-flags.ts`).
//
// Onboarding must cost the person nothing: no passphrase, no passkey, no
// ceremony. So what they tell us before the vault exists is held HERE —
// user-scoped, encrypted at rest under a key this browser cannot export — until
// their pod is ready and the records migrate into PKM.
//
// KNOWN LIMITATION (stated here, not hidden in a doc): nothing writes into this
// buffer yet. The current pre-vault producer is `pre-vault-onboarding-service.ts`,
// which stores answers in PLAINTEXT Capacitor Preferences plus a localStorage
// fallback and carries its own vault-handoff protocol
// (`completeAfterVaultCommit`). Moving that producer onto this buffer is the
// right next step, and it must retire the old handoff in the same change —
// running both would write the same answers into PKM down two paths, which is
// exactly the duplication the migration's stable ids exist to prevent.
// ---------------------------------------------------------------------------

function requireCrypto(): Crypto {
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
    throw new Error("Local onboarding storage requires Web Crypto.");
  }
  return globalThis.crypto;
}

type LocalDeviceKeyRecord = {
  userId: string;
  /** Stored as a live CryptoKey handle. IndexedDB persists it structurally. */
  key: CryptoKey;
  algorithm: "AES-GCM";
  createdAt: string;
};

/**
 * The device key for the pre-vault buffer.
 *
 * Generated with `extractable: false`, so `crypto.subtle.exportKey` on it is a
 * `DOMException` and no code path — ours, an extension's, or an attacker's
 * injected script — can lift the raw bytes out of the browser. It is per-UID,
 * requires zero user interaction, and is destroyed with the local buffer.
 *
 * It is deliberately NOT a vault key: it protects information in transit
 * through the browser's own storage, it does not stand in for the owner's
 * zero-knowledge vault. Anything durable still goes to PKM under the vault key.
 */
export class LocalDeviceKeyService {
  static async ensure(userId: string): Promise<CryptoKey | null> {
    const database = await openDb();
    if (!database) return null;

    const existing = await readRecord<LocalDeviceKeyRecord>(
      database,
      userId,
      LOCAL_KEY_STORE_NAME,
    );
    if (existing?.key) {
      return existing.key;
    }

    const key = await requireCrypto().subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await writeRecord<LocalDeviceKeyRecord>(
      database,
      {
        userId,
        key,
        algorithm: "AES-GCM",
        createdAt: new Date().toISOString(),
      },
      LOCAL_KEY_STORE_NAME,
    );
    return key;
  }

  static async clear(userId: string): Promise<void> {
    try {
      const database = await openDb();
      if (!database) return;
      await deleteRecord(database, userId, LOCAL_KEY_STORE_NAME);
    } catch (error) {
      console.warn("[LocalDeviceKeyService] Failed to clear local device key:", error);
    }
  }
}

/**
 * Encrypt with the non-extractable device key.
 *
 * Same payload shape and same base64 split (ciphertext | 16-byte tag) as
 * `lib/vault/encrypt.ts`, so there is one AES-GCM envelope in this codebase
 * rather than two. Only the key handling differs: a CryptoKey we can never
 * export, instead of a hex string we import per call.
 */
export async function encryptWithLocalDeviceKey(
  plaintext: string,
  key: CryptoKey,
): Promise<EncryptedPayload> {
  const crypto = requireCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted.slice(0, -16))),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(new Uint8Array(encrypted.slice(-16))),
    encoding: "base64",
    algorithm: "aes-256-gcm",
  };
}

export async function decryptWithLocalDeviceKey(
  payload: EncryptedPayload,
  key: CryptoKey,
): Promise<string> {
  const ciphertext = base64ToBytes(payload.ciphertext);
  const tag = base64ToBytes(payload.tag);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  const decrypted = await requireCrypto().subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    key,
    combined,
  );
  return new TextDecoder().decode(decrypted);
}

/**
 * One thing the person told us before their vault existed.
 *
 * `recordId` is client-generated and stable for the life of the record: it is
 * the idempotency key the PKM migration writes under, so a retry after a
 * partial failure lands on the same slot instead of appending a duplicate.
 */
export type BufferedOnboardingRecord<T = unknown> = {
  recordId: string;
  userId: string;
  /** PKM domain this record migrates into. */
  domain: string;
  createdAt: string;
  value: T;
};

type StoredBufferedRecord = {
  key: string;
  userId: string;
  recordId: string;
  domain: string;
  version: 1;
  createdAt: string;
  payload: EncryptedPayload;
};

function bufferKey(userId: string, recordId: string): string {
  return `${userId}:${recordId}`;
}

/**
 * The pre-vault buffer itself.
 *
 * Every record is keyed `${firebaseUid}:${recordId}` and carries an indexed
 * `userId`, so a read for one account can never return another account's rows
 * on a shared browser. Reads and writes are strict (they throw) — a buffer that
 * silently swallows a write would tell the person their answer was kept when it
 * was not.
 */
export class OnboardingBufferService {
  static async put<T>(params: {
    userId: string;
    recordId: string;
    domain: string;
    value: T;
    createdAt?: string;
  }): Promise<void> {
    const database = await openDb();
    if (!database) {
      throw new Error("Local onboarding storage is unavailable on this device.");
    }
    const key = await LocalDeviceKeyService.ensure(params.userId);
    if (!key) {
      throw new Error("Local onboarding storage is unavailable on this device.");
    }

    await writeRecord<StoredBufferedRecord>(
      database,
      {
        key: bufferKey(params.userId, params.recordId),
        userId: params.userId,
        recordId: params.recordId,
        domain: params.domain,
        version: 1,
        createdAt: params.createdAt ?? new Date().toISOString(),
        payload: await encryptWithLocalDeviceKey(JSON.stringify(params.value), key),
      },
      BUFFER_STORE_NAME,
    );
  }

  /**
   * Every buffered record for ONE user, oldest first.
   *
   * A record whose ciphertext will not open (device key rotated, storage
   * corrupted) is skipped rather than thrown, so one bad row cannot strand the
   * whole migration. It stays on disk for the owner to clear.
   */
  static async list<T = unknown>(userId: string): Promise<BufferedOnboardingRecord<T>[]> {
    const database = await openDb();
    if (!database) return [];
    const key = await LocalDeviceKeyService.ensure(userId);
    if (!key) return [];

    const stored = await listRecordsByUser<StoredBufferedRecord>(
      database,
      userId,
      BUFFER_STORE_NAME,
    );

    const records: BufferedOnboardingRecord<T>[] = [];
    for (const record of stored) {
      if (record.userId !== userId) continue;
      try {
        records.push({
          recordId: record.recordId,
          userId: record.userId,
          domain: record.domain,
          createdAt: record.createdAt,
          value: JSON.parse(await decryptWithLocalDeviceKey(record.payload, key)) as T,
        });
      } catch (error) {
        console.warn(
          "[OnboardingBufferService] Skipping an unreadable buffered record:",
          error,
        );
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  static async count(userId: string): Promise<number> {
    const database = await openDb();
    if (!database) return 0;
    const stored = await listRecordsByUser<StoredBufferedRecord>(
      database,
      userId,
      BUFFER_STORE_NAME,
    );
    return stored.filter((record) => record.userId === userId).length;
  }

  /**
   * Remove exactly one acknowledged record. Strict on purpose: the migration
   * only clears local information after the server confirms that specific id,
   * so a failed delete must be visible rather than assumed.
   */
  static async remove(userId: string, recordId: string): Promise<void> {
    const database = await openDb();
    if (!database) {
      throw new Error("Local onboarding storage is unavailable on this device.");
    }
    await deleteRecord(database, bufferKey(userId, recordId), BUFFER_STORE_NAME);
  }

  static async clearUser(userId: string): Promise<void> {
    try {
      const database = await openDb();
      if (!database) return;
      const stored = await listRecordsByUser<StoredBufferedRecord>(
        database,
        userId,
        BUFFER_STORE_NAME,
      );
      await Promise.all(
        stored
          .filter((record) => record.userId === userId)
          .map((record) => deleteRecord(database, record.key, BUFFER_STORE_NAME)),
      );
      await LocalDeviceKeyService.clear(userId);
    } catch (error) {
      console.warn("[OnboardingBufferService] Failed to clear the local buffer:", error);
    }
  }
}
