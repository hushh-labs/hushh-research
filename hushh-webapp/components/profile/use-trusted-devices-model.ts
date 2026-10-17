"use client";

import { useId, useLayoutEffect, useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { nativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { ApiService } from "@/lib/services/api-service";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { DeviceSyncFields } from "@/lib/trusted-device/sync-display";

export interface TrustedDevice extends DeviceSyncFields {
  device_id: string;
  device_name: string;
  platform: string;
  status: "active" | "revoked";
}

const UNLINK_WARNING = "This device will stop syncing immediately, and its local copy of your vault will be sealed on the device. Reconnecting requires approving it again in your browser and setting up the local vault from scratch.";
export { UNLINK_WARNING };
let nextReadScope = 0;
function createReadScope() { return ++nextReadScope; }

/** One cache and operation owner for web and native presentation. No credentials
 * or device identifiers enter the native action handles. */
export function useTrustedDevicesModel(ownerId: string | null, enabled: boolean) {
  const visit = useId();
  const epoch = snapshotVaultSessionEpoch();
  const scope = useMemo(() => ({ active: false, ownerId, epoch, enabled, request: createReadScope(), actionGeneration: 0,
    pending: null as symbol | null, mutation: 0, readStarted: 0, readSucceeded: 0,
    auth: snapshotValidatedAuthSessionOwner() }), [ownerId, epoch, enabled]);
  useLayoutEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  const actionGeneration = scope.actionGeneration;
  const current = () => enabled && scope.active && !!scope.auth && scope.auth.userId === ownerId &&
    isValidatedAuthSessionOwnerCurrent(scope.auth) && scope.epoch === snapshotVaultSessionEpoch();
  const canAct = () => {
    const privacy = nativePrivacyObservation().state;
    return current() && actionGeneration === scope.actionGeneration &&
      (!Capacitor.isNativePlatform() || !!privacy && privacy.appIsActive && !privacy.shielded);
  };
  const cacheKey = CACHE_KEYS.TRUSTED_DEVICES(ownerId || "anonymous");
  const [local, setLocal] = useState<{ scope: typeof scope; confirmation: string | null; busy: boolean; error: string; uncertain: boolean; unlinked: readonly string[] }>({
    scope, confirmation: null, busy: false, error: "", uncertain: false, unlinked: [],
  });
  const status = local.scope === scope ? local : { scope, confirmation: null, busy: false, error: "", uncertain: false, unlinked: [] };
  const patch = (next: Partial<typeof local>) => {
    if (current()) setLocal(previous => ({ ...(previous.scope === scope ? previous :
      { scope, confirmation: null, busy: false, error: "", uncertain: false, unlinked: [] }), ...next }));
  };
  const resource = useStaleResource<TrustedDevice[]>({
    cacheKey, enabled: !!ownerId && enabled, requestScope: `${visit}:${scope.request}`, resourceLabel: "trusted-devices",
    retainOnInvalidate: true,
    load: async () => {
      if (!current()) throw new Error("Devices unavailable.");
      const read = ++scope.readStarted;
      try {
        const response = await ApiService.listTrustedDevices(current);
        const payload = await response.json();
        if (!current() || !response.ok || !Array.isArray(payload?.devices)) throw new Error("Devices unavailable.");
        scope.readSucceeded = read;
        return payload.devices as TrustedDevice[];
      } catch { throw new Error("Devices unavailable."); }
    },
  });
  const devices = useMemo(() => enabled ? (resource.data ?? []).map(device => status.unlinked.includes(device.device_id)
    ? { ...device, status: "revoked" as const } : device) : [], [enabled, resource.data, status.unlinked]);
  const confirmation = devices.find(device => device.device_id === status.confirmation) ?? null;
  const refreshAfterCurrentReads = async () => {
    // Forced refresh may join a GET that started before an unlink. Drain that
    // read, then obtain one new successful read before accepting its verdict.
    const barrier = scope.readStarted;
    CacheService.getInstance().invalidate(cacheKey);
    let result = await resource.refresh({ force: true });
    if (current() && result !== null && scope.readSucceeded <= barrier) {
      CacheService.getInstance().invalidate(cacheKey);
      result = await resource.refresh({ force: true });
    }
    return current() && scope.readSucceeded > barrier ? result : null;
  };
  const refresh = async () => {
    if (!canAct() || scope.pending) return;
    const mutation = scope.mutation;
    // Drop a possibly stale server verdict before reconciliation. The resource
    // retains its visible rows, but a failed refresh must not clear uncertainty.
    const result = await refreshAfterCurrentReads();
    if (current() && scope.mutation === mutation && result !== null) patch({ error: "", uncertain: false });
  };
  const cancel = () => {
    if (canAct() && !scope.pending) { scope.actionGeneration += 1; patch({ confirmation: null }); }
  };
  const choose = (id: string) => {
    if (!canAct() || scope.pending || status.uncertain ||
        !devices.some(device => device.device_id === id && device.status === "active")) return;
    scope.actionGeneration += 1;
    patch({ confirmation: id, error: "" });
  };
  const confirm = async () => {
    if (!canAct() || scope.pending || status.uncertain || !confirmation || confirmation.status !== "active") return;
    const request = Symbol(); scope.pending = request; scope.mutation += 1; scope.actionGeneration += 1;
    patch({ busy: true, error: "" });
    let committed = false;
    try {
      // Invalidate the consumed callback immediately, but retain this admitted
      // operation's dispatch fence through the async transport boundary.
      const admittedGeneration = scope.actionGeneration;
      const response = await ApiService.revokeTrustedDevice(confirmation.device_id, () => {
        const privacy = nativePrivacyObservation().state;
        return current() && scope.actionGeneration === admittedGeneration &&
          (!Capacitor.isNativePlatform() || !!privacy && privacy.appIsActive && !privacy.shielded);
      });
      // A committed response invalidates its original cache even if its screen
      // departed. Never let a later visit reuse pre-revocation trust metadata.
      if (response.ok) { committed = true; CacheService.getInstance().invalidate(cacheKey); }
      if (!current()) return;
      if (!response.ok) {
        const uncertain = response.status >= 500 || response.status === 408;
        patch({ error: uncertain ? "Couldn’t confirm whether the device was unlinked. Refresh before trying again." :
          "The device could not be unlinked.", uncertain });
        return;
      }
      patch({ confirmation: null, unlinked: [...status.unlinked, confirmation.device_id] });
      const refreshed = await refreshAfterCurrentReads();
      if (current() && refreshed === null) patch({ error: "Device unlinked. Couldn’t refresh the list." });
    } catch {
      if (current()) patch({ error: committed ? "Device unlinked. Couldn’t refresh the list." :
        "Couldn’t confirm whether the device was unlinked. Refresh before trying again.", uncertain: !committed });
    } finally {
      if (scope.pending === request) scope.pending = null;
      patch({ busy: false });
    }
  };
  return { devices, confirmation, busy: status.busy, uncertain: status.uncertain,
    loading: resource.loading && resource.data === null, refreshing: resource.refreshing,
    error: status.error || resource.error || "", refresh, cancel, choose, confirm };
}

export type TrustedDevicesModel = ReturnType<typeof useTrustedDevicesModel>;
