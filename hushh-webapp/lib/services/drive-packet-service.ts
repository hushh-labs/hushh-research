import { parsePacketPublicSummary, type PacketPublicSummary } from "@/lib/services/financial-packet-summary-service";
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
type PacketBase = {
  packetId: string; version: number; listingRevision: number; title: string; description: string;
  coverageSummary: string; freshness: "current" | "stale" | "paused";
  priceCents: number;
  listingEnabled: boolean; canRequest: boolean; canList: boolean;
  /** Owner view only: what is inside. A buyer view never carries it. */
  contents?: DrivePacketContents;
};
export type LegacyDrivePacket = PacketBase & {
  kind?: undefined; documentCount: number; state: "ready" | "incomplete" | "unable_to_verify"; gaps: string[];
  verifiedAt: string | null; assessmentScore: number; importance: number; suggestedPriceCents: number;
};
export type DrivePacketCategory = "financial" | "bank" | "brokerage" | "insurance";
export type DiscoveryDrivePacket = PacketBase & {
  kind: "provider_discovery"; documentCount: number | null; saleDocumentCount?: number | null; category: DrivePacketCategory; periodStart: string; periodEnd: string; timezone: string;
  state: "building" | "ready" | "empty" | "unable_to_verify";
  requestId: string | null; purchaseState: "none" | "pending" | "paid" | "delivered";
  /** Own-account search progress; never sale readiness or buyer information. */
  preview?: DrivePacketPreview;
  publicSummary?: PacketPublicSummary;
};
export type DrivePacketPreview = {
  status: "not_started" | "queued" | "searching" | "partial" | "completed" | "failed";
  revision: number; matched: number | null; complete: boolean; stale: boolean; updatedAt: string | null; errorCode: string | null;
  documents?: DrivePacketDocument[]; nextCursor?: string | null; limited?: boolean;
  tagging?: { status: "queued" | "running" | "completed" | "partial" | "failed";
    counts: { financial: number; review: number; other: number; pending: number }; policyVersion: string;
    /** Present only while a failed sorting attempt waits for its scheduled retry. */
    retryAt?: string };
};
export type DrivePacket = LegacyDrivePacket | DiscoveryDrivePacket;
/** Calendar dates, "YYYY-MM-DD". */
export type DrivePacketPeriod = { start: string; end: string };
/** One of the owner's own files in a packet. Never shown to buyers. */
export type DrivePacketDocument = { name: string; type: string | null; pages: number | null; period: DrivePacketPeriod | null; viewUrl?: string; shareable?: boolean; packetTag?: { bucket: "financial" | "review" | "other"; reason: string } };
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) throw new DrivePacketError("invalid_response");
  return result;
}
function viewUrl(value: unknown): string {
  const result = label(value, 2048);
  const url = new URL(result);
  if (url.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(url.hostname) || url.username || url.password || url.port) throw new DrivePacketError("invalid_response");
  return result;
}
function period(value: unknown): DrivePacketPeriod | null {
  if (value === null) return null;
  const item = record(value), result = { start: day(item.start), end: day(item.end) };
  if (result.start > result.end) throw new DrivePacketError("invalid_response");
  return result;
}
/** Annotation failure never hides an otherwise valid original file. */
function optionalPacketTag(value: unknown): DrivePacketDocument["packetTag"] {
  try {
    const item = record(value);
    if (typeof item.bucket !== "string" || !["financial", "review", "other"].includes(item.bucket)) return undefined;
    return { bucket: item.bucket as "financial" | "review" | "other", reason: label(item.reason, 500) };
  } catch { return undefined; }
}
/** A bad optional time drops only itself. */
function optionalDate(value: unknown): string | undefined {
  try { return typeof value === "string" ? date(value) ?? undefined : undefined; } catch { return undefined; }
}
function optionalTagging(value: unknown): DrivePacketPreview["tagging"] {
  try {
    const item = record(value), counts = record(item.counts);
    if (typeof item.status !== "string" || !["queued", "running", "completed", "partial", "failed"].includes(item.status)) return undefined;
    const retryAt = optionalDate(item.retryAt);
    return { status: item.status as NonNullable<DrivePacketPreview["tagging"]>["status"],
      counts: { financial: count(counts.financial), review: count(counts.review), other: count(counts.other), pending: count(counts.pending) },
      policyVersion: label(item.policyVersion, 128), ...(retryAt ? { retryAt } : {}) };
  } catch { return undefined; }
}
function contents(value: unknown): DrivePacketContents {
  const item = record(value);
  if (!Array.isArray(item.documents) || item.documents.length > 120) throw new DrivePacketError("invalid_response");
  return {
    period: period(item.period),
    documents: item.documents.map(entry => {
      const document = record(entry);
      const packetTag = optionalPacketTag(document.packetTag);
      const pages = document.pages === null ? null : count(document.pages);
      if (pages === 0) throw new DrivePacketError("invalid_response");
      return { name: label(document.name, 255), type: document.type === null ? null : label(document.type, 255), pages, period: period(document.period),
        ...(packetTag ? { packetTag } : {}),
        ...(document.shareable === undefined ? {} : { shareable: flag(document.shareable) }),
        ...(document.viewUrl === undefined ? {} : { viewUrl: viewUrl(document.viewUrl) }) };
    }),
  };
}
export function parsePacketPreview(value: unknown): DrivePacketPreview {
  const item = record(value);
  if (typeof item.status !== "string" || !["not_started", "queued", "searching", "partial", "completed", "failed"].includes(item.status)) throw new DrivePacketError("invalid_response");
  const tagging = optionalTagging(item.tagging);
  const result: DrivePacketPreview = {
    ...(tagging ? { tagging } : {}),
    status: item.status as DrivePacketPreview["status"], revision: count(item.revision), matched: item.matched === null ? null : count(item.matched),
    complete: flag(item.complete), stale: flag(item.stale), updatedAt: date(item.updatedAt),
    errorCode: item.errorCode === null ? null : label(item.errorCode, 80),
    ...(item.documents === undefined ? {} : { documents: contents({ period: null, documents: item.documents }).documents,
      nextCursor: item.nextCursor === null ? null : label(item.nextCursor, 2048), limited: flag(item.limited) }),
  };
  if (result.status === "completed" && (!result.complete || result.matched === null) ||
      result.matched === null && result.complete || result.documents && result.matched !== null && result.documents.length > result.matched)
    throw new DrivePacketError("invalid_response");
  return result;
}
/** A buyer view drops `contents` even if a response carried it: file names stay with their owner. */
export function parseDrivePacket(value: unknown, view: "owner" | "buyer" = "buyer"): DrivePacket {
  const item = record(value);
  if (item.kind === "provider_discovery") return discoveryPacket(item, view);
  if (item.kind !== undefined) throw new DrivePacketError("invalid_response");
  if (!["ready", "incomplete", "unable_to_verify"].includes(String(item.state)) ||
      !["current", "stale", "paused"].includes(String(item.freshness)) ||
      !Array.isArray(item.gaps) || item.gaps.length > 100 || count(item.assessmentScore) > 100 ||
      count(item.importance) < 1 || count(item.importance) > 500) throw new DrivePacketError("invalid_response");
  const result: LegacyDrivePacket = {
    packetId: id(item.packetId), version: packetVersion(item.version), listingRevision: count(item.listingRevision),
    title: label(item.title, 250), description: label(item.description, 2000),
    state: item.state as LegacyDrivePacket["state"], coverageSummary: label(item.coverageSummary, 2000),
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
function discoveryPacket(item: RecordValue, view: "owner" | "buyer"): DiscoveryDrivePacket {
  const category = item.category, state = item.state, purchaseState = item.purchaseState;
  if (typeof category !== "string" || !["financial", "bank", "brokerage", "insurance"].includes(category) ||
      typeof state !== "string" || !["building", "ready", "empty", "unable_to_verify"].includes(state) ||
      typeof purchaseState !== "string" || !["none", "pending", "paid", "delivered"].includes(purchaseState) ||
      typeof item.freshness !== "string" || !["current", "stale", "paused"].includes(item.freshness) || item.priceCents !== 500) throw new DrivePacketError("invalid_response");
  const span = period({ start: item.periodStart, end: item.periodEnd })!;
  const timezone = label(item.timezone, 64);
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new DrivePacketError("invalid_response"); }
  const result: DiscoveryDrivePacket = {
    kind: "provider_discovery", category: category as DrivePacketCategory, state: state as DiscoveryDrivePacket["state"],
    packetId: id(item.packetId), version: count(item.version), listingRevision: count(item.listingRevision),
    title: label(item.title, 250), description: label(item.description, 2000), coverageSummary: label(item.coverageSummary, 2000),
    periodStart: span.start, periodEnd: span.end, timezone, priceCents: 500, documentCount: item.documentCount === null ? null : count(item.documentCount),
    ...(item.saleDocumentCount === undefined ? {} : { saleDocumentCount: item.saleDocumentCount === null ? null : count(item.saleDocumentCount) }),
    freshness: item.freshness as DrivePacket["freshness"], listingEnabled: flag(item.listingEnabled),
    canList: flag(item.canList), canRequest: flag(item.canRequest), requestId: item.requestId === null ? null : id(item.requestId),
    purchaseState: purchaseState as DiscoveryDrivePacket["purchaseState"],
    ...(view === "owner" && item.contents !== undefined ? { contents: contents(item.contents) } : {}),
    ...(view === "owner" && item.preview !== undefined ? { preview: parsePacketPreview(item.preview) } : {}),
    ...(view === "owner" && item.publicSummary !== undefined ? { publicSummary: parsePacketPublicSummary(item.publicSummary) } : {}),
  };
  const saleCount = result.saleDocumentCount === undefined ? result.documentCount : result.saleDocumentCount;
  if ((result.state === "ready" || result.state === "empty") && result.version < 1 || result.state === "building" && result.version !== 0 ||
      result.state !== "ready" && result.listingEnabled ||
      (result.canList || result.canRequest) && (result.state !== "ready" || result.freshness !== "current" || !saleCount) ||
      result.state === "empty" && saleCount !== 0 ||
      (result.purchaseState === "none") !== (result.requestId === null)) throw new DrivePacketError("invalid_response");
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
      method: body === undefined ? "GET" : "POST", cache: "no-store", timeoutMs: 8_000,
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
  static async preview(token: string, packetId: string, guard: PacketGuard, cursor?: string | null): Promise<DrivePacketPreview> {
    const query = cursor ? `?${new URLSearchParams({ cursor: label(cursor, 2048) })}` : "";
    return parsePacketPreview(await this.send(token, guard, `/sharing/packets/${id(packetId)}/preview${query}`));
  }
  static async preparePreview(token: string, packetId: string, guard: PacketGuard, refresh = false): Promise<DrivePacketPreview> {
    return parsePacketPreview(await this.send(token, guard, `/sharing/packets/${id(packetId)}/preview`, { refresh: flag(refresh) }));
  }
  static async listing(token: string, packet: DrivePacket, decision: "allow" | "deny", priceCents: number, guard: PacketGuard): Promise<void> {
    if (decision !== "allow" && decision !== "deny") throw new DrivePacketError("invalid_argument");
    if (packet.kind === "provider_discovery" && priceCents !== 500) throw new DrivePacketError("invalid_argument");
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
