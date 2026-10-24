"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { PacketPage, type PacketPageAction, type PacketPageRow, type PacketPageSection } from "@/components/consent/packets/packet-page";
import { PacketRows } from "@/components/consent/packets/packet-rows";
import { CategoryPacketRows } from "@/components/consent/packets/category-packets";
import { BuyerPacketPage, BuyerPacketRows, useBuyerPacketRequests } from "@/components/consent/packets/buyer-packets";
import {
  buyerNotes, buyerSummary, checkedDate, documentCount, documentLine, ownerPacketPrice, ownerPacketStatus, ownerPacketTitle,
  ownerStatusLine, packetGaps, periodLabel, packetPeriod, sortedDocuments,
} from "@/components/consent/packets/packet-copy";
import { useOpenerFocus } from "@/components/consent/payouts/receipts/receipt-ui";
import { formatDocumentRequestPrice, parseDocumentRequestPrice } from "@/lib/consent/document-request-price";
import { DrivePacketService, type DrivePacket, type PacketGuard } from "@/lib/services/drive-packet-service";
import { openExternalUrl } from "@/lib/utils/browser-navigation";

export function useDrivePacketSession(scope: string) {
  const { user } = useAuth();
  const userId = user?.uid ?? null;
  const { vaultOwnerToken, isVaultUnlocked } = useVault();
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const key = `${userId ?? ""}:${epoch}:${scope}`;
  const identity = useMemo(() => ({ key, token: vaultOwnerToken }), [key, vaultOwnerToken]);
  const current = useRef(identity);
  useLayoutEffect(() => { current.current = identity; }, [identity]);
  const owner = useMemo(() => identity.token ? snapshotValidatedAuthSessionOwner() : null, [identity]);
  const alive = useRef(true);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const guard = useCallback(() => {
    if (!alive.current || !userId || !isVaultUnlocked || !vaultOwnerToken ||
        current.current.key !== key || current.current.token !== vaultOwnerToken ||
        !isVaultSessionEpochCurrent(epoch) || owner?.userId !== userId ||
        !isValidatedAuthSessionOwnerCurrent(owner)) throw new Error("session_changed");
  }, [epoch, isVaultUnlocked, key, owner, userId, vaultOwnerToken]);
  return { key, guard, token: isVaultUnlocked && userId ? vaultOwnerToken : null };
}

/**
 * The owner's own packets, or with `ownerPersonRef` the packets that person
 * listed, as a buyer sees them. `ownerName` names the seller in a buyer's
 * words ("You pay after Avery approves.").
 */
type PacketCatalogOptions = { ownerPersonRef?: string; ownerName?: string; refreshKey?: number; preparationPaused?: boolean; enabled?: boolean; periodPackets?: boolean };
type PacketListValue = { packets: DrivePacket[]; cursor: string | null; busy: boolean; loaded: boolean; error: boolean; opened: DrivePacket | null };
const emptyList = (): PacketListValue => ({ packets: [], cursor: null, busy: false, loaded: false, error: false, opened: null });

/** Existing paged reader and selected version, independent of the body renderer. */
export function useDrivePacketCatalogModel({ ownerPersonRef, ownerName = "the owner", refreshKey = 0, preparationPaused = false, enabled = true, periodPackets = false }: PacketCatalogOptions = {}) {
  const session = useDrivePacketSession(ownerPersonRef ?? "owner-packets");
  const lease = useMemo(() => ({ live: false, serial: 0, pages: 1, key: session.key, ownerPersonRef, token: session.token, guard: session.guard }), [session.key, session.token, session.guard, ownerPersonRef]);
  const active = useRef(enabled);
  useLayoutEffect(() => { active.current = enabled; });
  useLayoutEffect(() => { lease.live = !!lease.token; return () => { lease.live = false; lease.serial += 1; }; }, [lease]);
  const [stored, setStored] = useState<{ lease: typeof lease; value: PacketListValue } | null>(null);
  const value = enabled && stored?.lease === lease ? stored.value : emptyList();
  const current = useCallback(() => { if (!lease.live || !lease.token) throw new Error("inactive"); lease.guard(); }, [lease]);
  const change = useCallback((update: (value: PacketListValue) => PacketListValue) => {
    try { current(); } catch { return; }
    setStored(previous => ({ lease, value: update(previous?.lease === lease ? previous.value : emptyList()) }));
  }, [current, lease]);
  const load = useCallback(async (next?: string | null) => {
    if (!active.current || !lease.token) return;
    try { current(); } catch { return; }
    const attempt = ++lease.serial;
    change(value => ({ ...value, busy: true, error: false }));
    const guard = () => { current(); if (!active.current || attempt !== lease.serial) throw new Error("superseded"); };
    try {
      const wanted = next ? 1 : lease.pages;
      let fetched: DrivePacket[] = [], after = next ?? undefined, cursor: string | null = null, count = 0;
      do {
        const result = await DrivePacketService.packets(lease.token, guard, ownerPersonRef, after);
        guard();
        fetched = [...fetched.filter(packet => !result.packets.some(p => p.packetId === packet.packetId)), ...result.packets];
        cursor = result.nextCursor; after = cursor ?? undefined; count += 1;
      } while (cursor && count < wanted);
      change(value => ({ ...value, packets: next ? [...value.packets.filter(packet => !fetched.some(p => p.packetId === packet.packetId)), ...fetched] : fetched,
        opened: value.opened && (fetched.find(packet => packet.packetId === value.opened?.packetId) ?? value.opened),
        cursor, loaded: true }));
      lease.pages = next ? lease.pages + 1 : count;
    } catch { try { guard(); change(value => ({ ...value, error: true })); } catch { /* Retired private view. */ } }
    finally { try { guard(); change(value => ({ ...value, busy: false })); } catch { /* Retired private view. */ } }
  }, [change, current, lease, ownerPersonRef]);
  useEffect(() => {
    if (enabled) void load();
    return () => { lease.serial += 1; };
  }, [enabled, lease, load, refreshKey]);
  const building = periodPackets && !ownerPersonRef || value.packets.some(packet => packet.kind === "provider_discovery" && packet.state === "building");
  useEffect(() => {
    if (!enabled || !building) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30000);
    return () => clearInterval(timer);
  }, [building, enabled, load]);
  const live = value.opened ? value.packets.find(packet => packet.packetId === value.opened?.packetId) ?? null : null;
  useEffect(() => {
    if (enabled && value.opened && !live && value.cursor && !value.busy && !value.error) void load(value.cursor);
  }, [enabled, live, load, value.opened, value.cursor, value.busy, value.error]);
  // Absence from a complete authoritative owner list closes that exact version.
  useEffect(() => {
    if (enabled && !ownerPersonRef && value.opened && !live && value.loaded && !value.cursor && !value.busy && !value.error)
      change(value => ({ ...value, opened: null }));
  }, [change, enabled, live, ownerPersonRef, value.opened, value.loaded, value.cursor, value.busy, value.error]);
  return { ...value, live, session, ownerPersonRef, ownerName, preparationPaused, enabled, periodPackets, load,
    open: (packet: DrivePacket) => { if (active.current && value.packets.includes(packet)) change(value => ({ ...value, opened: packet })); },
    close: () => change(value => ({ ...value, opened: null })),
  };
}
export type DrivePacketCatalogModel = ReturnType<typeof useDrivePacketCatalogModel>;

export function DrivePacketCatalog(options: PacketCatalogOptions) {
  const model = useDrivePacketCatalogModel(options);
  return model.session.token ? <DrivePacketCatalogView key={model.session.key} model={model} /> : null;
}
export function DrivePacketCatalogView({ model, ownerModel }: { model: DrivePacketCatalogModel; ownerModel?: OwnerPacketPageModel }) {
  const { packets, loaded, busy, error, cursor, opened, live, ownerPersonRef, ownerName, preparationPaused, periodPackets, session, load } = model;
  const opener = useOpenerFocus();
  const requests = useBuyerPacketRequests();
  const previousOpen = useRef(opened);
  useEffect(() => { if (previousOpen.current && !opened) opener.restore(); previousOpen.current = opened; }, [opened, opener]);
  const open = (packet: DrivePacket) => { opener.remember(); model.open(packet); };
  const close = () => model.close();
  if (!session.token) return null;
  return <section aria-label={ownerPersonRef ? "Available document packets" : "Your document packets"} className="consent-presentation-surface" onClickCapture={opener.capture}>
    <SettingsGroup density="compact" title={ownerPersonRef ? "Available packets" : "Packets"}>
    <CategoryPacketRows packets={packets} buyer={!!ownerPersonRef} defaults={periodPackets} onOpen={open} requestFor={requests.result} />
    {ownerPersonRef ? <BuyerPacketRows packets={packets.filter(packet => packet.kind !== "provider_discovery")} requests={requests} ownerName={ownerName} onOpen={open} />
      : <OwnerPacketRows packets={packets.filter(packet => packet.kind !== "provider_discovery")} onOpen={open} />}
    {loaded && !packets.length && !error && (!periodPackets || ownerPersonRef) && <SettingsRow title={ownerPersonRef ? "No packets yet" : preparationPaused ? "Preparation paused" : "Agent One is preparing your packets."} />}
    {error && <SettingsRow title="Couldn’t load packets." trailing={<Button variant="ghost" size="compact" disabled={busy} onClick={() => void load()}>Retry</Button>} />}
    {busy && !loaded && <SettingsRow title="Loading packets…" />}
    {cursor && <Button variant="outline" size="compact" disabled={busy} onClick={() => void load(cursor)}>Load more</Button>}
    </SettingsGroup>
    {!ownerPersonRef && opened && (live || cursor) && (ownerModel ? <OwnerPacketPageView model={ownerModel} onClose={close} /> :
      <OwnerPacketPage key={opened.packetId} packet={live ?? opened} token={session.token} guard={session.guard} onChanged={() => void load()} onClose={close} />)}
    {ownerPersonRef && opened && <BuyerPacketPage key={opened.packetId} packet={live ?? (cursor ? opened : { ...opened, canRequest: false })}
      ownerName={ownerName} token={session.token} guard={session.guard} requests={requests} onChanged={() => void load()} onClose={close} />}
  </section>;
}

/** One history row per packet: decisions first, then live listings, then work in progress. */
function OwnerPacketRows({ packets, onOpen }: { packets: DrivePacket[]; onOpen: (packet: DrivePacket) => void }) {
  const items = packets.map((packet, index) => ({ packet, index, status: ownerPacketStatus(packet) }))
    .sort((a, b) => a.status.order - b.status.order || a.index - b.index)
    .map(({ packet, status }) => ({ id: packet.packetId, title: ownerPacketTitle(packet), statusLine: ownerStatusLine(packet),
      amountCents: ownerPacketPrice(packet), tone: status.tone, onOpen: () => onOpen(packet) }));
  return <PacketRows items={items} />;
}

/**
 * The owner's page for one packet: what's inside (their own file names), what
 * buyers see (never file names), price and status. List, Don't list and Change
 * price are today's Allow, Deny and Edit price, through the same listing call.
 */
type OwnerPacketOptions = { packet: DrivePacket | null; token: string | null; guard: PacketGuard; onChanged: () => void };
type OwnerPacketValue = { price: string; editingPrice: boolean; busy: boolean; message: string };

/** One listing writer and transient price draft, shared by web/native bodies.
 * Editing a price never lists a packet; only the explicit listing command does. */
export function useOwnerPacketPageModel({ packet, token, guard, onChanged }: OwnerPacketOptions) {
  const saved = packet ? (packet.priceCents / 100).toFixed(2) : "";
  const revision = packet ? `${packet.packetId}:${packet.version}:${packet.listingRevision}:${packet.priceCents}` : "";
  const lease = useMemo(() => ({ live: false, lock: false, token, guard, revision, saved, input: { price: saved, revision: 0 }, baseline: saved, editor: null as object | null }), [token, guard, revision, saved]);
  const empty = useCallback((): OwnerPacketValue => ({ price: lease.saved, editingPrice: false, busy: false, message: "" }), [lease]);
  const [stored, setStored] = useState<{ lease: typeof lease; value: OwnerPacketValue } | null>(null);
  const value = stored?.lease === lease ? stored.value : empty();
  const { price, editingPrice, busy, message } = value;
  useLayoutEffect(() => { lease.live = !!token && !!revision; return () => { lease.live = false; }; }, [lease, token, revision]);
  const current = useCallback(() => { if (!lease.live || !lease.token) throw new Error("inactive"); lease.guard(); }, [lease]);
  const isCurrent = useCallback(() => { try { current(); return true; } catch { return false; } }, [current]);
  const editorVisit = editingPrice ? lease.editor : null;
  const editorCurrent = useCallback(() => editorVisit !== null && lease.editor === editorVisit && isCurrent(), [editorVisit, isCurrent, lease]);
  const change = useCallback((update: (value: OwnerPacketValue) => OwnerPacketValue) => {
    try { current(); } catch { return; }
    setStored(previous => ({ lease, value: update(previous?.lease === lease ? previous.value : empty()) }));
  }, [current, empty, lease]);
  const amount = parseDocumentRequestPrice(price);
  const act = async (decision: "allow" | "deny") => {
    if (!packet || !lease.token || lease.lock || lease.input.price !== price || decision === "allow" && amount === null) return;
    try { current(); } catch { return; }
    lease.lock = true; change(value => ({ ...value, busy: true, message: "" }));
    try {
      await DrivePacketService.listing(lease.token, packet, decision, decision === "deny" ? packet.priceCents : amount!, current);
      current();
      if (decision === "deny") { lease.input.price = lease.saved; lease.input.revision += 1; }
      change(value => ({ ...value, editingPrice: false, price: decision === "deny" ? lease.saved : value.price })); onChanged();
    } catch (cause) { try {
      current();
      const code = cause instanceof Error ? "code" in cause ? String(cause.code) : cause.message : "";
      if (["packet_changed", "listing_changed", "price_changed", "packet_unavailable"].includes(code)) {
        change(value => ({ ...value, message: "This packet changed. Check it and try again." })); onChanged();
      } else change(value => ({ ...value, message: "Couldn’t finish. Retry to check the latest status." }));
    } catch { /* No stale private output. */ } }
    finally { lease.lock = false; change(value => ({ ...value, busy: false })); }
  };
  const actions: PacketPageAction[] = [];
  if (packet?.canList && (!packet.listingEnabled || amount !== null && amount !== packet.priceCents)) actions.push({ id: "list",
    label: `List for ${formatDocumentRequestPrice(amount ?? packet.priceCents)}`, onSelect: () => void act("allow"), disabled: busy || amount === null });
  if (packet && (packet.listingEnabled || packet.canList && packet.listingRevision === 0)) actions.push({ id: "deny", label: "Don’t list",
    onSelect: () => void act("deny"), emphasis: "secondary", disabled: busy });
  if (packet?.canList && packet.kind !== "provider_discovery") actions.push({ id: "price", label: "Change price", onSelect: () => {
    if (!lease.lock && isCurrent()) { lease.baseline = lease.input.price; lease.editor = editingPrice ? null : {}; change(value => ({ ...value, editingPrice: !value.editingPrice })); }
  },
    emphasis: "plain", disabled: busy, expanded: editingPrice });
  return { packet, price, amount, editingPrice, busy, message, actions, current: isCurrent, editorCurrent, inputRevision: () => lease.input.revision, mutationPending: () => lease.lock,
    changePrice: (price: string, expectedRevision = lease.input.revision) => {
      if (lease.lock || !isCurrent() || expectedRevision !== lease.input.revision) return false;
      lease.input.price = price; lease.input.revision += 1;
      change(value => ({ ...value, price })); return true;
    },
    finishPrice: async () => {
      if (lease.lock || !editorCurrent() || parseDocumentRequestPrice(lease.input.price) === null) return false;
      lease.editor = null; change(value => ({ ...value, editingPrice: false })); return true;
    },
    cancelPrice: () => {
      if (lease.lock || !editorCurrent()) return;
      lease.input.price = lease.baseline; lease.input.revision += 1; lease.editor = null;
      change(value => ({ ...value, price: lease.baseline, editingPrice: false }));
    },
  };
}
export type OwnerPacketPageModel = ReturnType<typeof useOwnerPacketPageModel>;

function OwnerPacketPage({ packet, token, guard, onChanged, onClose }: OwnerPacketOptions & { packet: DrivePacket; token: string; onClose: () => void }) {
  const model = useOwnerPacketPageModel({ packet, token, guard, onChanged });
  return <OwnerPacketPageView model={model} onClose={onClose} />;
}

/** Display facts have no operation authority and are shared with native rows. */
export function ownerPacketSections(packet: DrivePacket, amount: number | null, current?: () => boolean): PacketPageSection[] {
  const status = ownerPacketStatus(packet);
  const documents = packet.contents ? sortedDocuments(packet.contents.documents) : [];
  const more = packet.documentCount - documents.length;
  const inside: PacketPageRow[] = documents.length ? [
    ...documents.map((document, index) => ({ id: `document-${index}`, title: document.name, description: documentLine(document) || undefined,
      ...(document.viewUrl ? { onOpen: () => { if (current?.() && document.viewUrl) openExternalUrl(document.viewUrl); } } : {}) })),
    ...more > 0 ? [{ id: "more", title: `${more.toLocaleString("en-US")} more ${more === 1 ? "document" : "documents"}` }] : [],
  ] : [{ id: "count", title: documentCount(packet.documentCount), description: periodLabel(packetPeriod(packet)) ?? undefined }];
  const summary = buyerSummary(packet);
  const shownPrice = ownerPacketPrice(packet) === null ? null : formatDocumentRequestPrice(amount ?? packet.priceCents);
  const sections: PacketPageSection[] = [
    { id: "inside", title: "What’s inside", rows: inside },
    ...summary === null ? [] : [{ id: "buyers", title: "What buyers see", rows: [{ id: "listing", title: packet.title, description: summary },
      ...buyerNotes(packet).map((note, index) => ({ id: `note-${index}`, title: note }))] }],
    ...shownPrice === null ? [] : [{ id: "price", title: "Price", rows: [{ id: "price", title: "Price", value: shownPrice }],
    }],
    { id: "status", title: "Status", rows: [
      { id: "status", title: status.word, description: status.detail, tone: status.tone },
      ...packetGaps(packet).map((gap, index) => ({ id: `gap-${index}`, title: gap, tone: "attention" as const })),
      ...packet.kind !== "provider_discovery" && packet.verifiedAt ? [{ id: "checked", title: "Checked", value: checkedDate(packet.verifiedAt) }] : [],
    ] },
  ];
  return sections;
}

export function OwnerPacketPageView({ model, onClose }: { model: OwnerPacketPageModel; onClose: () => void }) {
  const fieldId = useId(), hintId = useId();
  const { packet, price, amount, busy, editingPrice, message, actions } = model;
  if (!packet) return null;
  const sections = ownerPacketSections(packet, amount, model.current).map(section => section.id !== "price" || !editingPrice ? section : ({ ...section,
    children: <div className="space-y-1.5 px-4 pb-3 pt-1">
      <label htmlFor={fieldId} className="block text-xs font-semibold text-muted-foreground">New price</label>
      <div className="flex items-center gap-2"><span aria-hidden="true">$</span>
        <Input id={fieldId} inputMode="decimal" value={price} onChange={event => model.changePrice(event.target.value)} disabled={busy}
          aria-invalid={amount === null || undefined} aria-describedby={amount === null ? hintId : undefined} className="min-h-11 max-w-40" /></div>
      {amount === null && <HelperText id={hintId}>Enter $0.50–$500, up to two decimal places.</HelperText>}
    </div> }));
  return <PacketPage open onOpenChange={next => { if (!next) onClose(); }} title={ownerPacketTitle(packet)}
    description={ownerStatusLine(packet)} sections={sections} actions={actions} message={message || undefined} />;
}
