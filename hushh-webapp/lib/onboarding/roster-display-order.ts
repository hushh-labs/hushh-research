/** Shared display order for the One dashboard and its onboarding preview. */
const ROSTER_DISPLAY_ORDER: readonly string[] = [
  "location",
  "gmail",
  "calendar",
  "finance",
  "ria",
  "wallet",
  "consent",
  "pkm",
  "files",
  "messages",
];

export function compareOneRosterDisplayOrder(
  left: { id: string },
  right: { id: string },
): number {
  const rank = (id: string) => {
    const index = ROSTER_DISPLAY_ORDER.indexOf(id);
    return index < 0 ? ROSTER_DISPLAY_ORDER.length : index;
  };
  return rank(left.id) - rank(right.id);
}
