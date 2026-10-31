"use client";

import { CacheService } from "@/lib/services/cache-service";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { withDeadline } from "@/lib/utils/with-deadline";
import type { PacketGuard } from "@/lib/services/drive-packet-service";

const TTL_MS = 30_000;
export const DRIVE_PACKET_READ_BUDGET_MS = 8_000;
const PREFIX = "drive_packet_";
type Flight = { promise: Promise<unknown>; queued: boolean; trailing: boolean; cancelled: boolean; guards: Set<PacketGuard>; loader: (guard: PacketGuard) => Promise<unknown> };
const flights = new Map<string, Flight>();
const versions = new Map<string, number>();
let subscribed = false;

function key(sessionKey: string, resource: string): string {
  // Session keys contain the validated owner and auth/vault generations, never credentials.
  const owner = sessionKey.split(":", 1)[0];
  if (!owner || !resource || !sessionKey.includes(":")) throw new Error("invalid_packet_resource");
  return `${PREFIX}${owner}_${JSON.stringify([sessionKey, resource])}`;
}
function cancelKeys(matches: (key: string) => boolean) {
  for (const [key, flight] of flights) if (matches(key)) { flight.cancelled = true; flights.delete(key); }
  for (const key of versions.keys()) if (matches(key)) versions.delete(key);
}
function observeLifecycle() {
  if (subscribed) return;
  subscribed = true;
  const cache = CacheService.getInstance();
  subscribeVaultSessionEpoch(() => {
    cancelKeys(() => true);
    cache.invalidatePattern(PREFIX);
  });
  cache.subscribe(event => {
    if (event.type === "clear") cancelKeys(() => true);
    if (event.type === "invalidate_user") cancelKeys(key => key.startsWith(`${PREFIX}${event.userId}_`));
    if (event.type === "invalidate") cancelKeys(key => event.keys.includes(key));
  });
}

/** Packet presentation snapshots use the existing memory cache; no device persistence.
 * One flight per session/resource coalesces bursts into at most one reconciliation.
 */
export class DrivePacketResourceService {
  static peek<T>(sessionKey: string, resource: string): T | null {
    observeLifecycle();
    return CacheService.getInstance().peek<T>(key(sessionKey, resource))?.data ?? null;
  }
  /** Publish an authoritative parsed mutation receipt, never an optimistic value. */
  static publish<T>(sessionKey: string, resource: string, guard: PacketGuard, value: T): void {
    guard();
    this.invalidate(sessionKey, resource);
    CacheService.getInstance().set(key(sessionKey, resource), value, TTL_MS);
  }
  static invalidate(sessionKey: string, resource: string): void {
    observeLifecycle();
    const resourceKey = key(sessionKey, resource);
    versions.set(resourceKey, (versions.get(resourceKey) ?? 0) + 1);
    const flight = flights.get(resourceKey);
    if (flight && !flight.trailing) flight.queued = true;
    // Retain readable memory while the authoritative refresh reconciles it.
  }
  static load<T>(sessionKey: string, resource: string, guard: PacketGuard, loader: (guard: PacketGuard) => Promise<T>, options: {
    force?: boolean;
    /** Domain revision ordering, applied only against the same session/resource. */
    reconcile?: (previous: T, incoming: T) => T;
  } = {}): Promise<T> {
    observeLifecycle();
    guard();
    const resourceKey = key(sessionKey, resource), cache = CacheService.getInstance();
    const active = flights.get(resourceKey);
    if (active) {
      active.guards.add(guard);
      if (options.force && !active.trailing) { active.queued = true; active.loader = loader; }
      return active.promise.then(value => { guard(); return value as T; });
    }
    const cached = cache.peek<T>(resourceKey);
    if (!options.force && cached?.isFresh && !versions.has(resourceKey)) return Promise.resolve(cached.data);
    const flight: Flight = { promise: Promise.resolve(), queued: false, trailing: false, cancelled: false, guards: new Set([guard]), loader };
    const deadline = Date.now() + DRIVE_PACKET_READ_BUDGET_MS;
    const current = () => {
      let authorized = false;
      for (const consumer of flight.guards) {
        try { consumer(); authorized = true; break; } catch { /* Retired mount. */ }
      }
      if (!authorized || flight.cancelled || flights.get(resourceKey) !== flight || Date.now() >= deadline) throw new Error("packet_resource_retired");
    };
    flights.set(resourceKey, flight);
    flight.promise = withDeadline((async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const version = versions.get(resourceKey) ?? 0;
        const value = await flight.loader(current) as T;
        current();
        const changed = version !== (versions.get(resourceKey) ?? 0);
        if (attempt === 0 && (changed || flight.queued)) {
          flight.trailing = true; flight.queued = false; continue;
        }
        // A second mutation during reconciliation leaves the last safe snapshot
        // intact. A later refresh can retry; an obsolete response cannot win.
        if (changed) throw new Error("packet_resource_changed");
        const previous = cache.peek<T>(resourceKey)?.data;
        const result = previous !== undefined && options.reconcile ? options.reconcile(previous, value) : value;
        cache.set(resourceKey, result, TTL_MS);
        versions.delete(resourceKey);
        return result;
      }
      throw new Error("packet_resource_changed");
    })(), deadline).finally(() => {
      flight.cancelled = true;
      if (flights.get(resourceKey) === flight) flights.delete(resourceKey);
    });
    return flight.promise.then(value => { guard(); return value as T; });
  }
}
