import { Capacitor } from "@capacitor/core";
import { previewBase64 } from "./chat-preview";

export type PushDeviceRegistration = { deviceId: string; keyId: string; publicKey: string };
let installation: Promise<string> | null = null;
export const PREVIEW_DATABASE = "hussh-chat-preview-v1";
let revision = 0;
let nativeOperations: Promise<unknown> = Promise.resolve();
let pending: Promise<PushDeviceRegistration> | null = null;
let owner: string | null = null;
let activeKey: string | null = null;
const keyListeners = new Set<() => void>();
function setActiveKey(key: string | null): void {
  if (activeKey === key) return;
  activeKey = key;
  for (const listener of keyListeners) listener();
}
export function subscribeNotificationKey(listener: () => void): () => void {
  keyListeners.add(listener);
  return () => { keyListeners.delete(listener); };
}
export function activeNotificationKeyId(userId?: string): string | null { return userId && owner !== userId ? null : activeKey; }
export async function clearCurrentNotificationDevice(userId?: string): Promise<void> {
  const departingOwner = userId ?? owner;
  if (departingOwner) await clearNotificationDevice(departingOwner);
}

export function notificationDeviceId(): Promise<string> {
  installation ??= (async () => {
    let db: IDBDatabase | undefined;
    try {
      db = await database();
      return await new Promise<string>((resolve, reject) => {
        const transaction = db!.transaction("keys", "readwrite");
        const store = transaction.objectStore("keys");
        const request = store.get("installation");
        let id = "";
        request.onsuccess = () => {
          id = typeof request.result === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(request.result) ? request.result : crypto.randomUUID();
          store.put(id, "installation");
        };
        transaction.oncomplete = () => resolve(id);
        transaction.onerror = () => reject(new Error("Installation storage unavailable"));
      });
    } catch { return crypto.randomUUID(); }
    finally { db?.close(); }
  })();
  return installation;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PREVIEW_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Notification keys unavailable"));
  });
}
type Stored = PushDeviceRegistration & { ownerHash: string; privateKey: CryptoKey };
async function closeWebNotifications(keyId?: string): Promise<void> {
  if (!keyId) return;
  try {
    const registration = await navigator.serviceWorker?.getRegistration("/firebase-messaging-sw.js");
    for (const notification of await registration?.getNotifications() ?? []) {
      if (notification.data?.recipient_key_id === keyId) notification.close();
    }
  } catch { /* Key removal remains effective if the system tray is unavailable. */ }
}
async function webKeys(userId: string, generation: number): Promise<PushDeviceRegistration> {
  const ownerHash = previewBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId))));
  const db = await database();
  try {
    const current = await new Promise<Stored | undefined>((resolve, reject) => {
      const request = db.transaction("keys").objectStore("keys").get("active");
      request.onsuccess = () => resolve(request.result as Stored | undefined);
      request.onerror = () => reject(new Error("Notification keys unavailable"));
    });
    if (generation !== revision) throw new Error("Notification session changed");
    if (current?.ownerHash === ownerHash) return current;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("keys", "readwrite");
      transaction.objectStore("keys").delete("active");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("Notification keys unavailable"));
    });
    await closeWebNotifications(current?.keyId);
    if (generation !== revision) throw new Error("Notification session changed");
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const record: Stored = { deviceId: await notificationDeviceId(), keyId: crypto.randomUUID(), ownerHash,
      publicKey: previewBase64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))), privateKey: pair.privateKey };
    if (generation !== revision) throw new Error("Notification session changed");
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("keys", "readwrite");
      transaction.objectStore("keys").put(record, "active");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("Notification keys unavailable"));
    });
    return record;
  } finally { db.close(); }
}
export async function prepareNotificationDevice(userId: string): Promise<PushDeviceRegistration> {
  if (owner !== userId) { revision++; pending = null; owner = userId; setActiveKey(null); }
  const generation = revision;
  if (!pending) {
    if (Capacitor.isNativePlatform()) {
      const operation = nativeOperations.catch(() => {}).then(async () => {
        const deviceId = await notificationDeviceId();
        if (generation !== revision || owner !== userId) throw new Error("Notification session changed");
        const { HushhNotifications } = await import("@/lib/capacitor");
        if (generation !== revision || owner !== userId) throw new Error("Notification session changed");
        return HushhNotifications.prepareNotificationKey({ userId, deviceId });
      });
      nativeOperations = operation;
      pending = operation;
    } else pending = webKeys(userId, generation);
  }
  try {
    const device = await pending;
    if (generation !== revision || owner !== userId) throw new Error("Notification session changed");
    setActiveKey(device.keyId);
    return device;
  }
  catch (error) { if (generation === revision) pending = null; throw error; }
}
export async function clearNotificationDevice(userId: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || owner !== null && owner !== userId) return;
  revision++; pending = null; owner = null; setActiveKey(null);
  if (Capacitor.isNativePlatform()) {
    const operation = nativeOperations.catch(() => {}).then(async () => {
      const { HushhNotifications } = await import("@/lib/capacitor");
      if (!signal?.aborted) await HushhNotifications.clearNotificationKey({ userId });
    });
    nativeOperations = operation;
    await operation;
    return;
  }
  const ownerHash = previewBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId))));
  const db = await database();
  try {
    let removedKeyId: string | undefined;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("keys", "readwrite");
      const store = transaction.objectStore("keys");
      const read = store.get("active");
      read.onsuccess = () => {
        const current = read.result as Stored | undefined;
        if (!signal?.aborted && current?.ownerHash === ownerHash) {
          removedKeyId = current.keyId;
          store.delete("active");
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("Notification key cleanup unavailable"));
    });
    await closeWebNotifications(removedKeyId);
  } finally { db.close(); }
}
