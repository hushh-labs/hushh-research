/**
 * pickup-enroute.ts
 *
 * Pure derivation logic for the "helper is on the way" (en-route) card shown
 * in the Pick Me Up mutual-share flow.
 *
 * Extracted from NowHub so that unit tests can import and exercise the real
 * production logic rather than a local mirror copy.
 */

import type { OneLocationGrant, PlainLocationPoint } from "@/lib/one-location/types";

export type EnRouteHelper = {
  /** Stable key for React list rendering (equals the received grant id). */
  key: string;
  /** Display name of the person coming to pick up the current user. */
  helperName: string;
  /** The helper's latest decrypted location point. */
  point: PlainLocationPoint;
  /** Drive ETA in seconds, or null when no drive payload is present. */
  etaSeconds: number | null;
  /** The current user's outbound pick_me_up grant id — used to cancel. */
  outboundGrantId: string;
};

/**
 * Derives the list of helpers currently en-route to pick up the current user.
 *
 * Matching criteria (both conditions must hold):
 *  1. A received grant with shareKind === "pickup_enroute" that has an
 *     available decrypted location point.
 *  2. An active outbound grant with shareKind === "pick_me_up" whose
 *     recipientUserId matches the received grant's ownerUserId — i.e. the
 *     mutual-share pair is complete.
 *
 * @param params.receivedGrants   Grants the current user has received.
 * @param params.activeOwnerGrants  Outbound grants owned by the current user —
 *   pre-filtered to status === "active" by the view-model before being passed in.
 * @param params.decryptedPoints  Map of grant-id → decrypted location point.
 * @param params.labelFor         Callback that returns the display name for a grant owner.
 */
export function deriveEnRouteHelpers(params: {
  receivedGrants: OneLocationGrant[];
  activeOwnerGrants: OneLocationGrant[];
  decryptedPoints: Record<string, PlainLocationPoint>;
  labelFor: (grant: OneLocationGrant) => string;
}): EnRouteHelper[] {
  const { receivedGrants, activeOwnerGrants, decryptedPoints, labelFor } = params;

  return receivedGrants
    .filter(
      (g) =>
        g.shareKind === "pickup_enroute" &&
        Boolean(decryptedPoints[g.id]),
    )
    .flatMap((receivedGrant) => {
      // activeOwnerGrants is pre-filtered to status === "active" by the vm.
      const outboundGrant = activeOwnerGrants.find(
        (g) =>
          g.shareKind === "pick_me_up" &&
          g.recipientUserId === receivedGrant.ownerUserId,
      );
      if (!outboundGrant) return [];
      const point = decryptedPoints[receivedGrant.id]!;
      return [
        {
          key: receivedGrant.id,
          helperName: labelFor(receivedGrant),
          point,
          etaSeconds: point.drive?.etaSeconds ?? null,
          outboundGrantId: outboundGrant.id,
        },
      ];
    });
}
