import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { isValidDocumentRequestPriceCents } from "@/lib/consent/document-request-price";
import { ApiService } from "@/lib/services/api-service";

const ROOT = "/api/connectors/google_drive";
export type PacketGuard = () => void;
export type DriveCollectionStatus = {
  enabled: boolean; backgroundEnabled: boolean;
  state: "not_enabled" | "paused" | "unable_to_verify" | "indexing" | "incomplete" | "ready";
  revision: number;
  counts: { discovered: number; extracted: number; indexed: number; failed: number; pending: number };
  initialStartedAt: string | null; initialCompletedAt: string | null;
  lastSyncedAt: string | null; lastIndexedAt: string | null; lastExtractedAt: string | null;
  initialExtractionCompletedAt: string | null; initialExtractionDurationMs: number | null;
  lastSemanticIndexingDurationMs: number | null; lastDocumentExtractionDurationMs: number | null;
  initialIndexingDurationMs: number | null; syncDurationMs: number;
};
export type DrivePacket = {
  packetId: string; version: number; listingRevision: number; title: string; description: string;
  state: "ready" | "incomplete" | "unable_to_verify"; coverageSummary: string; gaps: string[];
  documentCount: number; verifiedAt: string | null; freshness: "current" | "stale" | "paused";
  assessmentScore: number; importance: number; suggestedPriceCents: number; priceCents: number;
  listingEnabled: boolean; canRequest: boolean; canList: boolean;
  /** Owner view only: what is inside. A buyer view never carries it. */
  contents?: DrivePacketContents;
};
/** Calendar dates, "YYYY-MM-DD". */
export type DrivePacketPeriod = { start: string; end: string };
/** One of the owner's own files in a packet. Never shown to buyers. */
export type DrivePacketDocument = { name: string; type: string | null; pages: number | null; period: DrivePacketPeriod | null };
/** The dates a packet covers and its first files (a packet lists at most 120). */
export type DrivePacketContents = { period: DrivePacketPeriod | null; documents: DrivePacketDocument[] };
export class DrivePacketError extends Error {
  constructor(readonly code: string) { super("Document packets are unavailable."); }
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DrivePacketError("invalid_response");
  return value as RecordValue;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DrivePacketError("invalid_response");
  return value as number;
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new DrivePacketError("invalid_response");
  return value;
}
function label(value: unknown, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new DrivePacketError("invalid_response");
  return value;
}
function date(value: unknown): string | null {
  if (value === null) return null;
  const result = label(value, 64);
  if (!Number.isFinite(Date.parse(result))) throw new DrivePacketError("invalid_response");
  return result;
}
function id(value: unknown): string {
  const result = label(value, 36);
  if (!DOCUMENT_REQUEST_UUID.test(result)) throw new DrivePacketError("invalid_response");
  return result;
}
function price(value: unknown): number {
  if (!isValidDocumentRequestPriceCents(value)) throw new DrivePacketError("invalid_response");
  return value;
}
function packetVersion(value: unknown): number {
  const result = count(value);
  if (result < 1) throw new DrivePacketError("invalid_response");
  return result;
}
function day(value: unknown): string {
  const result = label(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result))) throw new DrivePacketError("invalid_response");
  return result;
}
function period(value: unknown): DrivePacketPeriod | null {
  if (value === null) return null;
  const item = record(value), result = { start: day(item.start), end: day(item.end) };
  if (result.start > result.end) throw new DrivePacketError("invalid_response");
  return result;
}
function contents(value: unknown): DrivePacketContents {
  const item = record(value);
  if (!Array.isArray(item.documents) || item.documents.length > 120) throw new DrivePacketError("invalid_response");
  return {
    period: period(item.period),
    documents: item.documents.map(entry => {
      const document = record(entry);
      const pages = document.pages === null ? null : count(document.pages);
      if (pages === 0) throw new DrivePacketError("invalid_response");
      return { name: label(document.name, 255), type: document.type === null ? null : label(document.type, 255), pages, period: period(document.period) };
    }),
  };
}
/** A buyer view drops `contents` even if a response carried it: file names stay with their owner. */
export function parseDrivePacket(value: unknown, view: "owner" | "buyer" = "buyer"): DrivePacket {
  const item = record(value);
  if (!["ready", "incomplete", "unable_to_verify"].includes(String(item.state)) ||
      !["current", "stale", "paused"].includes(String(item.freshness)) ||
      !Array.isArray(item.gaps) || item.gaps.length > 100 || count(item.assessmentScore) > 100 ||
      count(item.importance) < 1 || count(item.importance) > 500) throw new DrivePacketError("invalid_response");
  const result: DrivePacket = {
    packetId: id(item.packetId), version: packetVersion(item.version), listingRevision: count(item.listingRevision),
    title: label(item.title, 250), description: label(item.description, 2000),
    state: item.state as DrivePacket["state"], coverageSummary: label(item.coverageSummary, 2000),
    gaps: item.gaps.map(gap => label(gap)), documentCount: count(item.documentCount),
    verifiedAt: date(item.verifiedAt), freshness: item.freshness as DrivePacket["freshness"],
    assessmentScore: count(item.assessmentScore), importance: count(item.importance),
    suggestedPriceCents: price(item.suggestedPriceCents), priceCents: price(item.priceCents),
    listingEnabled: flag(item.listingEnabled), canRequest: flag(item.canRequest), canList: flag(item.canList),
    ...(view === "owner" && item.contents !== undefined ? { contents: contents(item.contents) } : {}),
  };
  if ((result.canRequest || result.canList) && (result.state !== "ready" || result.freshness !== "current") ||
      result.state === "ready" && result.freshness === "current" && result.gaps.length > 0) throw new DrivePacketError("invalid_response");
  return result;
}
export function parseDriveCollectionStatus(value: unknown): DriveCollectionStatus {
  const item = record(value), counts = record(item.counts);
  const states = ["not_enabled", "paused", "unable_to_verify", "indexing", "incomplete", "ready"];
  if (!states.includes(String(item.state))) throw new DrivePacketError("invalid_response");
  const result: DriveCollectionStatus = {
    enabled: flag(item.enabled), backgroundEnabled: flag(item.backgroundEnabled),
    state: item.state as DriveCollectionStatus["state"], revision: count(item.revision),
    counts: { discovered: count(counts.discovered), extracted: count(counts.extracted), indexed: count(counts.indexed),
      failed: count(counts.failed), pending: count(counts.pending) },
    initialStartedAt: date(item.initialStartedAt), initialCompletedAt: date(item.initialCompletedAt),
    lastSyncedAt: date(item.lastSyncedAt), lastIndexedAt: date(item.lastIndexedAt), lastExtractedAt: date(item.lastExtractedAt),
    initialExtractionCompletedAt: date(item.initialExtractionCompletedAt),
    initialExtractionDurationMs: item.initialExtractionDurationMs === null ? null : count(item.initialExtractionDurationMs),
    lastSemanticIndexingDurationMs: item.lastSemanticIndexingDurationMs === null ? null : count(item.lastSemanticIndexingDurationMs),
    lastDocumentExtractionDurationMs: item.lastDocumentExtractionDurationMs === null ? null : count(item.lastDocumentExtractionDurationMs),
    initialIndexingDurationMs: item.initialIndexingDurationMs === null ? null : count(item.initialIndexingDurationMs),
    syncDurationMs: count(item.syncDurationMs),
  };
  if (result.counts.indexed + result.counts.failed + result.counts.pending !== result.counts.discovered ||
      result.counts.indexed > result.counts.extracted || result.counts.extracted > result.counts.discovered) {
    throw new DrivePacketError("invalid_response");
  }
  return result;
}

/** Private results stay in this mounted session, with owner fences at every await. */
export class DrivePacketService {
  private static async send(token: string, guard: PacketGuard, path: string, body?: object, firebaseToken?: string): Promise<RecordValue> {
    if (!token) throw new DrivePacketError("vault_locked");
    guard();
    const response = await ApiService.apiFetch(`${ROOT}${path}`, {
      method: body === undefined ? "GET" : "POST", cache: "no-store",
      headers: { ...(firebaseToken ? { Authorization: `Bearer ${firebaseToken}`, "X-Hushh-Consent": token } : ApiService.getAuthHeaders(token)), "Content-Type": "application/json" },
      isEffectCurrent: () => { guard(); return true; },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    guard();
    const serialized = await response.text();
    guard();
    if (serialized.length > 262144) throw new DrivePacketError("invalid_response");
    let payload: RecordValue;
    try { payload = record(JSON.parse(serialized)); } catch { throw new DrivePacketError("invalid_response"); }
    if (!response.ok) {
      const detail = payload.detail && typeof payload.detail === "object" ? record(payload.detail) : payload;
      throw new DrivePacketError(typeof detail.code === "string" && /^[a-z_]{1,80}$/.test(detail.code) ? detail.code : "request_failed");
    }
    return payload;
  }
  static async collection(token: string, guard: PacketGuard): Promise<DriveCollectionStatus> {
    return parseDriveCollectionStatus(await this.send(token, guard, "/collection/status"));
  }
  static async setProcessing(token: string, enabled: boolean, guard: PacketGuard): Promise<DriveCollectionStatus> {
    flag(enabled);
    const result = await this.send(token, guard, "/collection/processing", {
      enabled, confirmed: true, ...(enabled ? { disclosure: "live-drive-collection-v1" } : {}),
    });
    if (flag(result.enabled) !== enabled) throw new DrivePacketError("invalid_response");
    count(result.revision);
    return this.collection(token, guard);
  }
  static async packets(token: string, guard: PacketGuard, ownerPersonRef?: string, cursor?: string | null): Promise<{ packets: DrivePacket[]; nextCursor: string | null }> {
    const query = new URLSearchParams();
    if (ownerPersonRef) query.set("ownerPersonRef", id(ownerPersonRef));
    if (cursor) query.set("cursor", label(cursor, 2048));
    const value = await this.send(token, guard, `/sharing/packets${query.size ? `?${query}` : ""}`);
    if (!Array.isArray(value.packets) || value.packets.length > 50) throw new DrivePacketError("invalid_response");
    const packets = value.packets.map(packet => parseDrivePacket(packet, ownerPersonRef ? "buyer" : "owner"));
    if (new Set(packets.map(packet => packet.packetId)).size !== packets.length) throw new DrivePacketError("invalid_response");
    return { packets, nextCursor: value.nextCursor === null ? null : label(value.nextCursor, 2048) };
  }
  static async listing(token: string, packet: DrivePacket, decision: "allow" | "deny", priceCents: number, guard: PacketGuard): Promise<void> {
    if (decision !== "allow" && decision !== "deny") throw new DrivePacketError("invalid_argument");
    await this.send(token, guard, `/sharing/packets/${id(packet.packetId)}/listing`, {
      version: packetVersion(packet.version), decision, priceCents: price(priceCents),
      expectedRevision: count(packet.listingRevision), disclosure: "drive-packet-listing-connections-v1",
    });
  }
  static async request(token: string, firebaseToken: string, packet: DrivePacket, clientRequestId: string, guard: PacketGuard): Promise<{ requestId: string; existingAccess: boolean }> {
    if (!firebaseToken) throw new DrivePacketError("verify_google_identity_required");
    const value = await this.send(token, guard, `/sharing/packets/${id(packet.packetId)}/requests`, {
      version: packetVersion(packet.version), clientRequestId: id(clientRequestId),
    }, firebaseToken);
    return { requestId: id(value.requestId), existingAccess: flag(value.existingAccess) };
  }
}
