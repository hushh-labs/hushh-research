/**
 * Where the owner sits in a Circle's roster: first, always, in every kind of
 * Circle.
 *
 * Reported from phone QA on a Trusted Circle showing "Ankit Kumar Singh /
 * JHUMMA KUMARI (You · Owner) / Neelesh Meena" -- "owner hamesha sabse upar hi
 * rahega, sabhi kind ke circles ke liye". Nothing was mis-sorted: the roster
 * is ordered A-Z by `sortPeopleByName`, and J falls between A and N. But A-Z
 * is the right rule for a list of PEERS, and a Circle's roster is not one. The
 * owner is the only row whose position carries information -- they are who the
 * Circle belongs to, who can rename it, who can remove anyone -- and burying
 * that under the alphabet makes the reader scan for it once per Circle.
 *
 * This is a STABLE PARTITION, not a second sort key. Everyone who is not the
 * owner keeps exactly the order they arrived in, so:
 *
 *   - the A-Z roster stays A-Z beneath the owner;
 *   - a PAGED roster keeps the server's order beneath the owner, rather than
 *     having a client-side alphabet fight the page boundaries.
 *
 * Applied to the list about to be RENDERED rather than to the source, so the
 * owner leads whatever that list turned out to be. It can only hoist a row
 * that is in the list: on a paged roster whose first page has not reached the
 * owner yet there is nothing here to move, which is correct -- this orders a
 * roster, it does not fetch one.
 *
 * The caller stops applying it once a search query is typed, and that is
 * deliberate: both search paths rank a name that BEGINS with the query above
 * one that merely contains it, and hoisting the owner through that ranking
 * would answer a typed question with the wrong person. A roster has no
 * question to answer, which is why the owner leads it.
 */

import type { OneLocationCircleRole } from "@/lib/one-location/types";

/**
 * Return `members` with the owner (or owners, defensively -- the API models
 * one, and a partition costs nothing to make total) moved to the front,
 * everything else untouched.
 */
export function sortCircleMembersOwnerFirst<
  T extends { role: OneLocationCircleRole },
>(members: readonly T[]): T[] {
  const owners: T[] = [];
  const rest: T[] = [];

  for (const member of members) {
    if (member.role === "owner") owners.push(member);
    else rest.push(member);
  }

  // Nothing to hoist: hand back the same order rather than a rebuilt copy in
  // the same order, so the common case cannot be a source of churn.
  if (!owners.length) return [...members];
  return [...owners, ...rest];
}
