"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { CONSENT_STATE_CHANGED_EVENT, dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { FinancialPacketSummaryService, type PacketPublication } from "@/lib/services/financial-packet-summary-service";
import { useDrivePacketSession } from "@/components/consent/drive-packet-catalog";
import type { NativeDrawerRow } from "@/lib/capacitor/native-drawers";
import { periodLabel } from "./packet-copy";

type Value = { packets: PacketPublication[]; cursor: string | null; loaded: boolean; busy: boolean; error: boolean; message: string };
const empty = (): Value => ({ packets: [], cursor: null, loaded: false, busy: false, error: false, message: "" });
export const PACKET_PUBLICATIONS_NOTICE = "Hide a previously published Financial summary, even if Drive is disconnected or background access is off. A saved publication may already be inactive. This does not revoke files already shared.";
/** Scalar owner receipts are the only input; this manager never opens a Drive catalog or provider. */
export function usePacketPublications(enabled: boolean) {
  const { key, token, guard } = useDrivePacketSession("owner-packet-publications");
  const lease = useMemo(() => ({ key, token, guard, live: false, serial: 0, lock: false }), [key, token, guard]);
  useLayoutEffect(() => { lease.live = enabled; return () => { lease.live = false; lease.serial++; }; }, [enabled, lease]);
  const [stored, setStored] = useState<{ lease: typeof lease; value: Value } | null>(null);
  const value = enabled && stored?.lease === lease ? stored.value : empty();
  const current = useCallback(() => { if (!lease.live || !lease.token) throw new Error("inactive"); lease.guard(); }, [lease]);
  const change = useCallback((update: (value: Value) => Value) => {
    try { current(); setStored(previous => ({ lease, value: update(previous?.lease === lease ? previous.value : empty()) })); } catch { /* Retired owner. */ }
  }, [current, lease]);
  const load = useCallback(async (cursor?: string | null) => {
    try { current(); } catch { return; }
    const serial = ++lease.serial;
    const valid = () => { current(); if (serial !== lease.serial) throw new Error("superseded"); };
    change(value => ({ ...value, busy: true, error: false }));
    try {
      const result = await FinancialPacketSummaryService.publications(lease.token!, valid, cursor);
      valid(); change(previous => ({ ...previous, packets: cursor ? [...previous.packets.filter(old => !result.packets.some(item => item.packetId === old.packetId)), ...result.packets] : result.packets,
        cursor: result.nextCursor, loaded: true, busy: false, error: false }));
    } catch { try { valid(); change(value => ({ ...value, busy: false, error: true })); } catch { /* Retired read. */ } }
  }, [change, current, lease]);
  useEffect(() => { if (enabled) void load(); }, [enabled, load]);
  useEffect(() => {
    const refresh = () => { if (enabled) void load(); };
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
  }, [enabled, load]);
  const hide = async (packet: PacketPublication) => {
    if (lease.lock || !value.packets.some(item => item.packetId === packet.packetId && item.publicSummary.revision === packet.publicSummary.revision)) return;
    try { current(); } catch { return; }
    lease.lock = true; change(value => ({ ...value, busy: true, message: "" }));
    try {
      await FinancialPacketSummaryService.publish(lease.token!, packet.packetId, packet.publicSummary, false, current);
      current(); change(value => ({ ...value, packets: value.packets.filter(item => item.packetId !== packet.packetId), message: "Public summary hidden." }));
      dispatchConsentStateChanged();
    } catch { try { current(); change(value => ({ ...value, message: "Couldn’t confirm this change. Refresh before trying again." })); await load(); } catch { /* Retired owner. */ } }
    finally { lease.lock = false; change(value => ({ ...value, busy: false })); }
  };
  return { ...value, enabled, load, hide, mutationPending: () => lease.lock };
}
export type PacketPublicationsModel = ReturnType<typeof usePacketPublications>;
export function PacketPublicationsView({ model }: { model: PacketPublicationsModel }) {
  if (!model.enabled) return null;
  return <SettingsGroup title="Public summary settings" density="compact">
    <SettingsRow title="Publication controls" description={PACKET_PUBLICATIONS_NOTICE} />
    {model.packets.map(packet => <SettingsRow key={packet.packetId} title={periodLabel({ start: packet.periodStart, end: packet.periodEnd }) ?? packet.title}
      description="Saved publication" trailing={<Button variant="ghost" size="compact" disabled={model.busy} onClick={() => void model.hide(packet)}>Hide public summary</Button>} />)}
    {model.loaded && !model.packets.length && !model.error && <SettingsRow title="No saved publications" />}
    {model.busy && !model.loaded && <SettingsRow title="Loading publication controls…" />}
    {model.error && <SettingsRow title="Couldn’t load publication controls" />}
    <SettingsRow title="Refresh publication controls" onClick={() => { if (!model.busy) void model.load(); }} chevron />
    {model.cursor && <Button variant="ghost" disabled={model.busy} onClick={() => void model.load(model.cursor)}>Load more publications</Button>}
    {model.message && <p role="status" className="px-4 text-sm">{model.message}</p>}
  </SettingsGroup>;
}
/** Existing native row ports own selection and stale-visit rejection. */
export function packetPublicationsNative(model: PacketPublicationsModel | undefined, ports: {
  read: (key: string, label: string, detail?: string) => NativeDrawerRow;
  bind: (key: string, label: string, action: () => void | Promise<unknown>, extra?: Partial<NativeDrawerRow>) => NativeDrawerRow;
}): NativeDrawerRow[] {
  if (!model?.enabled) return [];
  const { read, bind } = ports;
  return [read("publications-disclosure", "Public summary settings", PACKET_PUBLICATIONS_NOTICE),
    ...model.packets.map(packet => bind(`publication:${packet.packetId}`, "Hide public summary", () => model.hide(packet),
      { detail: periodLabel({ start: packet.periodStart, end: packet.periodEnd }) ?? packet.title, enabled: !model.busy })),
    ...(model.loaded && !model.packets.length && !model.error ? [read("publications-empty", "No saved publications")] : []),
    ...(model.error ? [read("publications-error", "Couldn’t load publication controls")] : []),
    bind("publications-refresh", "Refresh publication controls", () => model.load(), { enabled: !model.busy }),
    ...(model.cursor ? [bind("publications-more", "Load more publications", () => model.load(model.cursor), { enabled: !model.busy })] : []),
    ...(model.message ? [read("publications-message", model.message)] : [])];
}
