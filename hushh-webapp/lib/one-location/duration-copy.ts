import type { OneLocationAccessRequest } from "@/lib/one-location/types";

/**
 * One place that says how much location time is involved.
 *
 * A single extra-time ask has to be legible on five surfaces: the owner's push
 * notification, the owner's approvals card and Approve button, the requester's
 * own row in the people list, the feed, and the Consent Manager. When each one
 * worded the amount itself, the amount stopped being a fact and became five
 * opinions — which is how "Requesting more time." ended up as the ONLY trace,
 * anywhere, of a request for three specific hours.
 *
 * Everything here is pure. No clock is read: callers pass `nowMs` so a list can
 * tick on one timer and every row in it agrees on what time it is.
 */

/** "45 min", "1 hour", "3 hours", "1 hour 30 min". "" when not a real amount. */
export function formatLocationDurationLabel(
  durationHours: number | string | null | undefined,
): string {
  const hours = Number(durationHours);
  if (!Number.isFinite(hours) || hours <= 0) return "";
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourLabel = wholeHours === 1 ? "1 hour" : `${wholeHours} hours`;
  return minutes ? `${hourLabel} ${minutes} min` : hourLabel;
}

/**
 * "45 more min", "1h 30m more", "3 more hours" — what is actually left.
 *
 * Truthful over tidy. The previous rounding turned 90 minutes into "2 more
 * hours", so a share said it had more time left than it did; a countdown that
 * overstates itself is worse than no countdown, because it is the number people
 * decide when to leave on.
 */
export function formatLocationRemaining(
  untilMs: number,
  nowMs: number,
): string | null {
  const remainingMs = untilMs - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} more min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes) return `${hours}h ${minutes}m more`;
  return hours === 1 ? "1 more hour" : `${hours} more hours`;
}

/** Milliseconds for an ISO timestamp, or null when missing/unparseable. */
export function locationTimestampMs(
  value: string | null | undefined,
): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type LocationAskFacts = {
  /** True when this asks to lengthen a share that is already running. */
  isExtension: boolean;
  /** "3 hours", "as long as they need", or "" when no amount was named. */
  amountLabel: string;
  /** "45 more min" left on the share being extended, when known. */
  remainingLabel: string;
};

export function locationAskFacts(
  request: Pick<
    OneLocationAccessRequest,
    | "requestedDurationHours"
    | "requestedDurationMode"
    | "extendsGrantId"
    | "isExtension"
    | "extendsGrantExpiresAt"
  >,
  nowMs: number,
): LocationAskFacts {
  const untilStopped = request.requestedDurationMode === "until_stopped";
  const expiresAtMs = locationTimestampMs(request.extendsGrantExpiresAt);
  return {
    isExtension: Boolean(request.isExtension || request.extendsGrantId),
    amountLabel: untilStopped
      ? "as long as they need"
      : formatLocationDurationLabel(request.requestedDurationHours),
    remainingLabel:
      expiresAtMs === null
        ? ""
        : (formatLocationRemaining(expiresAtMs, nowMs) ?? ""),
  };
}

/**
 * The owner-facing sentence: what this person is asking of you, right now.
 *
 * Deliberately different wording for the two questions. "3 hours more" and "for
 * 3 hours" are not the same ask, and an owner glancing at a lock screen has to
 * be able to tell them apart without opening anything.
 */
export function describeLocationAsk(
  facts: LocationAskFacts,
  options: { subjectless?: boolean } = {},
): string {
  const { isExtension, amountLabel, remainingLabel } = facts;
  if (isExtension) {
    if (!amountLabel) {
      return options.subjectless
        ? "Asked for more time"
        : "is asking for more time on your live location.";
    }
    if (options.subjectless) {
      return remainingLabel
        ? `Asked for ${amountLabel} more (${remainingLabel} left)`
        : `Asked for ${amountLabel} more`;
    }
    const tail = remainingLabel ? ` They have ${remainingLabel} left.` : "";
    return `is asking for ${amountLabel} more of your live location.${tail}`;
  }
  if (!amountLabel) {
    return options.subjectless
      ? "Asked to see your location"
      : "is asking to view your location.";
  }
  return options.subjectless
    ? `Asked to see your location for ${amountLabel}`
    : `is asking to view your location for ${amountLabel}.`;
}

/** The short line under a name on the owner's approvals card. */
export function locationAskPromptLine(
  request: OneLocationAccessRequest,
  nowMs: number,
): string {
  const facts = locationAskFacts(request, nowMs);
  if (facts.isExtension) {
    if (!facts.amountLabel) return "Asks for more time on your live location";
    return facts.remainingLabel
      ? `Asks for ${facts.amountLabel} more · ${facts.remainingLabel} left`
      : `Asks for ${facts.amountLabel} more of your live location`;
  }
  return facts.amountLabel
    ? `Asks to see your location for ${facts.amountLabel}`
    : "Asks to see your location";
}

/**
 * What the Approve button should say, so the owner presses a number rather than
 * a word and then finds out afterwards what they agreed to.
 */
export function locationApproveActionLabel(
  request: OneLocationAccessRequest,
  nowMs: number,
): string {
  const { amountLabel, isExtension } = locationAskFacts(request, nowMs);
  if (!amountLabel) return "Approve";
  if (request.requestedDurationMode === "until_stopped") {
    return "Approve until you stop";
  }
  return isExtension ? `Approve ${amountLabel} more` : `Approve ${amountLabel}`;
}

/**
 * The picker options for amending a request's duration at approval time:
 * the standard presets plus the exact amount asked for, so the picker can
 * open showing the true current selection instead of silently snapping to
 * whichever preset happens to be closest and disagreeing with the Approve
 * button's own number one line below it. `null` for an open-ended
 * ("until I stop") ask, which this picker does not offer a timed override
 * for.
 */
export function approvalDurationOptions(
  request: Pick<OneLocationAccessRequest, "requestedDurationHours" | "requestedDurationMode">,
  presets: { value: string; label: string }[],
): { value: string; label: string }[] | null {
  if (request.requestedDurationMode === "until_stopped") return null;
  const hours = Number(request.requestedDurationHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (presets.some((option) => Number(option.value) === hours)) return presets;
  const label = formatLocationDurationLabel(hours);
  if (!label) return presets;
  return [...presets, { value: String(hours), label }].sort(
    (a, b) => Number(a.value) - Number(b.value),
  );
}
