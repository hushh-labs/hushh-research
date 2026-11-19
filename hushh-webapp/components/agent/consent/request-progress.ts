/**
 * The requester's living consent card: the minimal status model.
 *
 * Inputs
 * - `RequestProgress`: parsed from `GET /api/one/information-requests/{bundle_id}`
 *   `.progress` (`requested_at`, `delivered_at`, `decided_at`,
 *   `outcome`, `access_ends_at`, `ended_at`, `fields[]`). Missing or malformed
 *   progress parses to null and the card keeps its fallback behavior.
 * - `RequesterCardPhase`: set by the chat (lane C2) once an answer has
 *   arrived. "reading" while the private agent reads what was shared, "answered"
 *   once the reply has landed.
 *
 * Output: `requestStatusBadgeFor(progress, phase)` returns a single minimal
 * status badge (`Waiting -> Shared / Partly shared / Declined / Expired / Withdrawn / Access ended`),
 * with zero read-receipt surveillance ("Seen" removed).
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
  decidedAt: string | null;
  outcome: RequestOutcome;
  accessEndsAt: string | null;
  endedAt: string | null;
  fields: RequestProgressField[];
};

/** Set by the chat (C2) after an answer arrives; null or undefined otherwise. */
export type RequesterCardPhase = "reading" | "answered";

export type RequestStatusBadge = {
  state: "waiting" | "shared" | "declined" | "expired" | "withdrawn" | "ended";
  label: string;
  pulse: boolean;
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

export function requestStatusBadgeFor(
  progress: RequestProgress,
  phase?: RequesterCardPhase | null,
): RequestStatusBadge {
  if (isAccessEnded(progress)) {
    return { state: "ended", label: "Access ended", pulse: false, tone: "neutral" };
  }
  if (progress.outcome === "pending") {
    return { state: "waiting", label: "Waiting", pulse: true, tone: "positive" };
  }
  if (progress.outcome === "denied") {
    return { state: "declined", label: "Declined", pulse: false, tone: "neutral" };
  }
  if (progress.outcome === "cancelled") {
    return { state: "withdrawn", label: "Withdrawn", pulse: false, tone: "neutral" };
  }
  if (progress.outcome === "expired") {
    return { state: "expired", label: "Expired", pulse: false, tone: "neutral" };
  }
  if (phase === "reading") {
    return { state: "shared", label: "Reading…", pulse: true, tone: "positive" };
  }
  return {
    state: "shared",
    label: progress.outcome === "partially_granted" ? "Partly shared" : "Shared",
    pulse: false,
    tone: "positive",
  };
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
  return `Waiting for ${name}'s approval`;
}

/** The moment behind the headline, for a quiet timestamp. */
export function progressMoment(progress: RequestProgress): string | null {
  return progress.endedAt ?? progress.decidedAt ?? progress.requestedAt;
}
