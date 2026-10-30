"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { CONSENT_STATE_CHANGED_EVENT, dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { FinancialPacketSummaryService, type PacketProfileVisibility } from "@/lib/services/financial-packet-summary-service";
import { DrivePacketResourceService } from "@/lib/services/drive-packet-resource-service";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { useDrivePacketSession } from "@/components/consent/drive-packet-catalog";
import type { NativeDrawerRow } from "@/lib/capacitor/native-drawers";

type Value = { preference: PacketProfileVisibility | null; loaded: boolean; busy: boolean; error: boolean };
const RESOURCE = "profile-visibility";
export const PACKET_PUBLICATIONS_NOTICE = "Financial packet details only. Files stay private.";

/** One owner preference, independent of Drive connectivity and file-sharing authority. */
export function usePacketPublications(enabled: boolean) {
  const { key, token, guard } = useDrivePacketSession("owner-packet-publications");
  const lease = useMemo(() => ({ key, token, guard, live: false, lock: false,
    toast: undefined as ReturnType<typeof morphyToast.promise> | undefined }), [key, token, guard]);
  useLayoutEffect(() => {
    lease.live = enabled;
    return () => {
      lease.live = false;
      const toastId = lease.toast?.valueOf();
      if (typeof toastId === "string" || typeof toastId === "number") morphyToast.dismiss(toastId);
    };
  }, [enabled, lease]);
  const empty = useCallback((): Value => {
    const preference = enabled && token ? DrivePacketResourceService.peek<PacketProfileVisibility>(key, RESOURCE) : null;
    return { preference, loaded: Boolean(preference), busy: false, error: false };
  }, [enabled, key, token]);
  const [stored, setStored] = useState<{ lease: typeof lease; value: Value } | null>(null);
  const value = enabled && stored?.lease === lease ? stored.value : empty();
  const current = useCallback(() => { if (!lease.live || !lease.token) throw new Error("inactive"); lease.guard(); }, [lease]);
  const change = useCallback((update: (value: Value) => Value) => {
    try { current(); setStored(previous => ({ lease, value: update(previous?.lease === lease ? previous.value : empty()) })); } catch { /* Retired owner. */ }
  }, [current, empty, lease]);
  const load = useCallback(async (force = false) => {
    try { current(); } catch { return; }
    change(value => ({ ...value, busy: true, error: false }));
    try {
      const preference = await DrivePacketResourceService.load(lease.key, RESOURCE, current,
        valid => FinancialPacketSummaryService.visibility(lease.token!, valid), {
          force, reconcile: (previous, incoming) => incoming.revision >= previous.revision ? incoming : previous,
        });
      current(); change(value => ({ ...value, preference: !value.preference || preference.revision >= value.preference.revision ? preference : value.preference,
        loaded: true, busy: false, error: false }));
    } catch { try { current(); change(value => ({ ...value, busy: false, error: true })); } catch { /* Retired read. */ } }
  }, [change, current, lease]);
  useEffect(() => { if (enabled) void load(); }, [enabled, load]);
  useEffect(() => {
    const refresh = () => { if (enabled) void load(true); };
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
  }, [enabled, load]);
  const setEnabled = async (next: boolean) => {
    if (lease.lock || value.busy || !value.preference || next === value.preference.enabled) return;
    try { current(); } catch { return; }
    lease.lock = true; change(value => ({ ...value, busy: true }));
    const isCurrent = () => { try { current(); return true; } catch { return false; } };
    try {
      const operation = FinancialPacketSummaryService.setVisibility(lease.token!, value.preference, next, current);
      lease.toast = morphyToast.promise(operation, { isCurrent, loading: "Saving…", success: "Profile updated", error: "Couldn’t confirm the change. Refresh to check." });
      const preference = await operation;
      current();
      DrivePacketResourceService.publish(lease.key, RESOURCE, current, preference);
      change(value => ({ ...value, preference, loaded: true, error: false }));
      dispatchConsentStateChanged();
    } catch { if (isCurrent()) await load(true); }
    finally { lease.lock = false; change(value => ({ ...value, busy: false })); }
  };
  return { ...value, enabled, load, setEnabled, mutationPending: () => lease.lock };
}
export type PacketPublicationsModel = ReturnType<typeof usePacketPublications>;

export function PacketPublicationsView({ model }: { model: PacketPublicationsModel }) {
  if (!model.enabled) return null;
  return <SettingsGroup density="compact">
    <SettingsRow title="Show on profile" description={PACKET_PUBLICATIONS_NOTICE}
      trailing={model.preference ? <Switch size="ios" aria-label="Show on profile" checked={model.preference.enabled}
        disabled={model.busy} onCheckedChange={next => void model.setEnabled(next)} />
        : <Skeleton aria-label="Loading profile setting" className="h-[31px] w-[51px] rounded-full" />} />
    {model.error && <SettingsRow title="Couldn’t load profile setting" description="Try again" onClick={() => { if (!model.busy) void model.load(true); }} chevron />}
  </SettingsGroup>;
}

/** Native selection uses the same owner preference and guarded writer. */
export function packetPublicationsNative(model: PacketPublicationsModel | undefined, ports: {
  read: (key: string, label: string, detail?: string) => NativeDrawerRow;
  bind: (key: string, label: string, action: () => void | Promise<unknown>, extra?: Partial<NativeDrawerRow>) => NativeDrawerRow;
  toggle: (key: string, label: string, selected: boolean, enabled: boolean, update: (next: boolean) => void) => NativeDrawerRow;
}): NativeDrawerRow[] {
  if (!model?.enabled) return [];
  const { read, bind, toggle } = ports;
  return [
    model.preference ? { ...toggle("profile-visibility", "Show on profile", model.preference.enabled,
      !model.busy, next => { void model.setEnabled(next); }), detail: PACKET_PUBLICATIONS_NOTICE }
      : read("profile-visibility-loading", "Show on profile", "Loading profile setting…"),
    ...(model.error ? [bind("profile-visibility-retry", "Retry profile setting", () => model.load(true), { enabled: !model.busy })] : []),
  ];
}
