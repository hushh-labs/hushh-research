"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { getAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { FinancialPacketSummaryService, type FinancialPacketSummary } from "@/lib/services/financial-packet-summary-service";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { subscribeToConnectionGraphChanges } from "@/lib/connections/connection-graph-events";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { buildConnectedSystemRoute } from "@/lib/navigation/routes";
import { FinancialPacketPrivateRequest } from "./financial-packet-private-request";
import { PacketRows } from "./packet-rows";
import { PacketPage, type PacketPageAction } from "./packet-page";
import { periodLabel } from "./packet-copy";

type Props = { personRef: string; ownerName: string; refreshKey?: string; onConnect: () => void | Promise<unknown>; onUnlock: () => void; connecting?: boolean };
export function financialSummaryCount(packet: FinancialPacketSummary): string {
  if (packet.documentCount === null) return "Search count not available yet";
  const noun = packet.countBasis === "discovery_matches" ? packet.documentCount === 1 ? "search match" : "search matches" : packet.documentCount === 1 ? "file" : "files";
  return `${packet.documentCount} ${noun}${packet.complete ? "" : " found so far"}`;
}
const labels: Record<FinancialPacketSummary["viewerAction"], string> = {
  owner: "View your files", connect: "Connect to request", pending: "Connection request sent", request: "Request for $5",
  view_request: "View request", view_files: "View files", unavailable: "Not available right now",
};
/** The same owner-published metadata view for a person route or its Hub/Profile pane. */
export function FinancialPacketSummaries(props: Props) {
  const { user } = useAuth();
  return user ? <SummarySession key={`${user.uid}:${getAuthSessionGeneration()}:${props.personRef}`} {...props} user={user} /> : null;
}
function SummarySession({ personRef, ownerName, refreshKey, onConnect, onUnlock, connecting, user }: Props & { user: NonNullable<ReturnType<typeof useAuth>["user"]> }) {
  const { isVaultUnlocked } = useVault();
  const lease = useMemo(() => ({ live: false, serial: 0, pages: 1, personRef, user, owner: snapshotValidatedAuthSessionOwner() }), [personRef, user]);
  useLayoutEffect(() => { lease.live = true; return () => { lease.live = false; lease.serial++; }; }, [lease]);
  const guard = useCallback(() => {
    if (!lease.live || !user || lease.owner?.userId !== user.uid || !isValidatedAuthSessionOwnerCurrent(lease.owner)) throw new Error("session_changed");
  }, [lease, user]);
  const [value, setValue] = useState<{ packets: FinancialPacketSummary[]; cursor: string | null; loaded: boolean; error: boolean; busy: boolean }>({ packets: [], cursor: null, loaded: false, error: false, busy: false });
  const [opened, setOpened] = useState<FinancialPacketSummary | null>(null), [privateOpen, setPrivateOpen] = useState(false);
  const load = useCallback(async (cursor?: string | null) => {
    try { guard(); } catch { return; }
    const serial = ++lease.serial;
    const current = () => { guard(); if (serial !== lease.serial) throw new Error("superseded"); };
    setValue(value => ({ ...value, busy: true, error: false }));
    try {
      const token = await lease.user.getIdToken(); current();
      const packets: FinancialPacketSummary[] = [], seen = new Set<string>();
      let next = cursor, result, page = 0;
      do {
        result = await FinancialPacketSummaryService.list(lease.personRef, token, current, next);
        current(); packets.push(...result.packets); page++;
        next = result.nextCursor;
        if (next && seen.has(next)) throw new Error("invalid_cursor");
        if (next) seen.add(next);
      } while (!cursor && next && page < lease.pages);
      if (cursor) lease.pages++; else lease.pages = page;
      result = { packets: [...new Map(packets.map(packet => [packet.packetId, packet])).values()], nextCursor: result!.nextCursor };
      current(); setValue(previous => ({ packets: cursor ? [...previous.packets.filter(old => !result.packets.some(item => item.packetId === old.packetId)), ...result.packets] : result.packets,
        cursor: result.nextCursor, loaded: true, error: false, busy: false }));
      if (!cursor) setOpened(previous => previous ? result.packets.find(item => item.packetId === previous.packetId) ?? null : null);
    } catch { try { current(); setValue(value => ({ ...value, error: true, busy: false })); } catch { /* Retired viewer or person. */ } }
  }, [guard, lease]);
  useEffect(() => { void load(); return () => { lease.serial++; }; }, [lease, load, refreshKey]);
  useEffect(() => {
    const refresh = () => { void load(); };
    const unsubscribe = subscribeToConnectionGraphChanges(refresh);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30000);
    return () => { unsubscribe(); window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, refresh); clearInterval(timer); };
  }, [load]);
  const close = () => { setOpened(null); setPrivateOpen(false); };
  const openPrivate = () => { if (!isVaultUnlocked) onUnlock(); setPrivateOpen(true); };
  const actions: PacketPageAction[] = !opened ? [] : opened.viewerAction === "connect"
    ? [{ id: "connect", label: connecting ? "Sending…" : labels.connect, disabled: connecting, onSelect: () => { void Promise.resolve(onConnect()).then(() => load()); } }]
    : opened.viewerAction === "owner" ? [{ id: "owner", label: labels.owner, href: buildConnectedSystemRoute("google_drive") }]
      : ["request", "view_request", "view_files"].includes(opened.viewerAction) ? [{ id: "request", label: labels[opened.viewerAction], onSelect: openPrivate }] : [];
  return <section aria-label="Financial documents" className="consent-presentation-surface">
    <SettingsGroup title="Financial documents" density="compact"><PacketRows items={value.packets.map(packet => ({ id: packet.packetId,
      title: periodLabel({ start: packet.periodStart, end: packet.periodEnd }) ?? packet.title,
      statusLine: `${financialSummaryCount(packet)} · ${labels[packet.viewerAction]}`, tone: packet.availability === "ready" ? "ready" : "waiting",
      amountCents: packet.viewerAction === "request" ? 500 : null, onOpen: () => { setPrivateOpen(false); setOpened(packet); } }))} />
      {value.loaded && !value.error && !value.packets.length && <SettingsRow title="No public packets" description="Only summaries this person chooses to publish appear here." />}
      {value.busy && !value.loaded && <SettingsRow title="Loading financial documents…" />}
      {value.error && <SettingsRow title="Couldn’t refresh financial documents" trailing={<Button variant="ghost" onClick={() => void load()}>Retry</Button>} />}
      {value.cursor && <Button variant="ghost" disabled={value.busy} onClick={() => void load(value.cursor)}>Load more</Button>}
    </SettingsGroup>
    {opened && privateOpen && isVaultUnlocked ? <FinancialPacketPrivateRequest key={`${opened.packetId}:${opened.version}`} summary={opened} personRef={personRef} ownerName={ownerName} onClose={close} onChanged={() => void load()} /> : opened && <PacketPage open onOpenChange={open => { if (!open) close(); }} title={opened.title}
      description={opened.documentCount === null ? "Preparing search results" : opened.complete ? "Drive search results" : opened.documentCount > 0 ? "Files found so far" : "Search in progress"} actions={actions} sections={[
        { id: "summary", title: periodLabel({ start: opened.periodStart, end: opened.periodEnd }) ?? "Search period", rows: [{ id: "count", title: financialSummaryCount(opened) },
          { id: "basis", title: "Matches from Google Drive search", description: "Search matches are not verified financial records. File names and original links stay private." },
          { id: "status", title: labels[opened.viewerAction] }] },
        ...opened.viewerAction === "request" ? [{ id: "price", title: "One-time price", rows: [{ id: "price", title: "$5", description: `You pay after ${ownerName} approves.` }] }] : [],
      ]} />}
  </section>;
}
