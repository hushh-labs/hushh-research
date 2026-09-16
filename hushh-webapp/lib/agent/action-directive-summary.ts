/**
 * The one sentence a person reads before confirming what the private agent
 * is about to do on their behalf.
 *
 * Why this exists
 * ---------------
 * The chat surface used to print `action.meaning` from the action gateway,
 * which is the sentence written for the MODEL: it says what the verb is for
 * and which identifiers it takes, and it never mentions who or what a given
 * directive actually concerns. A person tapping "Approve" on "Ask someone for
 * access to their information" is being asked to confirm a category, not a
 * request. Confirmation only means something when the card names the person,
 * the things, and the duration the server resolved for this directive
 * (`_resolved_directive_slots` in action_tools.py), so this module reads those
 * slots and says them back in the person's own words.
 *
 * Every string here is owner-facing. It must never leak an identifier, a
 * slot name, or any of the plumbing words the owner copy rules forbid; the
 * unit test asserts that against every branch.
 */

/**
 * The durations a request can be made for, in the same order the profile page
 * offers them. Deliberately a copy: the page owns its select, this module
 * owns the sentence, and neither should import the other's UI.
 */
export const REQUEST_DURATION_OPTIONS = [
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "1 week" },
  { hours: 720, label: "30 days" },
] as const;

/** The duration a request is made for when nothing else was said. */
export const DEFAULT_REQUEST_DURATION_HOURS = 168;

/** "1 day", "3 days", "1 week", "30 days", or "{n} hours" for anything else. */
export function requestDurationLabel(hours: number): string {
  return (
    REQUEST_DURATION_OPTIONS.find((option) => option.hours === hours)?.label ??
    `${hours} hours`
  );
}

/**
 * Join a list of labels the way a person would say them: "a", "a and b",
 * "a, b and c". An empty or malformed list reads as "what you asked for" so a
 * sentence built around it still parses.
 */
export function names(labels: unknown): string {
  const list = Array.isArray(labels)
    ? labels.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  if (!list.length) return "what you asked for";
  if (list.length === 1) return list[0]!;
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function durationHoursFrom(value: unknown): number {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_REQUEST_DURATION_HOURS;
  return Math.round(hours);
}

/**
 * A label sits mid-sentence in the default branch ("One is ready to {label}"),
 * so a leading capital reads as a typo. Only the first letter moves, and only
 * when the next one is lower case, so an acronym keeps its shape.
 */
function midSentence(label: string): string {
  if (label.length < 2) return label;
  const second = label[1]!;
  if (second !== second.toLowerCase()) return label;
  return `${label[0]!.toLowerCase()}${label.slice(1)}`;
}

export type DescribeDirectiveOptions = {
  /**
   * Whether this directive waits for the owner's confirmation before it runs.
   * Only then may the sentence promise that nothing runs first: most gateway
   * actions run directly, and the same sentence lands on the activity panel
   * while they do.
   */
  requiresConfirmation?: boolean;
};

/**
 * The owner-facing sentence for a parked or staged action directive.
 *
 * `slots` are the server-resolved slots that arrived with the directive. The
 * consent branches read them by the names `_resolved_directive_slots` writes;
 * anything else falls to a neutral sentence built from the action's label.
 */
export function describeDirectiveForOwner(
  actionId: string | null | undefined,
  label: string,
  slots: Record<string, unknown> | null | undefined,
  options?: DescribeDirectiveOptions,
): string {
  const resolved = slots && typeof slots === "object" ? slots : {};
  const cleanLabel = label.trim() || "continue";

  switch (actionId) {
    case "consent.request": {
      const who = text(resolved.displayName);
      const what = names(resolved.labels);
      const nothingNamed = what === names([]);
      // The slots resolve on the server after the proposal is looked up, so a
      // start-phase event and a frontend-staged directive carry none of them.
      // Naming a recipient or a duration then would assert what is not known.
      if (!who && nothingNamed) {
        return "Send the information request One set up.";
      }
      const duration = requestDurationLabel(durationHoursFrom(resolved.durationHours));
      // With nothing named the fallback already ends in "for", so a comma
      // keeps the two "for"s from colliding.
      const joiner = nothingNamed ? ", for" : " for";
      return `Ask ${who || "them"} for ${what}${joiner} ${duration}.`;
    }
    case "consent.deny":
      return "Decline this request.";
    case "consent.revoke": {
      const holder = text(resolved.holderLabel);
      const what = text(resolved.label) || "this information";
      return holder ? `End ${holder}'s access to ${what}.` : `End access to ${what}.`;
    }
    case "consent.cancel_request": {
      const who = text(resolved.displayName);
      return who ? `Withdraw your request to ${who}.` : "Withdraw your request.";
    }
    default: {
      const ready = `One is ready to ${midSentence(cleanLabel)}.`;
      return options?.requiresConfirmation === true
        ? `${ready} Nothing runs until you confirm.`
        : ready;
    }
  }
}
