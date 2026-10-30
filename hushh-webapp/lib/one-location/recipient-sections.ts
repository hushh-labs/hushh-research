import type {
  OneLocationAccessRequest,
  OneLocationGrant,
  OneLocationRecipient,
} from "@/lib/one-location/types";

/**
 * How a roster of people is arranged once it stops being short.
 *
 * Kept out of the component for the same reason `contact-picker-controls`
 * is: the rules below are decisions, and a decision that lives inside JSX
 * cannot be reasoned about or tested on its own.
 *
 * Two of these rules were product questions rather than engineering ones, and
 * the answers are recorded here so the next reader does not have to re-derive
 * them from the code.
 */

/** One labelled run of people. A section with no title is the whole roster,
 *  unarranged -- what a search result is. */
export type RecipientSection = {
  key: string;
  /** Absent while a query is active: see `sectionRecipients`. */
  title?: string;
  recipients: OneLocationRecipient[];
};

/**
 * How many people "Recent" is allowed to hold.
 *
 * Five, because Recent is a shortcut and not a second roster. It also has to
 * stay small for the reason below: a person in Recent is NOT repeated in All,
 * so every name Recent takes is a name the alphabet loses.
 */
export const RECENT_SECTION_LIMIT = 5;

/** Milliseconds, or null when the timestamp is missing or unparseable. */
function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function newer(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * When you last had anything to do with each person, by user id.
 *
 * "Frequently contacted" was the other half of the original request and is
 * deliberately NOT built: nothing in this product counts interactions, so a
 * frequency section could only be invented, and a list that claims to know how
 * often you talk to someone while guessing is worse than one that does not
 * claim it. Recency IS knowable from what the screen already holds --
 *
 *   * a request you sent them (`requestedAt`, falling back to `resolvedAt`),
 *   * a share they gave you (`createdAt` on a received grant),
 *   * a share you gave them (`createdAt` on an owned grant).
 *
 * -- so that is what the section is called and what it means.
 */
export function lastInteractionByUserId(input: {
  requestedByMe: readonly OneLocationAccessRequest[];
  receivedGrants: readonly OneLocationGrant[];
  ownerGrants: readonly OneLocationGrant[];
}): Map<string, number> {
  const byUserId = new Map<string, number>();

  const record = (userId: string | undefined | null, at: number | null) => {
    if (!userId || at === null) return;
    byUserId.set(userId, newer(byUserId.get(userId) ?? null, at) as number);
  };

  for (const request of input.requestedByMe) {
    record(
      request.ownerUserId,
      newer(timestamp(request.requestedAt), timestamp(request.resolvedAt)),
    );
  }
  for (const grant of input.receivedGrants) {
    record(grant.ownerUserId, timestamp(grant.createdAt));
  }
  for (const grant of input.ownerGrants) {
    record(grant.recipientUserId, timestamp(grant.createdAt));
  }

  return byUserId;
}

/**
 * Arrange a roster into the sections a long list needs.
 *
 * **While a query is active there are no sections.** A search returns one run
 * of people ordered by how well they match, and an alphabet laid over that
 * would be describing an arrangement the list does not have -- the caller's
 * order is passed straight through. This is the resolution of "does A-Z
 * survive relevance ranking": it does not, and the honest answer is to stop
 * claiming an arrangement rather than to rank twice.
 *
 * With no query: **Recent** (people you have actually dealt with, newest
 * first, capped) then **All** (everyone else, A-Z).
 *
 * Recent EXCLUDES its people from All rather than repeating them. In a list
 * you read, a duplicate is a convenience; in a list you SELECT from, the same
 * person appearing twice means two rows that must agree about one selection,
 * and the moment they disagree the screen is lying. The cap keeps the cost of
 * that choice small: at most five names are missing from the alphabet, and the
 * search field finds them instantly either way.
 */
export function sectionRecipients(input: {
  recipients: readonly OneLocationRecipient[];
  lastInteraction: Map<string, number>;
  /** Sorts and labels people the same way the screen does. */
  label: (recipient: OneLocationRecipient) => string;
  /** True when the caller's order is a relevance ranking, not an arrangement. */
  querying: boolean;
  recentLimit?: number;
}): RecipientSection[] {
  const { recipients, lastInteraction, label, querying } = input;
  const recentLimit = input.recentLimit ?? RECENT_SECTION_LIMIT;

  if (!recipients.length) return [];

  if (querying) {
    return [{ key: "results", recipients: [...recipients] }];
  }

  const recent = recipients
    .filter((recipient) => lastInteraction.has(recipient.userId))
    .sort(
      (left, right) =>
        (lastInteraction.get(right.userId) ?? 0) -
        (lastInteraction.get(left.userId) ?? 0),
    )
    .slice(0, recentLimit);

  const recentIds = new Set(recent.map((recipient) => recipient.userId));
  const rest = recipients
    .filter((recipient) => !recentIds.has(recipient.userId))
    // `localeCompare` rather than `<`: an accented name sorts next to its
    // unaccented spelling here, which is where a person looks for it.
    .sort((left, right) =>
      label(left).localeCompare(label(right), undefined, {
        sensitivity: "base",
      }),
    );

  const sections: RecipientSection[] = [];
  if (recent.length) {
    sections.push({ key: "recent", title: "Recent", recipients: recent });
  }
  if (rest.length) {
    sections.push({
      key: "all",
      // Only worth naming once there is something above it to tell it apart
      // from. A single unlabelled run is just the roster.
      title: recent.length ? "All" : undefined,
      recipients: rest,
    });
  }
  return sections;
}

/** A section header or one person, in the order they are rendered. Flattened
 *  so the virtualizer windows headers and rows through one list rather than
 *  nesting a scroller per section. */
export type RecipientRow =
  | { kind: "header"; key: string; title: string }
  | { kind: "recipient"; key: string; recipient: OneLocationRecipient };

export function flattenRecipientSections(
  sections: readonly RecipientSection[],
): RecipientRow[] {
  const rows: RecipientRow[] = [];
  for (const section of sections) {
    if (section.title) {
      rows.push({
        kind: "header",
        key: `header:${section.key}`,
        title: section.title,
      });
    }
    for (const recipient of section.recipients) {
      rows.push({
        kind: "recipient",
        key: recipient.userId,
        recipient,
      });
    }
  }
  return rows;
}
