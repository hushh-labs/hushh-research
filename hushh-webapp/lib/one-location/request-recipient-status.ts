import {
  formatLocationDurationLabel,
  formatLocationRemaining,
} from "@/lib/one-location/duration-copy";
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
  /**
   * The unanswered request this row is about, when there is one.
   *
   * A row that is not selectable because somebody is already holding your ask
   * used to be a dead end: nothing to press, and no way to take the ask back.
   * This is what the row needs to offer that.
   */
  pendingRequestId?: string;
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

/**
 * "55 more min", "1h 30m more", "3 more hours" -- how much access is left.
 *
 * Delegates to the shared formatter so this row, the countdown on the share
 * card, and the notification copy cannot drift apart. The old local rounding
 * turned 90 minutes into "2 more hours", which overstated the time left on the
 * exact number people use to decide when to leave.
 */
export function shortRemaining(untilMs: number, nowMs: number): string | null {
  return formatLocationRemaining(untilMs, nowMs);
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

  // The unanswered ask, whatever else is true. Resolved before the active-grant
  // branch because a request for MORE time is made by someone who is already
  // being shared with -- so a row that let "Live" win said "Sharing with you,
  // 59 more min" and nothing else, and the extra time this person had just
  // asked for left no trace anywhere on the screen they asked it from.
  const pending = requestedByMe
    .filter(
      (request) =>
        request.ownerUserId === recipientUserId && request.status === "pending",
    )
    .sort(
      (left, right) =>
        (timestamp(right.requestedAt) ?? 0) - (timestamp(left.requestedAt) ?? 0),
    )[0];

  // Already sharing beats everything else. Asking somebody to share when they
  // already are is the clearest possible sign the list is not looking.
  const activeGrant = receivedGrants.find(
    (grant) =>
      grant.ownerUserId === recipientUserId && grant.status === "active",
  );
  if (activeGrant) {
    const expiresAt = timestamp(activeGrant.expiresAt);
    const remaining = expiresAt === null ? null : shortRemaining(expiresAt, nowMs);
    const live = remaining ? `Sharing with you, ${remaining}` : "Sharing with you now";
    if (pending) {
      // Both facts at once, because both are true and each one alone misleads:
      // the share IS live, and more time HAS been asked for and not answered.
      const askedFor =
        pending.requestedDurationMode === "until_stopped"
          ? "no end time"
          : formatLocationDurationLabel(pending.requestedDurationHours)
            ? `${formatLocationDurationLabel(pending.requestedDurationHours)} more`
            : "";
      return {
        subtitle: askedFor
          ? `${live} · asked for ${askedFor}`
          : `${live} · asked for more time`,
        tone: "pending",
        statusLabel: "Asked",
        // The extra time is the owner's to give. Asking a third time from here
        // would only overwrite the number they are already looking at.
        selectable: false,
      };
    }
    return {
      subtitle: live,
      tone: "ready",
      statusLabel: "Live",
      selectable: false,
    };
  }

  // The unanswered ask with no live share behind it. This is the row the
  // original report was about: it has to say that it happened and when, and it
  // must not offer to do it again.
  if (pending) {
    const askedAt = timestamp(pending.requestedAt);
    // Name the amount. "Asked 17m ago" says a request exists; it does not say
    // what was asked, so the person who picked four hours has no way to check
    // that four hours is what is actually waiting on the other side.
    const askedFor =
      pending.requestedDurationMode === "until_stopped"
        ? "no end time"
        : formatLocationDurationLabel(pending.requestedDurationHours);
    const when = askedAt ? `Asked ${shortAgo(askedAt, nowMs)}` : "Asked already";
    return {
      subtitle: askedFor
        ? `${when} for ${askedFor}, waiting on them`
        : `${when}, waiting on them`,
      tone: "pending",
      statusLabel: "Asked",
      // Nothing here can APPROVE this -- it is the other person's to answer.
      // Taking it back is the asker's own to do, and `pendingRequestId` is
      // what lets the row offer it.
      selectable: false,
      pendingRequestId: pending.id,
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
