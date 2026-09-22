import type { OneLocationCircleSummary } from "@/lib/one-location/types";

/**
 * Resolve the viewer's OWN SMS/Emergency system Circle, never one they were
 * merely added to.
 *
 * A system Circle lists everyone who belongs to it, including on the
 * accounts of people who joined someone else's -- that is how an SMS Circle
 * you were added to shows up in your own Circles list at all. An unfiltered
 * `find` over that list can therefore return a circle you do not own, and
 * the backend orders Circles by recency (`list_circles`), so joining one
 * after your own was provisioned made theirs sort first. Every action that
 * assumed "my system Circle" -- Edit contacts, adding a contact -- then
 * landed on someone else's, where you are not the owner and cannot manage
 * it.
 */
export function resolveOwnSmsSystemCircleId(
  circles: readonly OneLocationCircleSummary[],
): string | null {
  return (
    circles.find((circle) => circle.isSystem && circle.role === "owner")
      ?.id ?? null
  );
}

type SmsCircleIdentity = Pick<
  OneLocationCircleSummary,
  "isSystem" | "role" | "systemKind"
>;

/**
 * Whether this is an SMS/Emergency system Circle on any server generation:
 * `systemKind` where the server sends it, the legacy `isSystem` flag where
 * it does not (Trusted is never flagged, so this cannot match it).
 */
export function isSmsSystemCircle(circle: SmsCircleIdentity): boolean {
  if (circle.systemKind) return circle.systemKind === "sms";
  return circle.isSystem === true;
}

/**
 * Someone else's SMS Circle the viewer was added to. It shows up in the
 * viewer's own Circles list (a system Circle lists everyone on it), but it
 * is not usable on the viewer's side: sharing through it cannot authorize
 * recipients (see `circleCanAuthorizeRecipient`), and managing it lands on a
 * Circle the viewer does not own. Sharing pickers and the People tab hide
 * these; the viewer's own SMS Circle (`role === "owner"`) stays visible and
 * shareable everywhere.
 */
export function isForeignSmsSystemCircle(circle: SmsCircleIdentity): boolean {
  return isSmsSystemCircle(circle) && circle.role !== "owner";
}
