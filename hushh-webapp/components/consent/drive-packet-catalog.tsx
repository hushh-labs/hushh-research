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
import { BuyerPacketPage, BuyerPacketRows, useBuyerPacketRequests } from "@/components/consent/packets/buyer-packets";
import {
  buyerNotes, buyerSummary, checkedDate, documentCount, documentLine, ownerPacketPrice, ownerPacketStatus, ownerPacketTitle,
  ownerStatusLine, packetGaps, periodLabel, sortedDocuments,
} from "@/components/consent/packets/packet-copy";
import { useOpenerFocus } from "@/components/consent/payouts/receipts/receipt-ui";
import { formatDocumentRequestPrice, parseDocumentRequestPrice } from "@/lib/consent/document-request-price";
import { DrivePacketService, type DrivePacket, type PacketGuard } from "@/lib/services/drive-packet-service";

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
export function DrivePacketCatalog({ ownerPersonRef, ownerName = "the owner", refreshKey = 0, preparationPaused = false }: {
  ownerPersonRef?: string; ownerName?: string; refreshKey?: number; preparationPaused?: boolean;
}) {
  const session = useDrivePacketSession(ownerPersonRef ?? "owner-packets");
  if (!session.token) return null;
  return <PacketList key={session.key} token={session.token} guard={session.guard}
    ownerPersonRef={ownerPersonRef} ownerName={ownerName} refreshKey={refreshKey} preparationPaused={preparationPaused} />;
}

function PacketList({ token, guard, ownerPersonRef, ownerName, refreshKey, preparationPaused }: {
  token: string; guard: PacketGuard; ownerPersonRef?: string; ownerName: string; refreshKey: number; preparationPaused: boolean;
}) {
  const [packets, setPackets] = useState<DrivePacket[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  // Packets read like Payouts history: a row opens its page, and Back returns focus to that row.
  // The open packet is the version last seen in the list.
  const [opened, setOpened] = useState<DrivePacket | null>(null);
  const serial = useRef(0);
  const load = useCallback(async (next?: string | null) => {
    const attempt = ++serial.current;
    setBusy(true); setError(false);
    const current = () => { guard(); if (attempt !== serial.current) throw new Error("superseded"); };
    try {
      const result = await DrivePacketService.packets(token, current, ownerPersonRef, next);
      current();
      setPackets(previous => next ? [...previous.filter(packet => !result.packets.some(p => p.packetId === packet.packetId)), ...result.packets] : result.packets);
      setOpened(previous => previous && (result.packets.find(packet => packet.packetId === previous.packetId) ?? previous));
      setCursor(result.nextCursor); setLoaded(true);
    } catch { try { current(); setError(true); } catch { /* Superseded private view. */ } }
    finally { try { current(); setBusy(false); } catch { /* Superseded private view. */ } }
  }, [guard, ownerPersonRef, token]);
  useEffect(() => { void load(); return () => { serial.current += 1; }; }, [load, refreshKey]);
  const opener = useOpenerFocus();
  const open = (packet: DrivePacket) => { opener.remember(); setOpened(packet); };
  const close = () => { setOpened(null); opener.restore(); };
  const live = opened ? packets.find(packet => packet.packetId === opened.packetId) ?? null : null;
  const requests = useBuyerPacketRequests();
  // A reload (after an action, or the owner's periodic refresh) starts from the first page. An open
  // packet may sit further on: load on until it is found or the list ends.
  useEffect(() => {
    if (opened && !live && cursor && !busy && !error) void load(cursor);
  }, [busy, cursor, error, live, load, opened]);
  // Gone from the owner's whole list, their page closes for good instead of reopening when it returns.
  useEffect(() => {
    if (!ownerPersonRef && opened && !live && loaded && !cursor && !busy && !error) { setOpened(null); opener.restore(); }
  }, [busy, cursor, error, live, loaded, opened, opener, ownerPersonRef]);
  return <section aria-label={ownerPersonRef ? "Available document packets" : "Your document packets"} onClickCapture={opener.capture}>
    <SettingsGroup density="compact" title={ownerPersonRef ? "Available packets" : "Packets"}>
    {ownerPersonRef ? <BuyerPacketRows packets={packets} requests={requests} ownerName={ownerName} onOpen={open} />
      : <OwnerPacketRows packets={packets} onOpen={open} />}
    {loaded && !packets.length && !error && <SettingsRow title={ownerPersonRef ? "No packets yet" : preparationPaused ? "Preparation paused" : "Agent One is preparing your packets."} />}
    {error && <SettingsRow title="Couldn’t load packets." trailing={<Button variant="ghost" size="compact" disabled={busy} onClick={() => void load()}>Retry</Button>} />}
    {busy && !loaded && <SettingsRow title="Loading packets…" />}
    {cursor && <Button variant="outline" size="compact" disabled={busy} onClick={() => void load(cursor)}>Load more</Button>}
    </SettingsGroup>
    {/* While the list loads on, the page keeps the version it last showed. */}
    {!ownerPersonRef && opened && (live || cursor) && <OwnerPacketPage key={opened.packetId} packet={live ?? opened} token={token} guard={guard}
      onChanged={() => void load()} onClose={close} />}
    {/* A buyer's page outlives its row: missing from the whole list, the packet can't be bought now. */}
    {ownerPersonRef && opened && <BuyerPacketPage key={opened.packetId} packet={live ?? (cursor ? opened : { ...opened, canRequest: false })}
      ownerName={ownerName} token={token} guard={guard} requests={requests} onChanged={() => void load()} onClose={close} />}
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
function OwnerPacketPage({ packet, token, guard, onChanged, onClose }: {
  packet: DrivePacket; token: string; guard: PacketGuard; onChanged: () => void; onClose: () => void;
}) {
  const fieldId = useId(), hintId = useId();
  const saved = (packet.priceCents / 100).toFixed(2);
  const [price, setPrice] = useState(saved);
  const [editingPrice, setEditingPrice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // A new version, decision or price starts the page over, as a remounted card did.
  const revision = `${packet.version}:${packet.listingRevision}:${packet.priceCents}`;
  const [seen, setSeen] = useState(revision);
  if (seen !== revision) { setSeen(revision); setPrice(saved); setEditingPrice(false); setMessage(""); }
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => { guard(); if (!alive.current) throw new Error("unmounted"); };
  const amount = parseDocumentRequestPrice(price);
  const act = async (decision: "allow" | "deny") => {
    if (lock.current || decision === "allow" && amount === null) return;
    try { current(); } catch { return; }
    lock.current = true; setBusy(true); setMessage("");
    try {
      await DrivePacketService.listing(token, packet, decision, decision === "deny" ? packet.priceCents : amount!, current);
      current(); setEditingPrice(false); if (decision === "deny") setPrice(saved); onChanged();
    } catch (cause) { try {
      current();
      const code = cause instanceof Error ? "code" in cause ? String(cause.code) : cause.message : "";
      if (["packet_changed", "listing_changed", "price_changed", "packet_unavailable"].includes(code)) {
        setMessage("This packet changed. Check it and try again."); onChanged();
      } else setMessage("Couldn’t finish. Retry to check the latest status.");
    } catch { /* No stale private output. */ } }
    finally { lock.current = false; try { current(); setBusy(false); } catch { /* Unmounted. */ } }
  };
  const status = ownerPacketStatus(packet);
  const documents = packet.contents ? sortedDocuments(packet.contents.documents) : [];
  const more = packet.documentCount - documents.length;
  const inside: PacketPageRow[] = documents.length ? [
    ...documents.map((document, index) => ({ id: `document-${index}`, title: document.name, description: documentLine(document) || undefined })),
    ...more > 0 ? [{ id: "more", title: `${more.toLocaleString("en-US")} more ${more === 1 ? "document" : "documents"}` }] : [],
  ] : [{ id: "count", title: documentCount(packet.documentCount), description: periodLabel(packet.contents?.period) ?? undefined }];
  const summary = buyerSummary(packet);
  const shownPrice = ownerPacketPrice(packet) === null ? null : formatDocumentRequestPrice(amount ?? packet.priceCents);
  const sections: PacketPageSection[] = [
    { id: "inside", title: "What’s inside", rows: inside },
    ...summary === null ? [] : [{ id: "buyers", title: "What buyers see", rows: [{ id: "listing", title: packet.title, description: summary },
      ...buyerNotes(packet).map((note, index) => ({ id: `note-${index}`, title: note }))] }],
    ...shownPrice === null ? [] : [{ id: "price", title: "Price", rows: [{ id: "price", title: "Price", value: shownPrice }],
      children: editingPrice ? <div className="space-y-1.5 px-4 pb-3 pt-1">
        <label htmlFor={fieldId} className="block text-xs font-semibold text-muted-foreground">New price</label>
        <div className="flex items-center gap-2"><span aria-hidden="true">$</span>
          <Input id={fieldId} inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} disabled={busy}
            aria-invalid={amount === null || undefined} aria-describedby={amount === null ? hintId : undefined} className="min-h-11 max-w-40" /></div>
        {amount === null && <HelperText id={hintId}>Enter $0.50–$500, up to two decimal places.</HelperText>}
      </div> : undefined }],
    { id: "status", title: "Status", rows: [
      { id: "status", title: status.word, description: status.detail, tone: status.tone },
      ...packetGaps(packet).map((gap, index) => ({ id: `gap-${index}`, title: gap, tone: "attention" as const })),
      ...packet.verifiedAt ? [{ id: "checked", title: "Checked", value: checkedDate(packet.verifiedAt) }] : [],
    ] },
  ];
  const actions: PacketPageAction[] = [];
  if (packet.canList && (!packet.listingEnabled || amount !== null && amount !== packet.priceCents)) actions.push({ id: "list",
    label: `List for ${formatDocumentRequestPrice(amount ?? packet.priceCents)}`, onSelect: () => void act("allow"), disabled: busy || amount === null });
  if (packet.listingEnabled || packet.canList && packet.listingRevision === 0) actions.push({ id: "deny", label: "Don’t list",
    onSelect: () => void act("deny"), emphasis: "secondary", disabled: busy });
  if (packet.canList) actions.push({ id: "price", label: "Change price", onSelect: () => setEditingPrice(value => !value),
    emphasis: "plain", disabled: busy, expanded: editingPrice });
  return <PacketPage open onOpenChange={next => { if (!next) onClose(); }} title={ownerPacketTitle(packet)}
    description={ownerStatusLine(packet)} sections={sections} actions={actions} message={message || undefined} />;
}
