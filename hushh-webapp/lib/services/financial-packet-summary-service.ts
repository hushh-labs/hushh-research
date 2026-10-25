import { ApiService } from "@/lib/services/api-service";
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import type { PacketGuard } from "@/lib/services/drive-packet-service";

export const PUBLIC_PACKET_DISCLOSURE = "drive-packet-public-summary-v1";
export type PacketPublicSummary = { enabled: boolean; revision: number; version: number; disclosure: typeof PUBLIC_PACKET_DISCLOSURE };
export type PacketPublication = { packetId: string; currentVersion: number; title: "Financial documents"; periodStart: string; periodEnd: string; timezone: string; publicSummary: PacketPublicSummary };
export type FinancialPacketSummary = {
  packetId: string; version: number; category: "financial"; title: "Financial documents";
  periodStart: string; periodEnd: string; timezone: string; documentCount: number | null;
  countBasis: "discovery_matches" | "sale_files"; complete: boolean; updatedAt: string | null;
  priceCents: 500; currency: "USD"; availability: "preparing" | "ready" | "unavailable";
  viewerAction: "owner" | "connect" | "pending" | "request" | "view_request" | "view_files" | "unavailable";
};
const invalid = () => new Error("invalid_packet_summary");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return value as number;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !DOCUMENT_REQUEST_UUID.test(value)) throw invalid();
  return value;
}
function day(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw invalid();
  return value;
}
function member<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw invalid();
  return value as T;
}
export function parsePacketPublicSummary(value: unknown): PacketPublicSummary {
  const item = object(value);
  if (typeof item.enabled !== "boolean" || item.disclosure !== PUBLIC_PACKET_DISCLOSURE) throw invalid();
  return { enabled: item.enabled, revision: integer(item.revision), version: integer(item.version), disclosure: PUBLIC_PACKET_DISCLOSURE };
}
/** Construct the public allowlist; private fields never survive parsing. */
export function parseFinancialPacketSummary(value: unknown): FinancialPacketSummary {
  const item = object(value), periodStart = day(item.periodStart), periodEnd = day(item.periodEnd);
  if (periodStart > periodEnd || item.category !== "financial" || item.title !== "Financial documents" || item.priceCents !== 500 || item.currency !== "USD" || typeof item.complete !== "boolean" || typeof item.timezone !== "string" || item.timezone.length > 64) throw invalid();
  try { new Intl.DateTimeFormat("en", { timeZone: item.timezone }); } catch { throw invalid(); }
  if (item.updatedAt !== null && (typeof item.updatedAt !== "string" || item.updatedAt.length > 64 || !Number.isFinite(Date.parse(item.updatedAt)))) throw invalid();
  return { packetId: uuid(item.packetId), version: integer(item.version), category: "financial", title: "Financial documents",
    periodStart, periodEnd, timezone: item.timezone, documentCount: item.documentCount === null ? null : integer(item.documentCount),
    countBasis: member(item.countBasis, ["discovery_matches", "sale_files"]), complete: item.complete, updatedAt: item.updatedAt as string | null,
    priceCents: 500, currency: "USD", availability: member(item.availability, ["preparing", "ready", "unavailable"]),
    viewerAction: member(item.viewerAction, ["owner", "connect", "pending", "request", "view_request", "view_files", "unavailable"]) };
}
async function read(response: Response, guard: PacketGuard): Promise<Record<string, unknown>> {
  guard(); const body = await response.text(); guard();
  if (!response.ok || body.length > 262144) throw new Error("packet_summary_unavailable");
  return object(JSON.parse(body));
}
export class FinancialPacketSummaryService {
  static async list(personRef: string, firebaseToken: string, guard: PacketGuard, cursor?: string | null) {
    uuid(personRef); if (!firebaseToken) throw new Error("authentication_required");
    if (cursor && (cursor.length > 2048 || /[\x00-\x1f]/.test(cursor))) throw invalid();
    guard();
    const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
    const value = await read(await ApiService.apiFetch(`/api/one/people/${personRef}/financial-packets${query}`, {
      method: "GET", cache: "no-store", headers: { Authorization: `Bearer ${firebaseToken}` },
      isEffectCurrent: () => { guard(); return true; },
    }), guard);
    if (!Array.isArray(value.packets) || value.packets.length > 50 || value.nextCursor !== null && (typeof value.nextCursor !== "string" || !value.nextCursor || value.nextCursor.length > 2048)) throw invalid();
    const packets = value.packets.map(parseFinancialPacketSummary);
    if (new Set(packets.map(packet => packet.packetId)).size !== packets.length || cursor && value.nextCursor === cursor) throw invalid();
    return { packets, nextCursor: value.nextCursor as string | null };
  }
  /** Owner scalar receipts only: available without Drive OAuth or background access. */
  static async publications(token: string, guard: PacketGuard, cursor?: string | null): Promise<{ packets: PacketPublication[]; nextCursor: string | null }> {
    if (!token) throw new Error("authentication_required");
    const query = cursor ? `?${new URLSearchParams({ cursor: uuid(cursor) })}` : "";
    guard();
    const value = await read(await ApiService.apiFetch(`/api/connectors/google_drive/sharing/packet-publications${query}`, {
      method: "GET", cache: "no-store", headers: ApiService.getAuthHeaders(token), isEffectCurrent: () => { guard(); return true; },
    }), guard);
    if (!Array.isArray(value.packets) || value.packets.length > 25) throw invalid();
    const packets = value.packets.map(value => {
      const item = object(value), periodStart = day(item.periodStart), periodEnd = day(item.periodEnd), publicSummary = parsePacketPublicSummary(item.publicSummary);
      if (periodStart > periodEnd || item.title !== "Financial documents" || typeof item.timezone !== "string" || item.timezone.length > 64 || !publicSummary.enabled) throw invalid();
      try { new Intl.DateTimeFormat("en", { timeZone: item.timezone }); } catch { throw invalid(); }
      return { packetId: uuid(item.packetId), currentVersion: integer(item.currentVersion), title: "Financial documents" as const, periodStart, periodEnd, timezone: item.timezone, publicSummary };
    });
    const nextCursor = value.nextCursor === null ? null : uuid(value.nextCursor);
    if (new Set(packets.map(packet => packet.packetId)).size !== packets.length || cursor && nextCursor === cursor) throw invalid();
    return { packets, nextCursor };
  }
  static async publish(token: string, packetId: string, expected: PacketPublicSummary, enabled: boolean, guard: PacketGuard): Promise<PacketPublicSummary> {
    uuid(packetId); parsePacketPublicSummary(expected);
    if (!token || typeof enabled !== "boolean") throw invalid();
    guard();
    const value = await read(await ApiService.apiFetch(`/api/connectors/google_drive/sharing/packets/${packetId}/public-summary`, {
      method: "PUT", cache: "no-store", headers: { ...ApiService.getAuthHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, version: expected.version, expectedRevision: expected.revision, disclosure: PUBLIC_PACKET_DISCLOSURE }),
      isEffectCurrent: () => { guard(); return true; },
    }), guard);
    const result = parsePacketPublicSummary(value);
    if (result.enabled !== enabled || enabled && result.version !== expected.version) throw invalid();
    return result;
  }
}
