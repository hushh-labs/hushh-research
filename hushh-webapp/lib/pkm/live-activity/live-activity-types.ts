/**
 * Live activity: a typed, owner-scoped record of what the owner does in One
 * while signed in and unlocked on this device. Pure types and validation only;
 * the journal (live-activity-journal.ts) owns capture, storage and lifecycle.
 *
 * Every field is an authored enum, an allowlisted id, a bounded number or a
 * short place label: the owner's own name for a saved place (up to 40
 * characters of their text, which may name a person) or a Google venue's
 * public name (a check-in, or a place saved from one). A label that repeats the place's own street address is dropped
 * on a best-effort basis. Never put message, mail or file contents,
 * coordinates, connection or counterpart identity, URLs or tokens here.
 */

export const LIVE_ACTIVITY_SCHEMA_VERSION = 1 as const;

export const LIVE_ACTIVITY_KINDS = [
  "section_opened",
  "connector_connected",
  "connector_disconnected",
  "connector_synced",
  "connector_sync_failed",
  "location_sharing_started",
  "location_sharing_stopped",
  "place_saved",
  "place_removed",
  "checked_in",
  "connection_request_sent",
  "connection_accepted",
  "connection_removed",
  "consent_approved",
  "consent_declined",
  "consent_revoked",
  "profile_updated",
  "pwm_reviewed",
  "memory_saved",
  "wallet_card_added",
  "wallet_card_removed",
] as const;

export type LiveActivityKind = (typeof LIVE_ACTIVITY_KINDS)[number];

/** Kinds whose `label` may carry the short name of a place the owner chose. */
export const LIVE_ACTIVITY_LABELLED_KINDS: ReadonlySet<LiveActivityKind> = new Set([
  "place_saved",
  "place_removed",
  "checked_in",
]);

export type LiveActivityEvent = Readonly<{
  v: typeof LIVE_ACTIVITY_SCHEMA_VERSION;
  /** `${streamId}:${seq}`; unique per owner. */
  id: string;
  /** One stream per page load, so tabs never contend for a record. */
  streamId: string;
  /** Monotonic within its stream. */
  seq: number;
  kind: LiveActivityKind;
  /** Allowlisted id: agent section, route id or connector id. */
  subject: string | null;
  /** Name of a place the owner chose; only for LIVE_ACTIVITY_LABELLED_KINDS. */
  label: string | null;
  /** Bounded count from the action itself, such as receipts synced. */
  quantity: number | null;
  /** Repeats of the same kind, subject and label coalesced into this event. */
  count: number;
  firstAt: number;
  lastAt: number;
}>;

export type LiveActivityInput = Readonly<{
  kind: LiveActivityKind;
  subject?: string | null;
  label?: string | null;
  quantity?: number | null;
  at?: number;
}>;

export const LIVE_ACTIVITY_RING_CAPACITY = 512;
export const LIVE_ACTIVITY_CHUNK_SIZE = 64;
export const LIVE_ACTIVITY_COALESCE_WINDOW_MS = 10 * 60_000;
export const LIVE_ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const LIVE_ACTIVITY_MAX_PERSISTED_EVENTS = 2048;
export const LIVE_ACTIVITY_RESOURCE_PREFIX = "one_activity.v1:";

const KIND_SET: ReadonlySet<string> = new Set(LIVE_ACTIVITY_KINDS);
const SUBJECT_PATTERN = /^[a-z0-9_]{1,48}$/;
const MAX_LABEL_CHARS = 40;
const MAX_QUANTITY = 100_000;

export function isLiveActivityKind(value: unknown): value is LiveActivityKind {
  return typeof value === "string" && KIND_SET.has(value);
}

function normalizeLabel(kind: LiveActivityKind, value: unknown): string | null {
  if (!LIVE_ACTIVITY_LABELLED_KINDS.has(kind) || typeof value !== "string") return null;
  // One line of printable text; control characters and runs of space collapse.
  const label = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return label ? label.slice(0, MAX_LABEL_CHARS) : null;
}

function normalizeQuantity(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), MAX_QUANTITY);
}

/** The only path from caller input to a journal event: invalid input is dropped. */
export function normalizeLiveActivityInput(input: unknown, now = Date.now()): Required<LiveActivityInput> | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Record<string, unknown>;
  if (!isLiveActivityKind(candidate.kind)) return null;
  const subject = candidate.subject;
  if (subject !== undefined && subject !== null && (typeof subject !== "string" || !SUBJECT_PATTERN.test(subject))) {
    return null;
  }
  const at = typeof candidate.at === "number" && Number.isFinite(candidate.at) ? candidate.at : now;
  return {
    kind: candidate.kind,
    subject: typeof subject === "string" ? subject : null,
    label: normalizeLabel(candidate.kind, candidate.label),
    quantity: normalizeQuantity(candidate.quantity),
    at,
  };
}

/** Events with the same key inside the coalesce window merge into one row. */
export function liveActivityCoalesceKey(event: Pick<LiveActivityEvent, "kind" | "subject" | "label">): string {
  return `${event.kind}|${event.subject ?? ""}|${event.label ?? ""}`;
}

export function isLiveActivityEvent(value: unknown): value is LiveActivityEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return event.v === LIVE_ACTIVITY_SCHEMA_VERSION &&
    typeof event.id === "string" && typeof event.streamId === "string" &&
    Number.isSafeInteger(event.seq) && isLiveActivityKind(event.kind) &&
    (event.subject === null || (typeof event.subject === "string" && SUBJECT_PATTERN.test(event.subject))) &&
    (event.label === null || (typeof event.label === "string" && event.label.length <= MAX_LABEL_CHARS)) &&
    (event.quantity === null || (typeof event.quantity === "number" && Number.isFinite(event.quantity))) &&
    Number.isSafeInteger(event.count) && (event.count as number) >= 1 &&
    typeof event.firstAt === "number" && typeof event.lastAt === "number";
}
