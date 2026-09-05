/**
 * How many people are in a Circle.
 *
 * The server's `memberCount` counts every active membership, and the owner
 * always holds one of those memberships -- so it already includes them. A
 * previous version of this module subtracted the owner back out for list
 * rows ("N other people") while the Circle's own detail screen kept the raw,
 * inclusive count ("N people") -- the same Circle showing two different
 * numbers one tap apart, which is the kind of disagreement a person notices
 * and cannot explain.
 *
 * One rule, one module: every Circle row shows the same inclusive count
 * Detail does.
 */

/** Everyone in the Circle, owner included. `Math.max` guards a transient 0. */
export function circleTotalMemberCount(memberCount: number | null | undefined): number {
  return Math.max(0, Number(memberCount || 0));
}

/**
 * "2 members" — the list-row wording.
 *
 * Lists say members; a Circle's own detail screen says people. Both count the
 * same set, and the difference is only register: a list is a directory of
 * groups, a detail screen is about the people in one.
 */
export function circleMemberCountLabel(
  memberCount: number | null | undefined,
): string {
  const count = circleTotalMemberCount(memberCount);
  return `${count} ${count === 1 ? "member" : "members"}`;
}

/** "2 people", or "Only you" for a Circle holding just the owner. */
export function circleOthersLabel(
  memberCount: number | null | undefined,
): string {
  return totalCountLabel(circleTotalMemberCount(memberCount));
}

/** Wording for an inclusive Circle member count. */
export function totalCountLabel(count: number): string {
  if (count <= 1) return "Only you";
  return `${count} people`;
}
