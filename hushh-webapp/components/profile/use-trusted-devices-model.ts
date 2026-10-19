"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { nativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { puppyAccessError } from "@/lib/trusted-device/puppy-access-error";
import { useVault } from "@/lib/vault/vault-context";
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
function createReadScope(ownerId: string | null, epoch: number, enabled: boolean, authGeneration: number | undefined,
  ..._credentials: unknown[]) {
  // Credentials invalidate the visit without retaining another copy.
  return { active: false, ownerId, epoch, enabled, authGeneration, request: ++nextReadScope, actionGeneration: 0,
    pending: null as symbol | null, mutation: 0, readStarted: 0, readSucceeded: 0,
    auth: snapshotValidatedAuthSessionOwner() };
}

/** One cache and operation owner for web and native presentation. No credentials
 * or device identifiers enter the native action handles. */
export function useTrustedDevicesModel(ownerId: string | null, enabled: boolean) {
  const { vaultOwnerToken } = useVault();
  const visit = useId();
  const epoch = snapshotVaultSessionEpoch();
  const authGeneration = snapshotValidatedAuthSessionOwner()?.generation;
  const scope = useMemo(() => createReadScope(ownerId, epoch, enabled, authGeneration, vaultOwnerToken),
    [ownerId, epoch, enabled, vaultOwnerToken, authGeneration]);
  useLayoutEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  const actionGeneration = scope.actionGeneration;
  const current = useCallback(() => enabled && scope.active && !!scope.auth && scope.auth.userId === ownerId &&
    scope.auth.generation === scope.authGeneration && isValidatedAuthSessionOwnerCurrent(scope.auth) &&
    scope.epoch === snapshotVaultSessionEpoch(), [enabled, scope, ownerId]);
  const canAct = () => {
    const privacy = nativePrivacyObservation().state;
    return current() && actionGeneration === scope.actionGeneration &&
      (!Capacitor.isNativePlatform() || !!privacy && privacy.appIsActive && !privacy.shielded);
  };
  const cacheKey = CACHE_KEYS.TRUSTED_DEVICES(ownerId || "anonymous");
  const emptyStatus = useCallback(() => ({ scope, confirmation: null as string | null, busy: false, error: "", uncertain: false,
    unlinked: [] as readonly string[], puppyAccess: {} as Record<string, boolean>, byocReady: false,
    changingPuppy: null as string | null, puppyNotice: "", pendingPuppyWithdrawal: [] as string[], pendingPodRevocations: [] as string[] }), [scope]);
  const [local, setLocal] = useState(emptyStatus);
  const status = local.scope === scope ? local : emptyStatus();
  const patch = useCallback((next: Partial<typeof local>) => {
    if (current()) setLocal(previous => ({ ...(previous.scope === scope ? previous : emptyStatus()), ...next }));
  }, [current, emptyStatus, scope]);
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
  const puppyDeviceIds = devices.filter(device => device.platform === "macos" && device.status === "active").map(device => device.device_id).join(",");
  useEffect(() => {
    if (!current() || !vaultOwnerToken) return;
    let cancelled = false;
    void ApiService.getPersonalAgentStatus().then(value => {
      if (!cancelled && current()) patch({ byocReady: value.hostingMode === "byoc" && value.state === "active" });
    }).catch(() => { if (!cancelled && current()) patch({ byocReady: false }); });
    void Promise.all(puppyDeviceIds.split(",").filter(Boolean).map(async id => [id, await ApiService.getPuppyAccess(id, vaultOwnerToken)] as const))
      .then(entries => { if (!cancelled && current()) patch({ puppyAccess: Object.fromEntries(entries) }); })
      .catch(() => { if (!cancelled && current()) patch({ puppyAccess: {} }); });
    return () => { cancelled = true; };
  }, [current, patch, vaultOwnerToken, puppyDeviceIds]);
  const changePuppyAccess = async (id: string) => {
    if (!canAct() || scope.pending || status.uncertain || !status.byocReady || !vaultOwnerToken || !ownerId ||
        status.puppyAccess[id] === undefined || !devices.some(device => device.device_id === id && device.status === "active" && device.platform === "macos")) return;
    const enabled = status.pendingPuppyWithdrawal.includes(id) ? false : !status.puppyAccess[id];
    const request = Symbol(); scope.pending = request; scope.actionGeneration += 1;
    const admittedGeneration = scope.actionGeneration;
    const admittedCurrent = () => {
      const privacy = nativePrivacyObservation().state;
      return current() && scope.actionGeneration === admittedGeneration &&
        (!Capacitor.isNativePlatform() || !!privacy && privacy.appIsActive && !privacy.shielded);
    };
    patch({ changingPuppy: id, puppyNotice: "" });
    try {
      const outcome = await ApiService.setPuppyAccess(id, enabled, vaultOwnerToken, admittedCurrent, ownerId);
      if (!admittedCurrent()) return;
      patch({ puppyAccess: { ...status.puppyAccess, [id]: outcome.enabled },
        pendingPuppyWithdrawal: outcome.revocationPending ? [...new Set([...status.pendingPuppyWithdrawal, id])] : status.pendingPuppyWithdrawal.filter(value => value !== id),
        puppyNotice: outcome.revocationPending ? "New Puppy access is disabled. Existing pod access still needs withdrawal; retry when your pod reconnects." : outcome.enabled ? "Puppy is enabled." : "Puppy is disabled." });
    } catch (error) { if (current()) patch({ puppyNotice: puppyAccessError(error, enabled) }); }
    finally { if (scope.pending === request) scope.pending = null; patch({ changingPuppy: null }); }
  };
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
        !devices.some(device => device.device_id === id && (device.status === "active" || status.pendingPodRevocations.includes(id)))) return;
    scope.actionGeneration += 1;
    patch({ confirmation: id, error: "" });
  };
  const confirm = async () => {
    if (!canAct() || scope.pending || status.uncertain || !confirmation || (confirmation.status !== "active" && !status.pendingPodRevocations.includes(confirmation.device_id))) return;
    const request = Symbol(); scope.pending = request; scope.mutation += 1; scope.actionGeneration += 1;
    patch({ busy: true, error: "" });
    let committed = false;
    try {
      // Invalidate the consumed callback immediately, but retain this admitted
      // operation's dispatch fence through the async transport boundary.
      const admittedGeneration = scope.actionGeneration;
      const result = await ApiService.revokeTrustedDeviceEverywhere(confirmation.device_id, ownerId!, () => {
        const privacy = nativePrivacyObservation().state;
        return current() && scope.actionGeneration === admittedGeneration &&
          (!Capacitor.isNativePlatform() || !!privacy && privacy.appIsActive && !privacy.shielded);
      });
      const response = result.hub;
      const receipt = response.ok ? await response.clone().json().catch(() => ({})) : {};
      const podRevocationPending = !result.pod.delivered && !("unpinned" in result.pod && receipt.podBindingVersion === 0);
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
      patch({ confirmation: null, unlinked: [...status.unlinked, confirmation.device_id],
        pendingPodRevocations: podRevocationPending ? [...new Set([...status.pendingPodRevocations, confirmation.device_id])] : status.pendingPodRevocations.filter(id => id !== confirmation.device_id) });
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
  return { puppyAccess: status.puppyAccess, byocReady: status.byocReady, changingPuppy: status.changingPuppy, puppyNotice: status.puppyNotice,
    pendingPuppyWithdrawal: status.pendingPuppyWithdrawal, pendingPodRevocations: status.pendingPodRevocations, changePuppyAccess, devices, confirmation, busy: status.busy, uncertain: status.uncertain,
    loading: resource.loading && resource.data === null, refreshing: resource.refreshing,
    error: status.error || resource.error || "", refresh, cancel, choose, confirm };
}

export type TrustedDevicesModel = ReturnType<typeof useTrustedDevicesModel>;
