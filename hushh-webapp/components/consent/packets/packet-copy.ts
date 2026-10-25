import type { DiscoveryDrivePacket, DrivePacket, DrivePacketCategory, DrivePacketDocument, DrivePacketPeriod } from "@/lib/services/drive-packet-service";

import type { PacketTone } from "./packet-rows";

/*
 * Plain words for Drive packets, shared by the owner's list and page and by
 * the buyer's view. A packet is a set of documents its owner can list and a
 * connection can buy: no "coverage", "evidence" or agent jargon.
 */

// The server's stand-ins while a packet is checked again. Never shown as-is.
const CHECKING_TITLE = "Packet being checked";
const CHECKING_SUMMARIES = new Set(["Coverage is being checked.", "Evidence is being prepared."]);
const STATUS_GAPS = new Set(["The private agent is checking current evidence.", "Processing is paused."]);

export function documentCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "document" : "documents"}`;
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** "Mar 2026", "Jan–Jun 2026" or "Dec 2025–Feb 2026". */
export function periodLabel(period: DrivePacketPeriod | null | undefined): string | null {
  if (!period) return null;
  const start = new Date(`${period.start}T00:00:00Z`), end = new Date(`${period.end}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  if (start.getUTCFullYear() !== end.getUTCFullYear()) return `${MONTH_YEAR.format(start)}–${MONTH_YEAR.format(end)}`;
  return start.getUTCMonth() === end.getUTCMonth() ? MONTH_YEAR.format(end) : `${MONTH.format(start)}–${MONTH_YEAR.format(end)}`;
}

const sentence = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** "Bank statement · 2 pages · Jan 2026": what one file is, for its owner. */
export function documentLine(document: DrivePacketDocument): string {
  return [document.type ? sentence(document.type) : null,
    document.pages === null ? null : `${document.pages.toLocaleString("en-US")} ${document.pages === 1 ? "page" : "pages"}`,
    periodLabel(document.period)].filter(Boolean).join(" · ");
}

/** Oldest first, then by name; files without dates last. */
export function sortedDocuments(documents: readonly DrivePacketDocument[]): DrivePacketDocument[] {
  return [...documents].sort((a, b) => (a.period?.start ?? "9999").localeCompare(b.period?.start ?? "9999") ||
    a.name.localeCompare(b.name));
}

/** True while the server shows a stand-in for a packet it is checking again. */
export function isCheckingPlaceholder(packet: DrivePacket): boolean {
  return packet.title === CHECKING_TITLE;
}

/**
 * The owner's name for a packet. While it is checked again the server hides
 * its title, so it takes its first file's name (the owner's own), or "New packet".
 */
export function ownerPacketTitle(packet: DrivePacket): string {
  if (!isCheckingPlaceholder(packet)) return packet.title;
  const first = packet.contents ? sortedDocuments(packet.contents.documents)[0] : undefined;
  if (!first) return "New packet";
  return packet.documentCount > 1 ? `${first.name} and ${(packet.documentCount - 1).toLocaleString("en-US")} more` : first.name;
}

/** What a buyer reads under the name; null while the packet is checked again. */
export function buyerSummary(packet: DrivePacket): string | null {
  return isCheckingPlaceholder(packet) || CHECKING_SUMMARIES.has(packet.coverageSummary) ? null : packet.coverageSummary;
}

/** What the owner still needs to add, in the agent's words; never a status line in disguise. */
export function packetGaps(packet: DrivePacket): string[] {
  return packet.kind === "provider_discovery" ? [] : packet.gaps.filter(gap => !STATUS_GAPS.has(gap));
}
export const PACKET_CATEGORY_NAMES: Record<DrivePacketCategory, string> = {
  financial: "Financial statements", bank: "Account statements", brokerage: "Brokerage", insurance: "Insurance",
};
export function categoryPeriods(packets: readonly DrivePacket[], category: DrivePacketCategory): DiscoveryDrivePacket[] {
  return packets.filter((packet): packet is DiscoveryDrivePacket => packet.kind === "provider_discovery" && packet.category === category)
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart));
}
export function packetCategories(packets: readonly DrivePacket[], defaults = false): DrivePacketCategory[] {
  return (Object.keys(PACKET_CATEGORY_NAMES) as DrivePacketCategory[]).filter(category => defaults || categoryPeriods(packets, category).length > 0);
}
export function packetPeriod(packet: DrivePacket): DrivePacketPeriod | null {
  return packet.kind === "provider_discovery" ? { start: packet.periodStart, end: packet.periodEnd } : packet.contents?.period ?? null;
}

export type OwnerPacketStatus = {
  word: "Ready to list" | "Listed" | "Not listed" | "Checking" | "Needs attention" | "Couldn’t check" | "Too large to list" | "Paused" | "Building" | "No shareable files" |
    "Not searched" | "Queued" | "Searching" | "Results so far" | "Files found" | "No matching files";
  tone: PacketTone;
  detail: string;
  /** Lower sorts first: decisions, then live listings, then work in progress. */
  order: number;
};

export function ownerPacketStatus(packet: DrivePacket): OwnerPacketStatus {
  if (packet.kind === "provider_discovery") {
    const preview = packet.preview;
    if (preview?.status === "failed") return { word: "Couldn’t check", tone: "attention", order: 3, detail: "The search couldn’t finish. Saved results are still available; refresh to retry." };
    if (preview?.status === "searching") return { word: "Searching", tone: "waiting", order: 4, detail: "Searching your connected Google Drive. Results appear as they are saved." };
    if (preview?.status === "queued") return { word: "Queued", tone: "waiting", order: 4, detail: "Your search is queued. You can leave this page." };
    if (preview?.status === "partial") return { word: "Results so far", tone: "waiting", order: 4, detail: "These results are incomplete. Search continues in the background." };
    if (preview?.complete && preview.matched === 0) return { word: "No matching files", tone: "paused", order: 3, detail: "Google Drive finished this search with no matching files for the selected dates." };
    if (preview?.complete && (packet.state !== "ready" || packet.freshness !== "current")) return { word: "Files found", tone: "ready", order: 2, detail: "Your search results are available. The sale version is separate and isn’t ready to list." };
    if (packet.state === "building") return { word: "Not searched", tone: "waiting", order: 4, detail: "Open this packet to search your Drive for these dates." };
    if (packet.state === "empty") return { word: "No shareable files", tone: "paused", order: 3, detail: "No files from this search are currently available to share." };
    if (packet.state === "unable_to_verify") return { word: "Couldn’t check", tone: "attention", order: 3, detail: "Files couldn’t be confirmed." };
    if (packet.freshness !== "current") return { word: "Paused", tone: "paused", order: 5, detail: "This packet isn’t available now." };
    if (packet.listingEnabled) return { word: "Listed", tone: "listed", order: 1, detail: "Connections can ask to buy. You approve each buyer." };
    if (!packet.canList) return { word: "Not listed", tone: "paused", order: 3, detail: "This packet can’t be listed." };
    return { word: packet.listingRevision ? "Not listed" : "Ready to list", tone: "ready", order: 2, detail: "Only you can see it." };
  }
  // Either switch pauses preparation (Prepare packets, or Background Drive access), so this names neither.
  if (packet.freshness === "paused") return { word: "Paused", tone: "paused", order: 5,
    detail: packet.listingEnabled ? "Preparation is paused. Connections can see it but can’t buy it." : "Preparation is paused." };
  // A version that isn't ready is never current, so the server sends it as stale. Its own state says
  // more than "Checking", except for the stand-in, which is incomplete only while it is checked again.
  const checkedAgain = isCheckingPlaceholder(packet);
  if (packet.state === "unable_to_verify" && !checkedAgain) return { word: "Couldn’t check", tone: "attention", order: 3, detail: "Agent One couldn’t confirm what’s in it." };
  if (packet.state === "incomplete" && !checkedAgain && packetGaps(packet).length > 0) return { word: "Needs attention", tone: "attention", order: 3, detail: "It can’t be listed yet." };
  if (packet.freshness === "stale" || packet.state !== "ready") return { word: "Checking", tone: "waiting", order: 4,
    detail: packet.listingEnabled ? "Agent One is checking its files. Buyers can’t buy it until then." : "Agent One is checking its files." };
  if (packet.listingEnabled) return { word: "Listed", tone: "listed", order: 1, detail: "Connections can see it and ask to buy. You approve each buyer." };
  if (!packet.canList) return { word: "Too large to list", tone: "attention", order: 3, detail: "A packet over 120 documents can’t be listed." };
  if (packet.listingRevision > 0) return { word: "Not listed", tone: "ready", order: 2, detail: "Only you can see it." };
  return { word: "Ready to list", tone: "ready", order: 0, detail: "Only you can see it until you list it." };
}

/** "Ready to list · 3 documents · Jan–Jun 2026". */
export function ownerStatusLine(packet: DrivePacket): string {
  return [ownerPacketStatus(packet).word, ownerDocumentCount(packet), periodLabel(packetPeriod(packet))]
    .filter(Boolean).join(" · ");
}

export function ownerDocumentCount(packet: DrivePacket): string | null {
  if (packet.kind !== "provider_discovery") return documentCount(packet.documentCount);
  if (!packet.preview) return packet.version ? documentCount(packet.documentCount) : null;
  const preview = packet.preview;
  if (preview.matched === null) return null;
  return `${preview.stale ? "Previously found: " : ""}${documentCount(preview.matched)}${preview.complete || preview.stale ? "" : " found so far"}`;
}

/** A price shows only where it means something: listed, or ready to list. */
export function ownerPacketPrice(packet: DrivePacket): number | null {
  return packet.state === "building" ? null : packet.listingEnabled || packet.canList ? packet.priceCents : null;
}

/** "Oct 13, 2026": when Agent One last checked a packet. */
export function checkedDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** What a buyer's own request for one packet version did, in this session. */
export type BuyerPacketRequest = { requestId: string; existingAccess: boolean; purchaseState?: "pending" | "paid" | "delivered" };
/** Durable receipts take precedence over this mounted list's transient retry result. */
export function savedPacketRequest(packet: DrivePacket): BuyerPacketRequest | null {
  return packet.kind === "provider_discovery" && packet.requestId && packet.purchaseState !== "none"
    ? { requestId: packet.requestId, existingAccess: false, purchaseState: packet.purchaseState } : null;
}

/** A buyer's one line for a packet: "3 documents · January to June 2026", or where their request stands. */
export function buyerPacketStatus(packet: DrivePacket, request: BuyerPacketRequest | null, ownerName: string): { line: string; tone: PacketTone } {
  if (request?.existingAccess) return { line: "You have these files", tone: "listed" };
  if (request?.purchaseState === "delivered") return { line: "Files available", tone: "listed" };
  if (request?.purchaseState === "paid") return { line: "Paid", tone: "waiting" };
  if (request) return { line: `Requested · Waiting for ${ownerName}`, tone: "waiting" };
  if (packet.kind === "provider_discovery" && packet.state !== "ready") {
    const status = ownerPacketStatus(packet);
    return { line: status.word, tone: status.tone };
  }
  if (!packet.canRequest) return { line: "Not available right now", tone: "paused" };
  return { line: [documentCount(packet.documentCount), buyerSummary(packet)].filter(Boolean).join(" · "), tone: "ready" };
}

// The server's note on a packet from a Drive that is not fully read yet.
const PARTIAL_DRIVE = "this is not a complete inventory of matching records.";

/** What a packet may leave out, in plain words, for its buyers and for its owner's "What buyers see". */
export function buyerNotes(packet: DrivePacket): string[] {
  if (packet.kind === "provider_discovery" && packet.category === "financial") return [
    "To group Financial matches, Hussh reads a bounded prefix of supported files and gives the first 400 text characters to a classifier running on Hussh servers. Labels can be incomplete; every original stays in the owner's search results.",
  ];
  if (packet.kind === "provider_discovery") return [packet.state === "ready"
    ? "Files matched a Drive search. Their contents were not read."
    : "Packets use Drive search results. File contents are not read."];
  return packet.description.includes(PARTIAL_DRIVE) ? ["It may not include every matching file."] : [];
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A file request's exact dates: "Sep 29 – Oct 1, 2026", "Dec 30, 2025 – Jan 2, 2026" or "Sep 29, 2026". */
export function dayRangeLabel(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const first = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`);
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime())) return null;
  if (start === end) return DAY_YEAR.format(first);
  return first.getUTCFullYear() === last.getUTCFullYear()
    ? `${DAY.format(first)} – ${DAY_YEAR.format(last)}` : `${DAY_YEAR.format(first)} – ${DAY_YEAR.format(last)}`;
}
