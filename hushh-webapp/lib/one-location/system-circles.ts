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
