import type { DrivePacket, DrivePacketDocument, DrivePacketPeriod } from "@/lib/services/drive-packet-service";

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
  return packet.gaps.filter(gap => !STATUS_GAPS.has(gap));
}

export type OwnerPacketStatus = {
  word: "Ready to list" | "Listed" | "Not listed" | "Checking" | "Needs a file" | "Couldn’t check" | "Too large to list" | "Paused";
  tone: PacketTone;
  detail: string;
  /** Lower sorts first: decisions, then live listings, then work in progress. */
  order: number;
};

export function ownerPacketStatus(packet: DrivePacket): OwnerPacketStatus {
  if (packet.freshness === "paused") return { word: "Paused", tone: "paused", order: 5,
    detail: packet.listingEnabled ? "Prepare packets is off. Connections can see it but can’t buy it." : "Prepare packets is off." };
  if (packet.freshness === "stale") return { word: "Checking", tone: "waiting", order: 4, detail: "Agent One is checking its files." };
  if (packet.state === "incomplete") return { word: "Needs a file", tone: "attention", order: 3, detail: "Some files are missing." };
  if (packet.state === "unable_to_verify") return { word: "Couldn’t check", tone: "attention", order: 3, detail: "Agent One couldn’t confirm what’s in it." };
  if (packet.listingEnabled) return { word: "Listed", tone: "listed", order: 1, detail: "Connections can see it and ask to buy. You approve each buyer." };
  if (!packet.canList) return { word: "Too large to list", tone: "attention", order: 3, detail: "A packet over 120 documents can’t be listed." };
  if (packet.listingRevision > 0) return { word: "Not listed", tone: "ready", order: 2, detail: "Only you can see it." };
  return { word: "Ready to list", tone: "ready", order: 0, detail: "Only you can see it until you list it." };
}

/** "Ready to list · 3 documents · Jan–Jun 2026". */
export function ownerStatusLine(packet: DrivePacket): string {
  return [ownerPacketStatus(packet).word, documentCount(packet.documentCount), periodLabel(packet.contents?.period)]
    .filter(Boolean).join(" · ");
}

/** A price shows only where it means something: listed, or ready to list. */
export function ownerPacketPrice(packet: DrivePacket): number | null {
  return packet.listingEnabled || packet.canList ? packet.priceCents : null;
}

/** "Oct 13, 2026": when Agent One last checked a packet. */
export function checkedDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
