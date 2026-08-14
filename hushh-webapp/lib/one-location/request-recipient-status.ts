import type {
  OneLocationAccessRequest,
  OneLocationGrant,
} from "@/lib/one-location/types";

/**
 * What one person's row in the "ask someone to share" list should say.
 *
 * The list used to say "Ready for private sharing" under every name, with
 * Select as the only affordance, whoever they were and whatever had already
 * happened with them. So "what is active status?" had no answer -- nothing
 * computed one -- and somebody who had just asked Roopmann for an hour came
 * back to a row that offered to ask again, exactly as if they never had.
 *
 * Every input here is already in the Location view model. This decides what to
 * say about it, and nothing else: no fetching, no time formatting, no copy that
 * depends on a locale.
 */
export type RequestRecipientStatus = {
  /** The line under the name. */
  subtitle: string;
  tone: "ready" | "pending" | "neutral";
  /** Short pill, when the row is in a state worth naming at a glance. */
  statusLabel?: string;
  /**
   * False when asking again would do nothing. A person already sharing with
   * you, or already holding your unanswered request, is not a person to ask.
   */
  selectable: boolean;
};

/** Milliseconds, or null when the timestamp is missing or unparseable. */
function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * "just now", "6m", "3h", "2d" -- said the way a person would.
 *
 * Deliberately coarse. A request sent four minutes ago and one sent five are
 * the same fact to the person reading it, and a ticking seconds counter in a
 * list of people is noise pretending to be precision.
 */
export function shortAgo(fromMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - fromMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "for 55 more minutes", "for 3 more hours" -- how much access is left. */
export function shortRemaining(untilMs: number, nowMs: number): string | null {
  const remaining = untilMs - nowMs;
  if (remaining <= 0) return null;
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes} more min`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 more hour" : `${hours} more hours`;
}

export function requestRecipientStatus(input: {
  recipientUserId: string;
  /** Requests THIS person sent, i.e. outgoing. */
  requestedByMe: readonly OneLocationAccessRequest[];
  /** Grants shared WITH this person, i.e. incoming. */
  receivedGrants: readonly OneLocationGrant[];
  nowMs: number;
}): RequestRecipientStatus {
  const { recipientUserId, requestedByMe, receivedGrants, nowMs } = input;

  // Already sharing beats everything else. Asking somebody to share when they
  // already are is the clearest possible sign the list is not looking.
  const activeGrant = receivedGrants.find(
    (grant) =>
      grant.ownerUserId === recipientUserId && grant.status === "active",
  );
  if (activeGrant) {
    const expiresAt = timestamp(activeGrant.expiresAt);
    const remaining = expiresAt === null ? null : shortRemaining(expiresAt, nowMs);
    return {
      subtitle: remaining
        ? `Sharing with you, ${remaining}`
        : "Sharing with you now",
      tone: "ready",
      statusLabel: "Live",
      selectable: false,
    };
  }

  // The unanswered ask. This is the row the report was about: it has to say
  // that it happened and when, and it must not offer to do it again.
  const pending = requestedByMe
    .filter(
      (request) =>
        request.ownerUserId === recipientUserId && request.status === "pending",
    )
    .sort(
      (left, right) =>
        (timestamp(right.requestedAt) ?? 0) - (timestamp(left.requestedAt) ?? 0),
    )[0];
  if (pending) {
    const askedAt = timestamp(pending.requestedAt);
    return {
      subtitle: askedAt
        ? `Asked ${shortAgo(askedAt, nowMs)}, waiting on them`
        : "Asked already, waiting on them",
      tone: "pending",
      statusLabel: "Asked",
      // Nothing here can move this along -- it is the other person's to answer.
      selectable: false,
    };
  }

  // A refusal is not a permanent state, so this row stays askable. It is said
  // plainly rather than hidden: asking again without knowing they declined is
  // how somebody ends up nagging without meaning to.
  const declined = requestedByMe
    .filter(
      (request) =>
        request.ownerUserId === recipientUserId &&
        (request.status === "denied" || request.status === "cancelled"),
    )
    .sort(
      (left, right) =>
        (timestamp(right.resolvedAt) ?? 0) - (timestamp(left.resolvedAt) ?? 0),
    )[0];
  if (declined) {
    const resolvedAt = timestamp(declined.resolvedAt);
    const wasDenied = declined.status === "denied";
    return {
      subtitle: resolvedAt
        ? `${wasDenied ? "Declined" : "Cancelled"} ${shortAgo(resolvedAt, nowMs)}`
        : wasDenied
          ? "Declined earlier"
          : "Cancelled earlier",
      tone: "neutral",
      selectable: true,
    };
  }

  return {
    subtitle: "Ready for private sharing",
    tone: "ready",
    selectable: true,
  };
}
