"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { IDENTITY_REQUIRED, fileRequestError } from "@/components/consent/file-request-errors";
import { useAuth } from "@/hooks/use-auth";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { formatDocumentRequestPrice } from "@/lib/consent/document-request-price";
import { AuthService } from "@/lib/services/auth-service";
import { DrivePacketService, type DrivePacket, type PacketGuard } from "@/lib/services/drive-packet-service";

import { buyerNotes, buyerPacketStatus, buyerSummary, documentCount, savedPacketRequest, type BuyerPacketRequest } from "./packet-copy";
import { PacketPage, type PacketPageAction, type PacketPageSection } from "./packet-page";
import { PacketRows } from "./packet-rows";

/** One version and listing of a packet: a new one is a new purchase, with its own retry key. */
const revisionOf = (packet: DrivePacket) => packet.kind === "provider_discovery"
  ? `${packet.packetId}:${packet.version}` : `${packet.packetId}:${packet.version}:${packet.listingRevision}`;

export type BuyerPacketRequests = {
  result: (packet: DrivePacket) => BuyerPacketRequest | null;
  /** One key per packet version, so a retry or a reopened page never asks twice. */
  retryKey: (packet: DrivePacket) => string;
  record: (packet: DrivePacket, result: BuyerPacketRequest) => void;
};

/**
 * The buyer's requests from one packet list, kept while that list is mounted,
 * so rows and pages agree and a closed page loses nothing. A new account or
 * vault session mounts a new list, which starts empty.
 */
export function useBuyerPacketRequests(): BuyerPacketRequests {
  const [results, setResults] = useState<Readonly<Record<string, BuyerPacketRequest>>>({});
  const keys = useRef(new Map<string, string>());
  return useMemo(() => ({
    result: packet => savedPacketRequest(packet) ?? results[revisionOf(packet)] ?? null,
    retryKey: packet => {
      const revision = revisionOf(packet);
      const key = keys.current.get(revision) ?? crypto.randomUUID();
      keys.current.set(revision, key);
      return key;
    },
    record: (packet, result) => setResults(previous => ({ ...previous, [revisionOf(packet)]: result })),
  }), [results]);
}

const PACKET_CHANGED = new Set(["packet_changed", "listing_changed", "price_changed"]);

/** Plain words for a packet request that did not go through. */
export function packetRequestError(code: string): string {
  if (PACKET_CHANGED.has(code)) return "This packet changed. Check the new details.";
  if (code === "packet_unavailable") return "This packet isn’t available right now.";
  return fileRequestError(code, "Couldn’t confirm your request. Try again. It won’t be sent twice.");
}

/** A seller's listed packets as history rows: the ones you can buy first, each in the seller's order. */
export function BuyerPacketRows({ packets, requests, ownerName, onOpen }: {
  packets: readonly DrivePacket[]; requests: BuyerPacketRequests; ownerName: string; onOpen: (packet: DrivePacket) => void;
}) {
  const items = packets.map((packet, index) => ({ packet, index }))
    .sort((a, b) => Number(!a.packet.canRequest) - Number(!b.packet.canRequest) || a.index - b.index)
    .map(({ packet }) => {
      const request = requests.result(packet);
      const status = buyerPacketStatus(packet, request, ownerName);
      return { id: packet.packetId, title: packet.title, statusLine: status.line, tone: status.tone,
        amountCents: packet.canRequest && !request?.existingAccess ? packet.priceCents : null, onOpen: () => onOpen(packet) };
    });
  return <PacketRows items={items} />;
}

/**
 * A buyer's page for one packet: what's included, the price and when they pay.
 * "Buy for $X" is today's packet request, unchanged: nothing is charged here.
 * The seller approves, then the buyer pays from the request, as before. The
 * buyer's list never carries the seller's files, and this page never shows them.
 */
export function BuyerPacketPage({ packet, ownerName, token, guard, requests, onChanged, onClose }: {
  packet: DrivePacket; ownerName: string; token: string; guard: PacketGuard; requests: BuyerPacketRequests;
  onChanged: () => void; onClose: () => void;
}) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [needsGoogle, setNeedsGoogle] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => { guard(); if (!alive.current) throw new Error("unmounted"); };
  const request = requests.result(packet);
  const buy = async () => {
    if (lock.current || !packet.canRequest || requests.result(packet)) return;
    try { current(); } catch { return; }
    lock.current = true; setBusy(true); setMessage("");
    try {
      const clientRequestId = requests.retryKey(packet);
      const isCurrent = () => { try { current(); return true; } catch { return false; } };
      // A Google account is linked only after the buyer taps "Add Google account".
      const firebaseToken = await (needsGoogle
        ? AuthService.linkGoogleIdentity(user?.uid ?? "", isCurrent)
        : AuthService.documentRequestIdentityToken(user?.uid ?? "", isCurrent));
      current(); setNeedsGoogle(false);
      const result = await DrivePacketService.request(token, firebaseToken, packet, clientRequestId, current);
      current(); requests.record(packet, result);
      setMessage(result.existingAccess ? "You already have these files. Nothing was charged." : "Request sent.");
    } catch (cause) { try {
      current();
      const code = cause instanceof Error ? "code" in cause ? String(cause.code) : cause.message : "";
      if (IDENTITY_REQUIRED.has(code)) setNeedsGoogle(true);
      setMessage(packetRequestError(code));
      if (PACKET_CHANGED.has(code) || code === "packet_unavailable") onChanged();
    } catch { /* No stale private output. */ } }
    finally { lock.current = false; try { current(); setBusy(false); } catch { /* Unmounted. */ } }
  };
  const price = formatDocumentRequestPrice(packet.priceCents);
  const sections: PacketPageSection[] = [
    { id: "included", title: "What’s included", rows: [
      { id: "documents", title: documentCount(packet.documentCount), description: buyerSummary(packet) ?? undefined },
      ...buyerNotes(packet).map((note, index) => ({ id: `note-${index}`, title: note })),
    ] },
    ...packet.canRequest && !request?.existingAccess && !["paid", "delivered"].includes(request?.purchaseState ?? "") ? [{ id: "price", title: "Price", rows: [
      { id: "price", title: "Price", value: price, description: `You pay after ${ownerName} approves.` }] }] : [],
  ];
  const actions: PacketPageAction[] = request ? [{ id: "open", label: request.existingAccess || request.purchaseState === "delivered" ? "View files" : "View request",
    href: buildConsentCenterHref("pending", { requestId: `document_share_request:${request.requestId}`, requestView: "sent" }) }]
    : packet.canRequest ? [{ id: "buy", label: busy ? "Sending…" : needsGoogle ? "Add Google account" : packet.kind === "provider_discovery" ? `Request for ${price}` : `Buy for ${price}`,
      onSelect: () => void buy(), disabled: busy }] : [];
  return <PacketPage open onOpenChange={next => { if (!next) onClose(); }} title={packet.title}
    description={buyerPacketStatus(packet, request, ownerName).line} sections={sections} actions={actions} message={message || undefined} />;
}
