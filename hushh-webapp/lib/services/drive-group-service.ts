import { ApiService } from "@/lib/services/api-service";
import type { PacketGuard } from "@/lib/services/drive-packet-service";

export const DRIVE_GROUPS = ["financial_statements", "insurance_statements", "non_financial_statements", "personal_documents"] as const;
export type DriveGroup = typeof DRIVE_GROUPS[number];
export type DriveShelf = DriveGroup | "kept";
export type DriveGroupStatus = {
  enabled: boolean; state: "off" | "indexing" | "paused" | "incomplete" | "ready";
  revision: number; timeZone: string; listedFiles: number; indexedFiles: number;
  counts: Record<DriveShelf, number>; listingComplete: boolean; limited: boolean;
  lastRunAt: string | null;
};
export type DriveGroupOverview = { status: DriveGroupStatus; groups: { shelf: DriveGroup; name: string }[] };
export type DriveGroupFile = { ref: string; title: string; viewUrl: string; day: string | null };
export type DriveGroupPage = { items: DriveGroupFile[]; nextCursor: number | null; total: number };
export class DriveGroupError extends Error {
  constructor(readonly code: string) { super("Data packets are unavailable."); }
}
function invalid(): never { throw new DriveGroupError("invalid_response"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function label(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return invalid();
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10000) return invalid();
  return value as number;
}
function flag(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function shelf(value: unknown): DriveShelf {
  return value === "kept" || DRIVE_GROUPS.some(group => group === value) ? value as DriveShelf : invalid();
}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  const result = label(value, 64);
  return Number.isFinite(Date.parse(result)) ? result : invalid();
}
function revision(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : invalid();
}
export function parseDriveGroups(value: unknown): DriveGroupOverview {
  const body = record(value), status = record(body.status), counts = record(status.counts);
  if (!["off", "indexing", "paused", "incomplete", "ready"].includes(String(status.state)) || !Array.isArray(body.groups) || body.groups.length !== 4) return invalid();
  const groups = body.groups.map(entry => { const group = record(entry), key = shelf(group.shelf); if (key === "kept") return invalid(); return { shelf: key, name: label(group.name, 60) }; });
  if (new Set(groups.map(group => group.shelf)).size !== 4) return invalid();
  const parsed: DriveGroupStatus = { enabled: flag(status.enabled), state: status.state as DriveGroupStatus["state"],
    revision: revision(status.revision), timeZone: label(status.timeZone, 64), listedFiles: count(status.listedFiles), indexedFiles: count(status.indexedFiles),
    counts: Object.fromEntries([...DRIVE_GROUPS, "kept"].map(key => [key, count(counts[key])])) as Record<DriveShelf, number>,
    listingComplete: flag(status.listingComplete), limited: flag(status.limited), lastRunAt: timestamp(status.lastRunAt) };
  if (Object.values(parsed.counts).reduce((sum, value) => sum + value, 0) !== parsed.indexedFiles) return invalid();
  return { status: parsed, groups };
}
export function parseDriveGroupPage(value: unknown, cursor: number): DriveGroupPage {
  const body = record(value), total = count(body.total), nextCursor = body.nextCursor === null ? null : count(body.nextCursor);
  if (!Array.isArray(body.items) || body.items.length > 50 || nextCursor !== null && (nextCursor <= cursor || nextCursor > total)) return invalid();
  const items = body.items.map(entry => {
    const item = record(entry), ref = label(item.ref, 64), viewUrl = label(item.viewUrl, 512), day = item.day === null ? null : label(item.day, 10);
    if (!/^[a-f0-9]{64}$/.test(ref) || !/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{1,200}\/view$/.test(viewUrl) ||
        day !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)))) return invalid();
    return { ref, title: label(item.title, 1000), viewUrl, day };
  });
  if (new Set(items.map(item => item.ref)).size !== items.length || cursor + items.length > total || nextCursor !== null && nextCursor !== cursor + items.length) return invalid();
  return { items, total, nextCursor };
}

/** Owner-only, uncached reads. Names remain in the mounted connector session. */
export class DriveGroupService {
  private static async send(token: string, guard: PacketGuard, path = "", body?: object): Promise<unknown> {
    if (!token) throw new DriveGroupError("vault_locked");
    guard();
    const response = await ApiService.apiFetch(`/api/connectors/google_drive/groups${path}`, {
      method: body === undefined ? "GET" : "POST", cache: "no-store",
      headers: { ...ApiService.getAuthHeaders(token), "Content-Type": "application/json" },
      isEffectCurrent: () => { guard(); return true; },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    guard();
    const serialized = await response.text();
    guard();
    if (serialized.length > 262144) return invalid();
    let value: unknown;
    try { value = JSON.parse(serialized); } catch { return invalid(); }
    if (!response.ok) {
      const detail = record(record(value).detail ?? value);
      throw new DriveGroupError(typeof detail.code === "string" && /^[a-z_]{1,80}$/.test(detail.code) ? detail.code : "request_failed");
    }
    return value;
  }
  static async overview(token: string, guard: PacketGuard): Promise<DriveGroupOverview> { return parseDriveGroups(await this.send(token, guard)); }
  static async files(token: string, key: DriveShelf, cursor: number, guard: PacketGuard): Promise<DriveGroupPage> {
    shelf(key); count(cursor);
    return parseDriveGroupPage(await this.send(token, guard, `/${key}/files?cursor=${cursor}&limit=50`), cursor);
  }
  static async setProcessing(token: string, enabled: boolean, guard: PacketGuard): Promise<DriveGroupOverview> {
    flag(enabled);
    await this.send(token, guard, "/processing", { enabled, ...(enabled ? { disclosure: "drive-four-group-v1" } : {}), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    return this.overview(token, guard);
  }
}
