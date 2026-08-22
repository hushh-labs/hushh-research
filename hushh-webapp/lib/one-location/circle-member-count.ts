/**
 * How many people are in a Circle, from the reader's point of view.
 *
 * The server's `memberCount` counts every active membership, and the viewer is
 * always one of them on any Circle they can see. So the raw number answers a
 * question nobody asked: "3 members" on a Circle you share with two friends
 * reads as three OTHER people until you work out that one of them is you.
 *
 * Four screens rendered the raw number and three subtracted the viewer, so the
 * same Circle showed "5 members" on the share picker and "4 members" one tap
 * away in its own detail. That is the kind of disagreement a person notices and
 * cannot explain, and it was reported from exactly there.
 *
 * One rule, one module: every Circle row counts OTHERS.
 */

/** Everyone in the Circle except the reader. `Math.max` guards a transient 0. */
export function circleOtherMemberCount(memberCount: number | null | undefined): number {
  return Math.max(0, Number(memberCount || 0) - 1);
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
  const others = circleOtherMemberCount(memberCount);
  return `${others} ${others === 1 ? "member" : "members"}`;
}

/** "2 people", or "No members yet" for a Circle holding only the reader. */
export function circleOthersLabel(
  memberCount: number | null | undefined,
): string {
  return othersCountLabel(circleOtherMemberCount(memberCount));
}

/** Wording for a count that has ALREADY excluded the viewer. */
export function othersCountLabel(others: number): string {
  if (others <= 0) return "No members yet";
  return `${others} ${others === 1 ? "person" : "people"}`;
}
