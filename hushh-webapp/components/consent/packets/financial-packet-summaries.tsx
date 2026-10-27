"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { getAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { DrivePacketResourceService } from "@/lib/services/drive-packet-resource-service";
import { FinancialPacketSummaryService, type FinancialPacketSummary } from "@/lib/services/financial-packet-summary-service";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { subscribeToConnectionGraphChanges } from "@/lib/connections/connection-graph-events";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { useOpenerFocus } from "@/components/consent/payouts/receipts/receipt-ui";
import { buildConnectedSystemRoute } from "@/lib/navigation/routes";
import { FinancialPacketPrivateRequest } from "./financial-packet-private-request";
import { PACKET_TONE_ICONS } from "./packet-rows";
import { PacketPage, type PacketPageAction } from "./packet-page";
import { periodLabel } from "./packet-copy";

type SummarySnapshot = { packets: FinancialPacketSummary[]; cursor: string | null; pages: number };
const SUMMARY_RESOURCE = "financial-summaries";

/** Monotonic metadata never preserves an older permission to request or view. */
function reconcileSummaries(previous: SummarySnapshot, incoming: SummarySnapshot): SummarySnapshot {
  const known = new Map(previous.packets.map(packet => [packet.packetId, packet]));
  return { ...incoming, packets: incoming.packets.map(packet => {
    const old = known.get(packet.packetId);
    const older = old && (packet.version < old.version || packet.version === old.version && old.updatedAt !== null
      && (packet.updatedAt === null || packet.updatedAt < old.updatedAt));
    return older ? { ...packet, version: old.version, documentCount: old.documentCount, countBasis: old.countBasis,
      complete: old.complete, updatedAt: old.updatedAt, saleDocumentCount: old.saleDocumentCount } : packet;
  }) };
}

type Props = { personRef: string; ownerName: string; refreshKey?: string; onConnect: () => void | Promise<unknown>; onUnlock: () => void; connecting?: boolean };
export function financialSummaryCount(packet: FinancialPacketSummary): string {
  if (packet.documentCount === null) return "File count not available yet";
  const noun = packet.countBasis === "discovery_matches" ? packet.documentCount === 1 ? "search match" : "search matches" : packet.documentCount === 1 ? "file" : "files";
  return `${packet.documentCount.toLocaleString("en-US")} ${noun}${packet.complete ? "" : " found so far"}`;
}
const PRIVATE_ACTIONS = new Set<FinancialPacketSummary["viewerAction"]>(["request", "view_request", "view_files"]);
const labels: Record<FinancialPacketSummary["viewerAction"], string> = {
  owner: "View your files", connect: "Connect to request", pending: "Request sent", request: "Request for $5",
  view_request: "View request", view_files: "View files", unavailable: "Not available right now",
};
/** The same owner-published metadata view for a person route or its Hub/Profile pane. */
export function FinancialPacketSummaries(props: Props) {
  const { user, userId } = useAuth();
  return user && userId ? <SummarySession key={`${userId}:${getAuthSessionGeneration()}:${props.personRef}`} {...props} user={user} userId={userId} /> : null;
}
function SummarySession({ personRef, ownerName, refreshKey, onConnect, onUnlock, connecting, user, userId }: Props & { user: NonNullable<ReturnType<typeof useAuth>["user"]>; userId: string }) {
  const { isVaultUnlocked } = useVault();
  const sessionKey = `${userId}:${getAuthSessionGeneration()}:${personRef}`;
  const lease = useMemo(() => ({ personRef, user, owner: snapshotValidatedAuthSessionPrincipal() }), [personRef, user]);
  const activeLease = useRef<typeof lease | null>(null);
  const loadedPages = useRef(1);
  useLayoutEffect(() => {
    activeLease.current = lease;
    return () => { if (activeLease.current === lease) activeLease.current = null; };
  }, [lease]);
  const guard = useCallback(() => {
    if (activeLease.current !== lease || !lease.owner || lease.owner.userId !== userId || lease.owner.firebaseUid !== user.uid || !isValidatedAuthSessionOwnerCurrent(lease.owner)) throw new Error("session_changed");
  }, [lease, user, userId]);
  const [value, setValue] = useState<SummarySnapshot & { loaded: boolean; error: boolean; busy: boolean }>(() => {
    const cached = DrivePacketResourceService.peek<SummarySnapshot>(sessionKey, SUMMARY_RESOURCE);
    return { ...(cached ?? { packets: [], cursor: null, pages: 1 }), loaded: !!cached, error: false, busy: false };
  });
  const [opened, setOpened] = useState<FinancialPacketSummary | null>(null), [privateOpen, setPrivateOpen] = useState(false);
  const opener = useOpenerFocus();
  const previousOpen = useRef(opened);
  useEffect(() => {
    if (previousOpen.current && !opened) opener.restore();
    previousOpen.current = opened;
  }, [opened, opener]);
  const load = useCallback(async (cursor?: string | null, force = false) => {
    try { guard(); } catch { return; }
    const cached = DrivePacketResourceService.peek<SummarySnapshot>(sessionKey, SUMMARY_RESOURCE);
    loadedPages.current = Math.max(loadedPages.current, (cached?.pages ?? 1) + (cursor ? 1 : 0));
    const targetPages = loadedPages.current;
    setValue(value => ({ ...value, busy: true, error: false }));
    try {
      const result = await DrivePacketResourceService.load<SummarySnapshot>(sessionKey, SUMMARY_RESOURCE, guard, async current => {
        const token = await lease.user.getIdToken(); current();
        const packets: FinancialPacketSummary[] = [], seen = new Set<string>();
        let next: string | null = null, result, page = 0;
        do {
          result = await FinancialPacketSummaryService.list(lease.personRef, token, current, next);
          current(); packets.push(...result.packets); page++;
          next = result.nextCursor;
          if (next && seen.has(next)) throw new Error("invalid_cursor");
          if (next) seen.add(next);
        } while (next && page < targetPages);
        return { packets: [...new Map(packets.map(packet => [packet.packetId, packet])).values()], cursor: result!.nextCursor, pages: page };
      }, { force, reconcile: reconcileSummaries });
      guard(); setValue({ ...result, loaded: true, error: false, busy: false });
      setOpened(previous => previous ? result.packets.find(item => item.packetId === previous.packetId) ?? null : null);
    } catch { try { guard(); setValue(value => ({ ...value, error: true, busy: false })); } catch { /* Retired viewer or person. */ } }
  }, [guard, lease, sessionKey]);
  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    const changed = previousRefreshKey.current !== refreshKey;
    previousRefreshKey.current = refreshKey;
    void load(undefined, changed);
  }, [load, refreshKey]);
  useEffect(() => {
    const refresh = () => { void load(undefined, true); };
    const unsubscribe = subscribeToConnectionGraphChanges(refresh);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30000);
    return () => { unsubscribe(); window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, refresh); clearInterval(timer); };
  }, [load]);
  const close = () => { setOpened(null); setPrivateOpen(false); };
  const openPrivate = () => { if (!isVaultUnlocked) onUnlock(); setPrivateOpen(true); };
  const actions: PacketPageAction[] = !opened ? [] : opened.viewerAction === "connect"
    ? [{ id: "connect", label: connecting ? "Sending…" : labels.connect, disabled: connecting, onSelect: () => { void Promise.resolve(onConnect()).then(() => load(undefined, true)); } }]
    : opened.viewerAction === "owner" ? [{ id: "owner", label: labels.owner, href: buildConnectedSystemRoute("google_drive") }]
      : PRIVATE_ACTIONS.has(opened.viewerAction) ? [{ id: "request", label: labels[opened.viewerAction], onSelect: openPrivate }] : [];
  return <section aria-label="Financial documents" className="consent-presentation-surface" onClickCapture={opener.capture}>
    <SettingsGroup title="Financial documents" density="compact" rowSizing="uniform">
      {value.packets.map(packet => <SettingsRow key={packet.packetId}
        icon={PACKET_TONE_ICONS[packet.availability === "ready" ? "ready" : "waiting"]} iconTone="capability"
        title={periodLabel({ start: packet.periodStart, end: packet.periodEnd }) ?? packet.title}
        description={`${financialSummaryCount(packet)} · ${labels[packet.viewerAction]}`} textOverflow="wrap" chevron
        trailing={<span className="shrink-0 whitespace-nowrap text-right tabular-nums">$5 <span className="block text-xs text-muted-foreground">one-time</span></span>}
        onClick={() => {
          opener.remember(); setOpened(packet);
          const privateAction = PRIVATE_ACTIONS.has(packet.viewerAction);
          setPrivateOpen(privateAction);
          if (privateAction && !isVaultUnlocked) onUnlock();
        }} />)}
      {value.loaded && !value.error && !value.packets.length && <SettingsRow title="No financial documents available" />}
      {value.busy && !value.loaded && <SettingsRow title="Loading financial documents…" />}
      {value.error && <SettingsRow title="Couldn’t refresh financial documents" trailing={<Button variant="ghost" onClick={() => void load(undefined, true)}>Retry</Button>} />}
      {value.cursor && <Button variant="ghost" disabled={value.busy} onClick={() => void load(value.cursor, true)}>Load more</Button>}
    </SettingsGroup>
    {opened && privateOpen && isVaultUnlocked ? <FinancialPacketPrivateRequest key={`${opened.packetId}:${opened.version}`} summary={opened} personRef={personRef} ownerName={ownerName} onClose={close} onChanged={() => void load(undefined, true)} /> : opened && !privateOpen && <PacketPage open onOpenChange={open => { if (!open) close(); }} title={opened.title}
      description={opened.viewerAction === "pending" || opened.viewerAction === "unavailable" ? labels[opened.viewerAction] : undefined} actions={actions} sections={[
        { id: "summary", title: periodLabel({ start: opened.periodStart, end: opened.periodEnd }) ?? "Search period", rows: [{ id: "count", title: financialSummaryCount(opened),
          description: opened.countBasis === "discovery_matches" && opened.saleDocumentCount !== null && opened.saleDocumentCount !== undefined
            ? `${opened.saleDocumentCount.toLocaleString("en-US")} ${opened.saleDocumentCount === 1 ? "file" : "files"} in the packet` : undefined }] },
        { id: "price", title: "One-time price", rows: [{ id: "price", title: "$5", description: ["connect", "pending", "request"].includes(opened.viewerAction) ? `Pay after ${ownerName} approves.` : undefined }] },
      ]} />}
  </section>;
}
