"use client";

import { trackEvent } from "@/lib/observability/client";
import {
  trackLocationActivationCompleted,
  trackLocationFunnelStepCompleted,
} from "@/lib/observability/growth";
import type { EventPayloadFor } from "@/lib/observability/events";

/**
 * Buckets a recipient count. Raw counts are fine for a feature event but the
 * activation event is a key event fanned out to BigQuery and Looker, so it gets
 * a low-cardinality dimension instead.
 */
function recipientCountBucket(count: number): string {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 3) return "2_3";
  if (count <= 10) return "4_10";
  return "10_plus";
}

/**
 * Records a confirmed share and, when at least one recipient actually received
 * it, the user's One Location activation.
 *
 * Both live here rather than at the call sites because a share is confirmed
 * from several places (the share composer, its failure path, and Check-In), and
 * activation must fire from all of them or the north-star metric silently
 * undercounts whichever path was missed. `trackLocationActivationCompleted`
 * claims once per user, so calling it on every successful share is safe.
 */
export function trackLocationShareConfirmed(
  payload: EventPayloadFor<"one_location_share_confirmed">
): void {
  trackEvent("one_location_share_confirmed", payload);

  if (payload.success_count > 0) {
    trackLocationFunnelStepCompleted("first_share_sent");
    trackLocationActivationCompleted({
      activationPath: "share_sent",
      recipientCountBucket: recipientCountBucket(payload.success_count),
      shareDurationBucket: payload.duration_bucket,
    });
  }
}

/**
 * Records that the user has successfully viewed someone else's live location.
 * The other half of activation: a person who only ever receives is still an
 * active user of a sharing product.
 */
export function trackLocationShareReceived(): void {
  trackLocationActivationCompleted({ activationPath: "share_received" });
}

/**
 * A rated visit, and the Google hand-off it can lead to.
 *
 * Wrapped here rather than called from the sheet for the same reason share is:
 * the rating step will gain a second entry point the moment "rate a past
 * visit" ships on the history screen, and an event emitted from only one of
 * them undercounts silently.
 */
export function trackVisitRated(
  payload: EventPayloadFor<"one_location_visit_rated">
): void {
  trackEvent("one_location_visit_rated", payload);
}

export function trackReviewHandoffOpened(): void {
  trackEvent("one_location_review_handoff_opened", {
    route_id: "one_location_check_in",
    destination: "google_maps",
  });
}
