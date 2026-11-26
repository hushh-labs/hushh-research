import { OneLocationService } from "@/lib/one-location/service";
import { ApiError } from "@/lib/services/api-client";

const PREFIX = "one:location-pending-stops:";
const CHANGE = "one:location-pending-stops";
const memory = new Map<string, Set<string>>();
const flushed = new Map<string, Promise<boolean>>();
let revision = 0;

function pending(owner: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  if (memory.has(owner)) return new Set(memory.get(owner));
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(PREFIX + owner) ?? "[]");
    if (Array.isArray(raw)) return new Set(raw.filter((value): value is string => typeof value === "string"));
  } catch { /* local storage unavailable */ }
  return new Set(memory.get(owner));
}

function save(owner: string, ids: Set<string>) {
  try {
    window.localStorage.setItem(PREFIX + owner, JSON.stringify([...ids]));
    memory.delete(owner);
  } catch { memory.set(owner, ids); }
  revision += 1;
  window.dispatchEvent(new Event(CHANGE));
}

export function queueLocationStop(owner: string, grantId: string) {
  const ids = pending(owner);
  ids.add(grantId);
  save(owner, ids);
}

export function hasQueuedLocationStop(owner: string | null | undefined, grantId: string) {
  return Boolean(owner && pending(owner).has(grantId));
}

export const locationStopQueueRevision = () => revision;

export function subscribeLocationStopQueue(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key?.startsWith(PREFIX)) return;
    memory.delete(event.key.slice(PREFIX.length));
    revision += 1;
    callback();
  };
  window.addEventListener(CHANGE, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE, callback);
    window.removeEventListener("storage", onStorage);
  };
}

export function flushLocationStops(owner: string, token: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.onLine) return Promise.resolve(false);
  const ongoing = flushed.get(owner);
  if (ongoing) return ongoing;
  const result = (async () => {
    const ids = pending(owner);
    let changed = false;
    for (const id of ids) {
      try {
        await OneLocationService.revokeGrant({ vaultOwnerToken: token, grantId: id });
      } catch (error) {
        // A purged or expired grant no longer has an authorized publisher.
        if (!(error instanceof ApiError && [404, 410].includes(error.status))) continue;
      }
      const left = pending(owner);
      left.delete(id);
      save(owner, left);
      changed = true;
    }
    return changed;
  })().finally(() => flushed.delete(owner));
  flushed.set(owner, result);
  return result;
}
