// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh
"use client";

/**
 * Owner-scoped AES-256-GCM IndexedDB replica for instant passive UI reads.
 *
 * Passive read surfaces (Chats sidebar, Rolling Main Chat, Files directory, and
 * Personal Wiki) hydrate immediately on reload or return-from-idle without
 * blocking behind a waking Kubernetes sandbox. Plaintext never touches disk:
 * every record is sealed in browser RAM under an HKDF-SHA256 subkey derived
 * from the unlocked vault key and bound via AEAD additionalData to both
 * `ownerId` and `namespace`.
 */

import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";
import { hexToBytes } from "@/lib/vault/passphrase-key";

export const ENCRYPTED_OWNER_UI_DB_NAME = "hushh-owner-ui-cache";
const DB_VERSION = 1;
const RECORD_STORE = "encrypted_records";
const OWNER_INDEX = "by_owner";
const UI_CACHE_LABEL = "hussh-ui-read-cache-v1";
const VAULT_KEY_HEX = /^[0-9a-fA-F]{64}$/;
const IV_BYTES = 12;
const MAX_PLAINTEXT_BYTES = 2 * 1024 * 1024;

type StoredEncryptedUiRecord = {
  recordKey: string;
  ownerId: string;
  namespace: string;
  updatedAt: number;
  ivB64: string;
  ciphertextB64: string;
};

const memoryRecords = new Map<string, StoredEncryptedUiRecord>();
const writeSeqByKey = new Map<string, number>();
const pendingWrites = new Set<Promise<void>>();

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function webCryptoAvailable(): boolean {
  return typeof crypto !== "undefined" && Boolean(crypto.subtle);
}

export function canSealOwnerUiCache(vaultKey: string | null | undefined): boolean {
  return VAULT_KEY_HEX.test(String(vaultKey ?? "").trim()) && webCryptoAvailable();
}

function makeRecordKey(ownerId: string, namespace: string): string {
  return `${ownerId}::${namespace}`;
}

function makeAadBytes(ownerId: string, namespace: string): Uint8Array<ArrayBuffer> {
  const raw = new TextEncoder().encode(`${UI_CACHE_LABEL}|${ownerId}|${namespace}`);
  const out = new Uint8Array(new ArrayBuffer(raw.byteLength));
  out.set(raw);
  return out;
}

async function deriveOwnerUiAesKey(
  ownerId: string,
  vaultKeyHex: string,
): Promise<CryptoKey> {
  const ikm = new Uint8Array(new ArrayBuffer(32));
  ikm.set(hexToBytes(vaultKeyHex.trim()));
  try {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      ikm,
      "HKDF",
      false,
      ["deriveKey"],
    );
    const saltRaw = new TextEncoder().encode(ownerId);
    const salt = new Uint8Array(new ArrayBuffer(saltRaw.byteLength));
    salt.set(saltRaw);
    const infoRaw = new TextEncoder().encode(UI_CACHE_LABEL);
    const info = new Uint8Array(new ArrayBuffer(infoRaw.byteLength));
    info.set(infoRaw);
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info,
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    ikm.fill(0);
  }
}

async function openDb(): Promise<IDBDatabase | null> {
  if (!indexedDbAvailable()) return null;
  return await new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open(ENCRYPTED_OWNER_UI_DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORD_STORE)) {
        const store = db.createObjectStore(RECORD_STORE, { keyPath: "recordKey" });
        store.createIndex(OWNER_INDEX, "ownerId", { unique: false });
      }
    };
    request.onblocked = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("UI_CACHE_DB_OPEN_FAILED"));
  }).catch(() => null);
}

async function getStoredRecord(recordKey: string, consume = false): Promise<StoredEncryptedUiRecord | null> {
  const db = await openDb();
  const cached = memoryRecords.get(recordKey) ?? null;
  if (consume) memoryRecords.delete(recordKey);
  if (!db) {
    return cached;
  }
  try {
    return await new Promise<StoredEncryptedUiRecord | null>((resolve, reject) => {
      const tx = db.transaction(RECORD_STORE, consume ? "readwrite" : "readonly");
      const store = tx.objectStore(RECORD_STORE);
      const req = store.get(recordKey);
      if (consume) {
        req.onsuccess = () => { if (req.result) store.delete(recordKey); };
        tx.oncomplete = () => resolve((req.result as StoredEncryptedUiRecord | undefined) ?? null);
        tx.onabort = () => reject(tx.error ?? new Error("UI_CACHE_CONSUME_FAILED"));
      } else {
        req.onsuccess = () => resolve((req.result as StoredEncryptedUiRecord | undefined) ?? null);
      }
      req.onerror = () => reject(req.error ?? new Error("UI_CACHE_READ_FAILED"));
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function putStoredRecord(record: StoredEncryptedUiRecord): Promise<void> {
  memoryRecords.set(record.recordKey, record);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(RECORD_STORE, "readwrite");
      tx.objectStore(RECORD_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("UI_CACHE_WRITE_FAILED"));
      tx.onabort = () => reject(tx.error ?? new Error("UI_CACHE_WRITE_ABORTED"));
    });
  } catch {
    // Best-effort encrypted UI cache never blocks caller foreground operations.
  } finally {
    db.close();
  }
}

export async function writeEncryptedOwnerUiRecord<T>(input: {
  ownerId: string;
  vaultKey: string | null | undefined;
  namespace: string;
  value: T;
  updatedAt?: number;
}): Promise<void> {
  const ownerId = String(input.ownerId || "").trim();
  const namespace = String(input.namespace || "").trim();
  const vaultKey = String(input.vaultKey || "").trim();
  if (!ownerId || !namespace || !canSealOwnerUiCache(vaultKey)) return;

  const recordKey = makeRecordKey(ownerId, namespace);
  const seq = (writeSeqByKey.get(recordKey) ?? 0) + 1;
  writeSeqByKey.set(recordKey, seq);

  let encodedPlaintext: Uint8Array<ArrayBuffer>;
  try {
    const raw = new TextEncoder().encode(JSON.stringify(input.value));
    if (raw.byteLength > MAX_PLAINTEXT_BYTES) return;
    encodedPlaintext = new Uint8Array(new ArrayBuffer(raw.byteLength));
    encodedPlaintext.set(raw);
  } catch {
    return;
  }

  const work = (async () => {
    try {
      const aesKey = await deriveOwnerUiAesKey(ownerId, vaultKey);
      if (writeSeqByKey.get(recordKey) !== seq) return;
      const iv = new Uint8Array(new ArrayBuffer(IV_BYTES));
      crypto.getRandomValues(iv);
      const aad = makeAadBytes(ownerId, namespace);
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        aesKey,
        encodedPlaintext,
      );
      if (writeSeqByKey.get(recordKey) !== seq) return;
      await putStoredRecord({
        recordKey,
        ownerId,
        namespace,
        updatedAt: input.updatedAt ?? Date.now(),
        ivB64: bytesToBase64(iv),
        ciphertextB64: bytesToBase64(new Uint8Array(sealed)),
      });
    } catch {
      // Ignore transient WebCrypto/IndexedDB failures.
    } finally {
      encodedPlaintext.fill(0);
    }
  })();

  pendingWrites.add(work);
  try {
    await work;
  } finally {
    pendingWrites.delete(work);
  }
}

export async function readEncryptedOwnerUiRecord<T>(input: {
  ownerId: string;
  vaultKey: string | null | undefined;
  namespace: string;
  /** Remove a single-use handoff atomically with its read, including across tabs. */
  consume?: boolean;
}): Promise<{ value: T; updatedAt: number } | null> {
  const ownerId = String(input.ownerId || "").trim();
  const namespace = String(input.namespace || "").trim();
  const vaultKey = String(input.vaultKey || "").trim();
  if (!ownerId || !namespace || !canSealOwnerUiCache(vaultKey)) return null;

  const recordKey = makeRecordKey(ownerId, namespace);
  const stored = await getStoredRecord(recordKey, input.consume);
  if (
    !stored ||
    stored.ownerId !== ownerId ||
    stored.namespace !== namespace ||
    typeof stored.ivB64 !== "string" ||
    typeof stored.ciphertextB64 !== "string"
  ) {
    return null;
  }

  try {
    const aesKey = await deriveOwnerUiAesKey(ownerId, vaultKey);
    const ivDecoded = base64ToBytes(stored.ivB64);
    if (ivDecoded.byteLength !== IV_BYTES) return null;
    const iv = new Uint8Array(new ArrayBuffer(IV_BYTES));
    iv.set(ivDecoded);
    const cipherDecoded = base64ToBytes(stored.ciphertextB64);
    const cipher = new Uint8Array(new ArrayBuffer(cipherDecoded.byteLength));
    cipher.set(cipherDecoded);
    const aad = makeAadBytes(ownerId, namespace);
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      aesKey,
      cipher,
    );
    const plainBytes = new Uint8Array(plainBuf);
    try {
      const parsed = JSON.parse(new TextDecoder().decode(plainBytes)) as T;
      return {
        value: parsed,
        updatedAt: typeof stored.updatedAt === "number" ? stored.updatedAt : 0,
      };
    } finally {
      plainBytes.fill(0);
    }
  } catch {
    return null;
  }
}

export async function deleteEncryptedOwnerUiRecords(
  ownerId?: string,
  namespacePrefix?: string,
  retainNamespaces?: ReadonlySet<string>,
): Promise<void> {
  const cleanOwner = typeof ownerId === "string" ? ownerId.trim() : "";
  const cleanPrefix = typeof namespacePrefix === "string" ? namespacePrefix : "";

  const matchesNamespace = (namespace: string) =>
    namespace.startsWith(cleanPrefix) && !retainNamespaces?.has(namespace);
  // Allowlist reconciliation always belongs to one owner and one resource type.
  if (retainNamespaces && (!cleanOwner || !cleanPrefix)) return;

  if (!cleanOwner && !cleanPrefix) {
    for (const key of writeSeqByKey.keys()) {
      writeSeqByKey.set(key, (writeSeqByKey.get(key) ?? 0) + 1);
    }
    memoryRecords.clear();
  } else {
    for (const [key, entry] of memoryRecords.entries()) {
      const ownerMatches = !cleanOwner || entry.ownerId === cleanOwner;
      const prefixMatches = matchesNamespace(entry.namespace);
      if (ownerMatches && prefixMatches) {
        writeSeqByKey.set(key, (writeSeqByKey.get(key) ?? 0) + 1);
        memoryRecords.delete(key);
      }
    }
    for (const key of writeSeqByKey.keys()) {
      const [recOwner = "", recNs = ""] = key.split("::");
      const ownerMatches = !cleanOwner || recOwner === cleanOwner;
      const prefixMatches = matchesNamespace(recNs);
      if (ownerMatches && prefixMatches) {
        writeSeqByKey.set(key, (writeSeqByKey.get(key) ?? 0) + 1);
      }
    }
  }

  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(RECORD_STORE, "readwrite");
      const store = tx.objectStore(RECORD_STORE);
      if (!cleanOwner && !cleanPrefix) {
        store.clear();
      } else if (cleanOwner) {
        const idx = store.index(OWNER_INDEX);
        const cursorReq = idx.openCursor(IDBKeyRange.only(cleanOwner));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const val = cursor.value as StoredEncryptedUiRecord;
          if (matchesNamespace(val.namespace)) {
            cursor.delete();
          }
          cursor.continue();
        };
      } else {
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const val = cursor.value as StoredEncryptedUiRecord;
          if (val.namespace.startsWith(cleanPrefix)) {
            cursor.delete();
          }
          cursor.continue();
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("UI_CACHE_DELETE_FAILED"));
      tx.onabort = () => reject(tx.error ?? new Error("UI_CACHE_DELETE_ABORTED"));
    });
  } catch {
    // Best-effort cleanup.
  } finally {
    db.close();
  }
}

/** Purge all encrypted UI cache records belonging to any owner other than `activeOwnerId`. */
export async function deleteEncryptedOwnerUiRecordsExceptOwner(
  activeOwnerId: string,
): Promise<void> {
  const cleanActive = String(activeOwnerId || "").trim();
  if (!cleanActive) return;

  for (const [key, entry] of memoryRecords.entries()) {
    if (entry.ownerId !== cleanActive) {
      writeSeqByKey.set(key, (writeSeqByKey.get(key) ?? 0) + 1);
      memoryRecords.delete(key);
    }
  }
  for (const key of writeSeqByKey.keys()) {
    const [recOwner = ""] = key.split("::");
    if (recOwner !== cleanActive) {
      writeSeqByKey.set(key, (writeSeqByKey.get(key) ?? 0) + 1);
    }
  }

  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(RECORD_STORE, "readwrite");
      const store = tx.objectStore(RECORD_STORE);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const val = cursor.value as StoredEncryptedUiRecord;
        if (val.ownerId !== cleanActive) {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("UI_CACHE_DELETE_FAILED"));
      tx.onabort = () => reject(tx.error ?? new Error("UI_CACHE_DELETE_ABORTED"));
    });
  } catch {
    // Best-effort cleanup.
  } finally {
    db.close();
  }
}

/** Test-only helper to inspect raw stored records and reset in-memory fallback. */
export function inspectRawMemoryUiCacheForTests(): ReadonlyMap<string, StoredEncryptedUiRecord> {
  return memoryRecords;
}

/** Test-only helper awaiting all fire-and-forget encrypted UI cache writes. */
export async function flushEncryptedOwnerUiWritesForTests(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }
}
