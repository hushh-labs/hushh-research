"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { getAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
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
  buyerNotes, buyerSummary, checkedDate, documentLine, ownerPacketPrice, ownerPacketStatus, ownerPacketTitle,
  ownerStatusLine, ownerDocumentCount, packetGaps, periodLabel, packetPeriod, sortedDocuments,
} from "@/components/consent/packets/packet-copy";
import { useOpenerFocus } from "@/components/consent/payouts/receipts/receipt-ui";
import { formatDocumentRequestPrice, parseDocumentRequestPrice } from "@/lib/consent/document-request-price";
import { DrivePacketService, type DrivePacket, type DrivePacketPreview, type PacketGuard } from "@/lib/services/drive-packet-service";
import { DrivePacketResourceService } from "@/lib/services/drive-packet-resource-service";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { openExternalUrl } from "@/lib/utils/browser-navigation";

export function useDrivePacketSession(scope: string) {
  const { user, userId } = useAuth();
  const { vaultOwnerToken, isVaultUnlocked } = useVault();
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const key = `${userId ?? ""}:${getAuthSessionGeneration()}:${epoch}:${scope}`;
  const identity = useMemo(() => ({ key, token: vaultOwnerToken }), [key, vaultOwnerToken]);
  const current = useRef(identity);
  useLayoutEffect(() => { current.current = identity; }, [identity]);
  const owner = useMemo(() => identity.token ? snapshotValidatedAuthSessionPrincipal() : null, [identity]);
  const alive = useRef(true);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const guard = useCallback(() => {
    if (!alive.current || !userId || !isVaultUnlocked || !vaultOwnerToken ||
        current.current.key !== key || current.current.token !== vaultOwnerToken ||
        !isVaultSessionEpochCurrent(epoch) || !owner || owner.userId !== userId || owner.firebaseUid !== user?.uid ||
        !isValidatedAuthSessionOwnerCurrent(owner)) throw new Error("session_changed");
  }, [epoch, isVaultUnlocked, key, owner, user?.uid, userId, vaultOwnerToken]);
  return { key, guard, token: isVaultUnlocked && userId ? vaultOwnerToken : null };
}

/**
 * The owner's own packets, or with `ownerPersonRef` the packets that person
 * listed, as a buyer sees them. `ownerName` names the seller in a buyer's
 * words ("You pay after Avery approves.").
 */
type PacketCatalogOptions = { ownerPersonRef?: string; ownerName?: string; refreshKey?: number; preparationPaused?: boolean; enabled?: boolean; periodPackets?: boolean; customPacketsOnly?: boolean };
type PacketListValue = { packets: DrivePacket[]; cursor: string | null; busy: boolean; loaded: boolean; error: boolean; opened: DrivePacket | null;
  previews: Record<string, DrivePacketPreview>; previewBusy: boolean; previewError: boolean };
type CatalogSnapshot = { packets: DrivePacket[]; cursor: string | null; pages: number };
type PreviewSnapshot = { preview: DrivePacketPreview; start: string | null; pages: number };
const CATALOG_RESOURCE = "catalog";
const emptyList = (): PacketListValue => ({ packets: [], cursor: null, busy: false, loaded: false, error: false, opened: null,
  previews: {}, previewBusy: false, previewError: false });

/** Existing paged reader and selected version, independent of the body renderer. */
export function useDrivePacketCatalogModel({ ownerPersonRef, ownerName = "the owner", refreshKey = 0, preparationPaused = false, enabled = true, periodPackets = false, customPacketsOnly = false }: PacketCatalogOptions = {}) {
  const session = useDrivePacketSession(ownerPersonRef ?? "owner-packets");
  const lease = useMemo(() => ({ live: false, pages: 1, visit: 0, opened: null as string | null,
    previewLocks: new Set<string>(), previewPages: new Map<string, { revision: number; start: string | null; pages: number; tagging?: DrivePacketPreview["tagging"] }>(), started: new Set<string>(), key: session.key, ownerPersonRef, token: session.token, guard: session.guard }), [session.key, session.token, session.guard, ownerPersonRef]);
  const active = useRef(enabled);
  useLayoutEffect(() => { active.current = enabled; });
  useLayoutEffect(() => { lease.live = !!lease.token; return () => { lease.live = false; }; }, [lease]);
  const [stored, setStored] = useState<{ lease: typeof lease; value: PacketListValue } | null>(null);
  const initialValue = useCallback((): PacketListValue => {
    const cached = session.token ? DrivePacketResourceService.peek<CatalogSnapshot>(session.key, CATALOG_RESOURCE) : null;
    return { ...emptyList(), ...(cached ? { packets: cached.packets, cursor: cached.cursor, loaded: true } : {}) };
  }, [session.key, session.token]);
  const value = enabled ? stored?.lease === lease ? stored.value : initialValue() : emptyList();
  const current = useCallback(() => { if (!lease.live || !lease.token) throw new Error("inactive"); lease.guard(); }, [lease]);
  const change = useCallback((update: (value: PacketListValue) => PacketListValue) => {
    try { current(); } catch { return; }
    setStored(previous => ({ lease, value: update(previous?.lease === lease ? previous.value : initialValue()) }));
  }, [current, initialValue, lease]);
  const load = useCallback(async (next?: string | null, force = true) => {
    if (!active.current || !lease.token) return;
    try { current(); } catch { return; }
    change(value => ({ ...value, busy: true, error: false }));
    const guard = () => { current(); if (!active.current) throw new Error("inactive"); };
    try {
      const result = await DrivePacketResourceService.load<CatalogSnapshot>(lease.key, CATALOG_RESOURCE, guard, async requestCurrent => {
        const previous = DrivePacketResourceService.peek<CatalogSnapshot>(lease.key, CATALOG_RESOURCE);
        const wanted = next ? 1 : previous?.pages ?? lease.pages;
        let fetched: DrivePacket[] = [], after = next ?? undefined, cursor: string | null = null, count = 0;
        const seen = new Set<string>();
        do {
          const page = await DrivePacketService.packets(lease.token!, requestCurrent, ownerPersonRef, after);
          requestCurrent();
          fetched = [...fetched.filter(packet => !page.packets.some(p => p.packetId === packet.packetId)), ...page.packets];
          cursor = page.nextCursor; after = cursor ?? undefined; count += 1;
          if (cursor && seen.has(cursor)) throw new Error("invalid_cursor");
          if (cursor) seen.add(cursor);
        } while (cursor && count < wanted);
        return { packets: next ? [...(previous?.packets ?? []).filter(packet => !fetched.some(p => p.packetId === packet.packetId)), ...fetched] : fetched,
          cursor, pages: next ? (previous?.pages ?? 1) + 1 : count };
      }, { force, reconcile: (previous, incoming) => ({ ...incoming, packets: incoming.packets.map(packet => {
        const old = previous.packets.find(item => item.packetId === packet.packetId);
        if (!old) return packet;
        if (old.version > packet.version || old.version === packet.version && old.listingRevision > packet.listingRevision) return old;
        if (old.kind === "provider_discovery" && packet.kind === "provider_discovery" && old.preview && packet.preview &&
            (old.preview.revision > packet.preview.revision || old.preview.revision === packet.preview.revision && (old.preview.updatedAt ?? "") > (packet.preview.updatedAt ?? "")))
          return { ...packet, preview: old.preview };
        return packet;
      }) }) });
      guard(); lease.pages = result.pages;
      change(value => ({ ...value, packets: result.packets, cursor: result.cursor, loaded: true,
        opened: value.opened && (result.packets.find(packet => packet.packetId === value.opened?.packetId) ?? value.opened) }));
    } catch { try { guard(); change(value => ({ ...value, error: true })); } catch { /* Retired private view. */ } }
    finally { try { guard(); change(value => ({ ...value, busy: false })); } catch { /* Retired private view. */ } }
  }, [change, current, lease, ownerPersonRef]);
  const loadPreview = useCallback(async (packetId: string, action: "start" | "read" | "refresh" | "more", cursor?: string | null) => {
    const visit = lease.visit, lock = `${packetId}:${visit}`;
    if (!active.current || !lease.token || ownerPersonRef || lease.previewLocks.has(lock)) return;
    try { current(); } catch { return; }
    const guard = () => { current(); if (!active.current || lease.visit !== visit || lease.opened !== packetId) throw new Error("superseded"); };
    try { guard(); } catch { return; }
    lease.previewLocks.add(lock);
    change(value => ({ ...value, previewBusy: true, previewError: false }));
    try {
      const resource = `preview:${packetId}`;
      if (action === "refresh" || action === "start") DrivePacketResourceService.invalidate(lease.key, resource);
      const result = await DrivePacketResourceService.load<PreviewSnapshot>(lease.key, resource, guard, async requestCurrent => {
        const previousPage = lease.previewPages.get(packetId);
        let start = action === "more" ? cursor ?? null : action === "read" ? previousPage?.start ?? null : null;
        let preview: DrivePacketPreview;
        if (action === "start" || action === "refresh") preview = await DrivePacketService.preparePreview(lease.token!, packetId, requestCurrent, action === "refresh");
        else {
          preview = await DrivePacketService.preview(lease.token!, packetId, requestCurrent, start);
          if (start && preview.revision !== previousPage?.revision) {
            start = null; preview = await DrivePacketService.preview(lease.token!, packetId, requestCurrent);
          }
        }
        // A terminal tagging update must refresh earlier loaded pages as well as the tail.
        const tagChanged = JSON.stringify(previousPage?.tagging) !== JSON.stringify(preview.tagging);
        if (action === "read" && previousPage && previousPage.pages > 1 && tagChanged &&
            preview.tagging && !["queued", "running"].includes(preview.tagging.status)) {
          const revision = preview.revision, target = previousPage.pages;
          start = null;
          preview = await DrivePacketService.preview(lease.token!, packetId, requestCurrent);
          const documents = [...(preview.documents ?? [])], seen = new Set<string>();
          for (let page = 1; page < target && preview.nextCursor; page++) {
            requestCurrent();
            if (seen.has(preview.nextCursor)) throw new Error("invalid_response");
            start = preview.nextCursor; seen.add(start);
            preview = await DrivePacketService.preview(lease.token!, packetId, requestCurrent, start);
            if (preview.revision !== revision) throw new Error("superseded");
            documents.push(...(preview.documents ?? []));
          }
          preview = { ...preview, documents };
        }
        requestCurrent();
        const samePage = previousPage?.revision === preview.revision;
        const pages = samePage && start ? previousPage.pages + (action === "more" ? 1 : 0) : 1;
        return { preview, start, pages };
      }, { force: true, reconcile: (previous, incoming) => {
        if (previous.preview.revision > incoming.preview.revision || previous.preview.revision === incoming.preview.revision &&
            (previous.preview.updatedAt ?? "") > (incoming.preview.updatedAt ?? "")) return previous;
        const keep = (action === "more" || action === "read") && previous.preview.revision === incoming.preview.revision && !previous.preview.stale && !incoming.preview.stale;
        if (!keep) return incoming;
        return { ...incoming, preview: { ...incoming.preview, documents: [...new Map([...(previous.preview.documents ?? []), ...(incoming.preview.documents ?? [])]
          .map((file, index) => [file.viewUrl ?? `unlinked:${index}`, file] as const)).values()] } };
      } });
      guard();
      const { preview, start, pages } = result;
      if (action === "start" || action === "refresh") lease.started.add(packetId);
      lease.previewPages.set(packetId, { revision: preview.revision, start, pages, tagging: preview.tagging });
      change(value => {
        const previous = value.previews[packetId];
        const keep = (action === "more" || action === "read") && previous?.revision === preview.revision && !previous.stale && !preview.stale;
        // Canonical URLs identify originals; unlinked entries are preserved individually.
        const documents = keep ? [...new Map([...(previous?.documents ?? []), ...(preview.documents ?? [])]
          .map((file, index) => [file.viewUrl ?? `unlinked:${index}`, file] as const)).values()] : preview.documents;
        return { ...value, previews: { ...value.previews, [packetId]: { ...preview, documents } } };
      });
      if (preview.complete) { DrivePacketResourceService.invalidate(lease.key, CATALOG_RESOURCE); void load(); }
    } catch { try { guard(); change(value => ({ ...value, previewError: true })); } catch { /* Retired owner or closed detail. */ } }
    finally {
      lease.previewLocks.delete(lock);
      try { guard(); change(value => ({ ...value, previewBusy: false })); } catch { /* Retired visit. */ }
    }
  }, [change, current, lease, load, ownerPersonRef]);
  useEffect(() => {
    if (enabled) void load(undefined, refreshKey !== 0);
  }, [enabled, lease, load, refreshKey]);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => { DrivePacketResourceService.invalidate(lease.key, CATALOG_RESOURCE); void load(); };
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
  }, [enabled, lease, load]);
  const building = periodPackets && !ownerPersonRef || value.packets.some(packet => packet.kind === "provider_discovery" && packet.state === "building");
  useEffect(() => {
    if (!enabled || !building) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30000);
    return () => clearInterval(timer);
  }, [building, enabled, load]);
  const selected = value.opened ? value.packets.find(packet => packet.packetId === value.opened?.packetId) ?? null : null;
  const live = useMemo(() => selected?.kind === "provider_discovery" && value.previews[selected.packetId]
    ? { ...selected, preview: value.previews[selected.packetId] } : selected, [selected, value.previews]);
  const previewStatus = live?.kind === "provider_discovery" ? live.preview?.status : undefined;
  const taggingActive = live?.kind === "provider_discovery" &&
    ["queued", "running"].includes(live.preview?.tagging?.status ?? "");
  const selectedSummary = selected?.kind === "provider_discovery" ? selected.preview : undefined;
  const localPreview = selected ? value.previews[selected.packetId] : undefined;
  const selectedId = selected?.packetId;
  const selectedTagging = JSON.stringify(selectedSummary?.tagging);
  const catalogAhead = !!selectedSummary && (!localPreview || selectedSummary.revision > localPreview.revision ||
    (selectedSummary.updatedAt ?? "") > (localPreview.updatedAt ?? "") || selectedSummary.status !== localPreview.status ||
    selectedTagging !== JSON.stringify(localPreview.tagging));
  useEffect(() => {
    if (enabled && selectedId && catalogAhead && !ownerPersonRef) void loadPreview(selectedId, "read");
  }, [catalogAhead, enabled, loadPreview, ownerPersonRef, selectedId, selectedSummary?.revision, selectedSummary?.updatedAt, selectedSummary?.status, selectedTagging]);
  useEffect(() => {
    if (!enabled || ownerPersonRef || !value.opened || value.opened.kind !== "provider_discovery" ||
      !taggingActive && !["not_started", "queued", "searching", "partial"].includes(previewStatus ?? "not_started")) return;
    const packetId = value.opened.packetId;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void loadPreview(packetId, "read"); }, 5000);
    return () => clearInterval(timer);
  }, [enabled, loadPreview, ownerPersonRef, previewStatus, taggingActive, value.opened]);
  useEffect(() => {
    if (enabled && value.opened && !live && value.cursor && !value.busy && !value.error) void load(value.cursor);
  }, [enabled, live, load, value.opened, value.cursor, value.busy, value.error]);
  const close = useCallback(() => {
    lease.visit++; lease.opened = null;
    change(value => ({ ...value, opened: null, previewBusy: false, previewError: false }));
  }, [change, lease]);
  // Absence from a complete authoritative owner list closes that exact version.
  useEffect(() => {
    if (enabled && !ownerPersonRef && value.opened && !live && value.loaded && !value.cursor && !value.busy && !value.error)
      close();
  }, [close, enabled, live, ownerPersonRef, value.opened, value.loaded, value.cursor, value.busy, value.error]);
  return { ...value, live, session, ownerPersonRef, ownerName, preparationPaused, enabled, periodPackets, customPacketsOnly, load,
    preview: (refresh = false) => { if (lease.opened) void loadPreview(lease.opened, refresh ? "refresh" : "start"); },
    morePreview: () => { if (lease.opened) void loadPreview(lease.opened, "more", value.previews[lease.opened]?.nextCursor); },
    open: (packet: DrivePacket) => {
      if (!active.current || !value.packets.includes(packet)) return;
      lease.visit++; lease.opened = packet.packetId;
      const saved = !ownerPersonRef ? DrivePacketResourceService.peek<PreviewSnapshot>(lease.key, `preview:${packet.packetId}`) : null;
      if (saved) {
        lease.started.add(packet.packetId);
        lease.previewPages.set(packet.packetId, { revision: saved.preview.revision, start: saved.start, pages: saved.pages, tagging: saved.preview.tagging });
      }
      change(value => ({ ...value, opened: packet, previewBusy: false, previewError: false,
        previews: saved ? { ...value.previews, [packet.packetId]: saved.preview } : value.previews }));
      if (!ownerPersonRef && packet.kind === "provider_discovery") {
        const started = lease.started.has(packet.packetId);
        const previous = saved?.preview ?? value.previews[packet.packetId] ?? packet.preview;
        const stale = previous?.complete && !!previous.updatedAt && Date.now() - Date.parse(previous.updatedAt) >= 5 * 60_000;
        void loadPreview(packet.packetId, started && !stale ? "read" : "start");
      }
    },
    close,
  };
}
export type DrivePacketCatalogModel = ReturnType<typeof useDrivePacketCatalogModel>;

export function DrivePacketCatalog(options: PacketCatalogOptions) {
  const model = useDrivePacketCatalogModel(options);
  return model.session.token ? <DrivePacketCatalogView key={model.session.key} model={model} /> : null;
}
export function DrivePacketCatalogView({ model, ownerModel }: { model: DrivePacketCatalogModel; ownerModel?: OwnerPacketPageModel }) {
  const { packets, loaded, busy, error, cursor, opened, live, ownerPersonRef, ownerName, preparationPaused, periodPackets, customPacketsOnly, session, load } = model;
  const customPackets = packets.filter(packet => packet.kind !== "provider_discovery");
  const receipts = customPacketsOnly && ownerPersonRef ? packets.flatMap(packet => packet.kind === "provider_discovery" && packet.requestId && packet.purchaseState !== "none"
    ? [{ packet, requestId: packet.requestId }] : []) : [];
  const showCatalog = !customPacketsOnly || customPackets.length > 0 || !!cursor || error || busy && !loaded;
  const opener = useOpenerFocus();
  const requests = useBuyerPacketRequests();
  const previousOpen = useRef(opened);
  useEffect(() => { if (previousOpen.current && !opened) opener.restore(); previousOpen.current = opened; }, [opened, opener]);
  const open = (packet: DrivePacket) => { opener.remember(); model.open(packet); };
  const close = () => model.close();
  if (!session.token) return null;
  if (customPacketsOnly && loaded && !busy && !error && !customPackets.length && !receipts.length && !cursor && !opened) return null;
  return <section aria-label={ownerPersonRef ? "Available document packets" : "Your document packets"} className="consent-presentation-surface" onClickCapture={opener.capture}>
    {receipts.length > 0 && <SettingsGroup density="compact" title="Your requests">
      {receipts.map(({ packet, requestId }) => <SettingsRow key={requestId} asChild
        title={periodLabel(packetPeriod(packet)) ?? packet.title}
        description={packet.purchaseState === "delivered" ? "View files" : packet.purchaseState === "paid" ? "Sharing files" : "View request"} chevron>
        <Link href={buildConsentCenterHref("pending", { requestId: `document_share_request:${requestId}`, requestView: "sent" })} />
      </SettingsRow>)}
    </SettingsGroup>}
    {showCatalog && <SettingsGroup density="compact" title={customPacketsOnly ? "Other document packets" : ownerPersonRef ? "Available packets" : "Packets"}>
    {!customPacketsOnly && <CategoryPacketRows packets={packets} buyer={!!ownerPersonRef} defaults={periodPackets} onOpen={open} requestFor={requests.result} />}
    {ownerPersonRef ? <BuyerPacketRows packets={customPackets} requests={requests} ownerName={ownerName} onOpen={open} />
      : <OwnerPacketRows packets={customPackets} onOpen={open} />}
    {loaded && !packets.length && !error && !customPacketsOnly && (!periodPackets || ownerPersonRef) && <SettingsRow title={ownerPersonRef ? "No packets yet" : preparationPaused ? "Preparation paused" : "Preparing packets…"} />}
    {error && <SettingsRow title="Couldn’t load packets." trailing={<Button data-consent-quiet-action="true" data-consent-role="compact-action" variant="ghost" size="compact" disabled={busy} onClick={() => void load()}>Retry</Button>} />}
    {busy && !loaded && <SettingsRow title="Loading packets…" />}
    {cursor && <Button data-consent-quiet-action="true" data-consent-role="compact-action" variant="outline" size="compact" disabled={busy} onClick={() => void load(cursor)}>Load more</Button>}
    </SettingsGroup>}
    {!ownerPersonRef && opened && (live || cursor) && (ownerModel ? <OwnerPacketPageView model={ownerModel} onClose={close} /> :
      <OwnerPacketPage key={opened.packetId} packet={live ?? opened} token={session.token} guard={session.guard} onChanged={() => void load()} onClose={close}
        onPreview={model.preview} onMorePreview={model.morePreview} previewBusy={model.previewBusy} previewError={model.previewError} />)}
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
type OwnerPacketOptions = { packet: DrivePacket | null; token: string | null; guard: PacketGuard; onChanged: () => void;
  onPreview?: (refresh?: boolean) => void; onMorePreview?: () => void; previewBusy?: boolean; previewError?: boolean };
type OwnerPacketValue = { price: string; editingPrice: boolean; busy: boolean; message: string };

/** One listing writer and transient price draft, shared by web/native bodies.
 * Editing a price never lists a packet; only the explicit listing command does. */
export function useOwnerPacketPageModel({ packet, token, guard, onChanged, onPreview, onMorePreview, previewBusy, previewError }: OwnerPacketOptions) {
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
  if (packet?.kind === "provider_discovery" && onMorePreview && packet.preview?.nextCursor) actions.push({ id: "more-preview", label: "Load more files",
    onSelect: () => { if (isCurrent()) onMorePreview(); }, disabled: previewBusy });
  if (packet?.kind === "provider_discovery" && packet.version === 0 && onPreview) actions.push({ id: "preview", label: previewBusy ? "Searching…" : "Refresh files",
    onSelect: () => { if (isCurrent()) onPreview(true); }, disabled: previewBusy, emphasis: "secondary" });
  if (packet?.canList && (!packet.listingEnabled || amount !== null && amount !== packet.priceCents)) actions.push({ id: "list",
    label: `List for ${formatDocumentRequestPrice(amount ?? packet.priceCents)}`, onSelect: () => void act("allow"), disabled: busy || amount === null,
    emphasis: packet.kind === "provider_discovery" ? "secondary" : undefined });
  if (packet && (packet.listingEnabled || packet.canList && packet.listingRevision === 0)) actions.push({ id: "deny", label: "Don’t list",
    onSelect: () => void act("deny"), emphasis: packet.kind === "provider_discovery" ? "plain" : "secondary", disabled: busy });
  if (packet?.canList && packet.kind !== "provider_discovery") actions.push({ id: "price", label: "Change price", onSelect: () => {
    if (!lease.lock && isCurrent()) { lease.baseline = lease.input.price; lease.editor = editingPrice ? null : {}; change(value => ({ ...value, editingPrice: !value.editingPrice })); }
  },
    emphasis: "plain", disabled: busy, expanded: editingPrice });
  return { packet, price, amount, editingPrice, busy, message: previewError ? "Couldn’t refresh files. Saved files are still shown." : message,
    actions, current: isCurrent, editorCurrent, inputRevision: () => lease.input.revision, mutationPending: () => lease.lock,
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

function OwnerPacketPage({ onClose, ...options }: OwnerPacketOptions & { packet: DrivePacket; token: string; onClose: () => void }) {
  const model = useOwnerPacketPageModel(options);
  return <OwnerPacketPageView model={model} onClose={onClose} />;
}

/** Display facts have no operation authority and are shared with native rows. */
export function ownerPacketSections(packet: DrivePacket, amount: number | null, current?: () => boolean): PacketPageSection[] {
  const status = ownerPacketStatus(packet);
  const preview = packet.kind === "provider_discovery" ? packet.preview : undefined;
  const documents = preview?.documents ?? (packet.contents ? sortedDocuments(packet.contents.documents) : []);
  const more = (preview?.matched ?? packet.documentCount ?? 0) - documents.length;
  const inside: PacketPageRow[] = documents.length ? [
    ...documents.map((document, index) => ({ id: `document-${index}`, title: document.name,
      description: [documentLine(document), document.shareable === false ? "Only its owner can share this file." : null].filter(Boolean).join(" · ") || undefined,
      ...(document.viewUrl ? { onOpen: () => { if (current?.() && document.viewUrl) openExternalUrl(document.viewUrl); } } : {}) })),
    ...more > 0 ? [{ id: "more", title: `${more.toLocaleString("en-US")} more ${more === 1 ? "document" : "documents"}` }] : [],
  ] : [{ id: "count", title: ownerDocumentCount(packet) ?? "Files have not been counted yet", description: periodLabel(packetPeriod(packet)) ?? undefined }];
  const summary = buyerSummary(packet);
  const shownPrice = packet.kind === "provider_discovery" || ownerPacketPrice(packet) === null ? null : formatDocumentRequestPrice(amount ?? packet.priceCents);
  const sections: PacketPageSection[] = [
    { id: "inside", title: packet.kind === "provider_discovery" ? "Files" : "What’s inside", rows: inside },
    ...summary === null || packet.kind === "provider_discovery" ? [] : [{ id: "buyers", title: "What buyers see", rows: [{ id: "listing", title: packet.title, description: summary },
      ...buyerNotes(packet).map((note, index) => ({ id: `note-${index}`, title: note }))] }],
    ...shownPrice === null ? [] : [{ id: "price", title: "Price", rows: [{ id: "price", title: "Price", value: shownPrice }],
    }],
    { id: "status", title: "Status", rows: [
      { id: "status", title: status.word, description: status.detail, tone: status.tone },
      ...preview?.updatedAt ? [{ id: "searched", title: preview.stale ? "Previous search" : "Last searched", value: new Date(preview.updatedAt).toLocaleString() }] : [],
      ...preview?.limited ? [{ id: "limited", title: "Some files are still missing. Refresh to continue.", tone: "attention" as const }] : [],
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
      <label data-consent-role="form-label" htmlFor={fieldId} className="block text-xs font-semibold text-muted-foreground">New price</label>
      <div className="flex items-center gap-2"><span aria-hidden="true">$</span>
        <Input data-consent-input="true" id={fieldId} inputMode="decimal" value={price} onChange={event => model.changePrice(event.target.value)} disabled={busy}
          aria-invalid={amount === null || undefined} aria-describedby={amount === null ? hintId : undefined} className="min-h-11 max-w-40" /></div>
      {amount === null && <HelperText id={hintId}>Enter $0.50–$500, up to two decimal places.</HelperText>}
    </div> }));
  return <PacketPage open onOpenChange={next => { if (!next) onClose(); }} title={ownerPacketTitle(packet)}
    description={ownerStatusLine(packet)} sections={sections} actions={actions} message={message || undefined} />;
}
