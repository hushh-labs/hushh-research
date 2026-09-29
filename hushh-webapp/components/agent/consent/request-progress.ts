/**
 * The requester's living consent card: the progress model (contract C1).
 *
 * Inputs
 * - `RequestProgress`: parsed from `GET /api/one/information-requests/{bundle_id}`
 *   `.progress` (`requested_at`, `delivered_at`, `seen_at`, `decided_at`,
 *   `outcome`, `access_ends_at`, `ended_at`, `fields[]`). Missing or malformed
 *   progress parses to null and the card keeps its pre-C1 behaviour.
 * - `RequesterCardPhase`: set by the chat (lane C2) once an answer has
 *   arrived. "reading" while One reads what was shared, "answered" once One's
 *   reply has landed. The card never infers these from time.
 *
 * Output: `timelineFor(progress, phase)` returns the calm step rail
 * Asked, Delivered, Seen, Decided, Reading, Answered, with exactly one
 * `current` step while something is still in motion.
 */

/** `cancelled`: the requester withdrew the request (the server's `bundle_outcome_from_statuses`). */
export type RequestOutcome = "pending" | "granted" | "partially_granted" | "denied" | "expired" | "revoked" | "cancelled";
export type RequestFieldStatus = "pending" | "granted" | "denied" | "expired" | "revoked" | "cancelled";

export type RequestProgressField = {
  label: string;
  status: RequestFieldStatus;
};

export type RequestProgress = {
  requestedAt: string;
  deliveredAt: string | null;
  seenAt: string | null;
  decidedAt: string | null;
  outcome: RequestOutcome;
  accessEndsAt: string | null;
  endedAt: string | null;
  fields: RequestProgressField[];
};

/** Set by the chat (C2) after an answer arrives; null or undefined otherwise. */
export type RequesterCardPhase = "reading" | "answered";

export type TimelineStepKey = "asked" | "delivered" | "seen" | "decided" | "reading" | "answered";
export type TimelineStepState = "done" | "current" | "upcoming";
export type TimelineStep = {
  key: TimelineStepKey;
  label: string;
  state: TimelineStepState;
  /** A quieter "done" for a step that closed without the owner acting, such as a decline. */
  tone: "positive" | "neutral";
};

const OUTCOMES: readonly RequestOutcome[] = ["pending", "granted", "partially_granted", "denied", "expired", "revoked", "cancelled"];
const FIELD_STATUSES: readonly RequestFieldStatus[] = ["pending", "granted", "denied", "expired", "revoked", "cancelled"];
const MAX_FIELDS = 50;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function pick(record: Record<string, unknown>, snake: string, camel: string): unknown {
  return record[snake] ?? record[camel];
}

/** Parse contract C1 progress, snake_case or camelCase. Null means "older backend". */
export function parseRequestProgress(value: unknown): RequestProgress | null {
  const record = asRecord(value);
  if (!record) return null;
  const requestedAt = isoOrNull(pick(record, "requested_at", "requestedAt"));
  const outcome = pick(record, "outcome", "outcome");
  if (!requestedAt || typeof outcome !== "string" || !OUTCOMES.includes(outcome as RequestOutcome)) return null;
  const rawFields = Array.isArray(record.fields) ? record.fields.slice(0, MAX_FIELDS) : [];
  const fields = rawFields.flatMap<RequestProgressField>((raw) => {
    const field = asRecord(raw);
    const label = typeof field?.label === "string" ? field.label.trim() : "";
    const status = field?.status;
    if (!label || label.length > 120 || typeof status !== "string"
      || !FIELD_STATUSES.includes(status as RequestFieldStatus)) return [];
    return [{ label, status: status as RequestFieldStatus }];
  });
  return {
    requestedAt,
    deliveredAt: isoOrNull(pick(record, "delivered_at", "deliveredAt")),
    seenAt: isoOrNull(pick(record, "seen_at", "seenAt")),
    decidedAt: isoOrNull(pick(record, "decided_at", "decidedAt")),
    outcome: outcome as RequestOutcome,
    accessEndsAt: isoOrNull(pick(record, "access_ends_at", "accessEndsAt")),
    endedAt: isoOrNull(pick(record, "ended_at", "endedAt")),
    fields,
  };
}

/** Access was given and has now ended (revoked, or it ran out after a decision). */
export function isAccessEnded(progress: Pick<RequestProgress, "outcome" | "decidedAt">): boolean {
  return progress.outcome === "revoked" || (progress.outcome === "expired" && Boolean(progress.decidedAt));
}

/** The request ran out before the owner answered. */
export function isUnansweredExpiry(progress: Pick<RequestProgress, "outcome" | "decidedAt">): boolean {
  return progress.outcome === "expired" && !progress.decidedAt;
}

function decidedLabel(progress: RequestProgress): string {
  switch (progress.outcome) {
    case "granted":
    case "revoked":
      return "Shared";
    case "partially_granted":
      // The headline says "some"; the rail stays short enough for a phone.
      return "Shared";
    case "denied":
      return "Declined";
    case "cancelled":
      return "Withdrawn";
    case "expired":
      return progress.decidedAt ? "Shared" : "No answer";
    default:
      return "Decided";
  }
}

export function timelineFor(progress: RequestProgress, phase?: RequesterCardPhase | null): TimelineStep[] {
  const decided = progress.outcome !== "pending";
  const answeredWithAccess = progress.outcome === "granted" || progress.outcome === "partially_granted"
    || isAccessEnded(progress);
  // A decline or an unanswered expiry has nothing to read; One still answers.
  const skipReading = !answeredWithAccess;
  const done: Record<TimelineStepKey, boolean> = {
    asked: true,
    delivered: Boolean(progress.deliveredAt || progress.seenAt || decided),
    seen: Boolean(progress.seenAt || (decided && progress.decidedAt)),
    decided,
    reading: phase === "answered",
    answered: phase === "answered",
  };
  const keys: TimelineStepKey[] = skipReading
    ? ["asked", "delivered", "seen", "decided", "answered"]
    : ["asked", "delivered", "seen", "decided", "reading", "answered"];
  // Unanswered expiry: the owner never saw a decision point, so Seen is only
  // done if it really happened. A withdrawn request likewise shows only the
  // steps that really happened before the requester withdrew it.
  if (isUnansweredExpiry(progress)) done.seen = Boolean(progress.seenAt);
  if (progress.outcome === "cancelled") {
    done.delivered = Boolean(progress.deliveredAt || progress.seenAt);
    done.seen = Boolean(progress.seenAt);
  }
  const labels: Record<TimelineStepKey, string> = {
    asked: "Asked", delivered: "Delivered", seen: "Seen", decided: decidedLabel(progress),
    reading: "Reading", answered: "Answered",
  };
  // Only something actually in motion gets the live pulse: the owner has not
  // decided yet, or One is reading what they shared.
  const inMotion = progress.outcome === "pending" || (phase === "reading" && !skipReading);
  let currentAssigned = false;
  return keys.map((key) => {
    let state: TimelineStepState = done[key] ? "done" : "upcoming";
    if (state === "upcoming" && inMotion && !currentAssigned) {
      state = "current";
      currentAssigned = true;
    }
    const tone = key === "decided"
      && (progress.outcome === "denied" || progress.outcome === "cancelled" || isUnansweredExpiry(progress))
      ? "neutral" : "positive";
    return { key, label: labels[key], state, tone };
  });
}

export function firstName(name: string): string {
  const trimmed = String(name || "").trim();
  return trimmed.split(/\s+/)[0] || "They";
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const TIME_FORMAT = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** "Oct 5". */
export function formatDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? DAY_FORMAT.format(ms) : null;
}

/** "2:14 PM". */
export function formatTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? TIME_FORMAT.format(ms) : null;
}

/** "a", "a and b", "a, b and c". */
export function joinLabels(labels: string[]): string {
  const list = labels.map((label) => label.trim()).filter(Boolean);
  if (!list.length) return "what you asked for";
  if (list.length === 1) return list[0]!;
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** One calm sentence for where the request is right now. */
export function progressHeadline(progress: RequestProgress, personName: string, phase?: RequesterCardPhase | null): string {
  const name = firstName(personName);
  const shared = progress.fields.filter((field) => field.status === "granted").map((field) => field.label);
  if (progress.outcome === "revoked") return `${name} stopped sharing`;
  if (isAccessEnded(progress)) return "Access ended";
  if (isUnansweredExpiry(progress)) return `This request expired before ${name} answered`;
  if (progress.outcome === "denied") return `${name} chose not to share this`;
  if (progress.outcome === "cancelled") return "You withdrew this request";
  if (progress.outcome === "granted" || progress.outcome === "partially_granted") {
    if (phase === "reading") return `Reading what ${name} shared…`;
    if (phase === "answered") return "One answered with what was shared";
    return progress.outcome === "partially_granted"
      ? `${name} shared some of what you asked`
      : `${name} shared ${joinLabels(shared)}`;
  }
  // The quiet timestamp beside the headline is the seen time: "Kushal saw it 2:14 PM".
  if (progress.seenAt) return `${name} saw it`;
  if (progress.deliveredAt) return `Delivered to ${name}`;
  return `On its way to ${name}`;
}

/** The moment behind the headline, for a quiet timestamp. */
export function progressMoment(progress: RequestProgress): string | null {
  return progress.endedAt ?? progress.decidedAt ?? progress.seenAt ?? progress.deliveredAt ?? progress.requestedAt;
}
