"use client";

/**
 * Grouping live grants by PERSON, now that a person can hold two of them.
 *
 * Replacement of a live location share is scoped to a lane on the backend, and
 * there are exactly two lanes: the emergency one (`share_kind === "sos"`, what
 * this UI calls SMS / Save My Soul) and everything else. So an owner and a
 * recipient can legitimately have two live grants between them at once -- an
 * ordinary share and an SOS share -- and a great deal of client code was
 * written when "a grant" and "a person" were the same thing.
 *
 * Every surface that lists people has to stop equating the two, and it has to
 * do it the same way, using the same discriminator the server stamps on every
 * grant (`shareKind`, read through {@link isSmsTriggeredGrant}). Hence one
 * grouping function rather than one per screen: the owner's Active shares list,
 * the People directory and the recipient's "Shared with me" column all have to
 * agree on what counts as the same person and which of their shares is which.
 */

import { isSmsTriggeredGrant } from "@/lib/one-location/notifications";
import type { OneLocationGrant } from "@/lib/one-location/types";

export type OneLocationGrantLaneGroup = {
  /** The other person: the recipient of your shares, or the owner of theirs. */
  counterpartUserId: string;
  /**
   * Every live grant with this person, in the order the caller supplied them.
   * At most two after the lane split, but nothing here assumes that.
   */
  grants: OneLocationGrant[];
  /**
   * The grant a surface acts on when it can only show one. First in the
   * caller's order, so an existing sort (received grants already float
   * SMS-triggered shares to the top) keeps deciding what leads.
   */
  primaryGrant: OneLocationGrant;
  /** The live emergency-lane grant with this person, if there is one. */
  smsGrant: OneLocationGrant | null;
  /** The live ordinary-lane grant with this person, if there is one. */
  ordinaryGrant: OneLocationGrant | null;
};

/**
 * Collapse a flat grant list into one entry per person, preserving order.
 *
 * `side` says which end of the grant you are: `"owner"` groups your outgoing
 * shares by who can see you, `"recipient"` groups incoming ones by whose
 * location you can see.
 *
 * A grant whose counterpart id is missing becomes its own group rather than
 * merging into somebody else's -- splitting a row is a cosmetic defect, while
 * merging two people into one row would attach one person's Stop button to
 * another person's share.
 */
export function groupGrantsByCounterpart(
  grants: OneLocationGrant[],
  side: "owner" | "recipient",
): OneLocationGrantLaneGroup[] {
  const order: string[] = [];
  const byCounterpart = new Map<string, OneLocationGrant[]>();

  grants.forEach((grant, index) => {
    const counterpartUserId =
      (side === "owner" ? grant.recipientUserId : grant.ownerUserId) ||
      `grant:${grant.id || index}`;
    const existing = byCounterpart.get(counterpartUserId);
    if (existing) {
      existing.push(grant);
      return;
    }
    order.push(counterpartUserId);
    byCounterpart.set(counterpartUserId, [grant]);
  });

  return order.map((counterpartUserId) => {
    const groupGrants = byCounterpart.get(counterpartUserId) ?? [];
    return {
      counterpartUserId,
      grants: groupGrants,
      // Non-null by construction: a key only exists because a grant created it.
      primaryGrant: groupGrants[0] as OneLocationGrant,
      smsGrant: groupGrants.find((grant) => isSmsTriggeredGrant(grant)) ?? null,
      ordinaryGrant:
        groupGrants.find((grant) => !isSmsTriggeredGrant(grant)) ?? null,
    };
  });
}

/**
 * How to label one share inside a per-person row.
 *
 * Keeps the lane name aligned to the product-facing action. The server keeps
 * the internal `sos` identifier; the UI says Save My Soul.
 */
export function grantLaneLabel(grant: OneLocationGrant): string {
  return isSmsTriggeredGrant(grant) ? "Save My Soul" : "Location share";
}
