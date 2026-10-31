"use client";

const DB_NAME = "hushh-secure-resource-cache";
const DB_VERSION = 3;
export const STORE_NAME = "resource_cache";
export const DURABLE_RESOURCE_STORE = "durable_resources";
export const DURABLE_GENERATION_STORE = "owner_generations";

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
export const LOCAL_KEY_STORE_NAME = "local_device_keys";
export const BUFFER_STORE_NAME = "onboarding_buffer";

export async function openSecureResourceDb(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || typeof window.indexedDB === "undefined") {
    return null;
  }

  return await new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;

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
      if (!db.objectStoreNames.contains(DURABLE_RESOURCE_STORE)) {
        const store = db.createObjectStore(DURABLE_RESOURCE_STORE, { keyPath: "key" });
        store.createIndex("userId", "userId", { unique: false });
      }
      if (!db.objectStoreNames.contains(DURABLE_GENERATION_STORE))
        db.createObjectStore(DURABLE_GENERATION_STORE);
    };

    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open secure resource cache"));
    request.onblocked = () => { blocked = true; reject(new Error("Encrypted storage upgrade is blocked. Close older app tabs and try again.")); };
  });
}
