"use client";

/** Canonical owner-pod IndexedDB stores; authority remains in the serialized caller. */
import { OwnerPodError } from "./owner-pod-crypto";

export const OWNER_POD_DB_NAME = "hushh-owner-pod";
const DB_VERSION = 1;
export const KEY_STORE = "app_keys";
export const PIN_STORE = "pins";

const memoryKeys = new Map<string, unknown>();
const memoryPins = new Map<string, unknown>();
function indexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

async function openDb(): Promise<IDBDatabase | null> {
  if (!indexedDbAvailable()) return null;
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(OWNER_POD_DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: "userId" });
      }
      if (!db.objectStoreNames.contains(PIN_STORE)) {
        db.createObjectStore(PIN_STORE, { keyPath: "userId" });
      }
    };
    request.onblocked = () => reject(new OwnerPodError("STORAGE_BLOCKED"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new OwnerPodError("STORAGE_UNAVAILABLE"));
  });
}

export async function readRecord<T>(store: string, userId: string): Promise<T | null> {
  const db = await openDb();
  if (!db) {
    const fallback = store === KEY_STORE ? memoryKeys : memoryPins;
    return (fallback.get(userId) as T | undefined) ?? null;
  }
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).get(userId);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new OwnerPodError("STORAGE_READ_FAILED"));
    });
  } finally {
    db.close();
  }
}

export async function writeRecord<T extends { userId: string }>(store: string, record: T): Promise<void> {
  const db = await openDb();
  if (!db) {
    const fallback = store === KEY_STORE ? memoryKeys : memoryPins;
    (fallback as unknown as Map<string, T>).set(record.userId, record);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new OwnerPodError("STORAGE_WRITE_FAILED"));
      tx.onabort = () => reject(tx.error ?? new OwnerPodError("STORAGE_WRITE_ABORTED"));
    });
  } finally {
    db.close();
  }
}

export async function deleteOwnerPodRecords(userId: string): Promise<void> {
  memoryKeys.delete(userId);
  memoryPins.delete(userId);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([KEY_STORE, PIN_STORE], "readwrite");
      tx.objectStore(KEY_STORE).delete(userId);
      tx.objectStore(PIN_STORE).delete(userId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new OwnerPodError("STORAGE_WRITE_FAILED"));
    });
  } finally {
    db.close();
  }
}
