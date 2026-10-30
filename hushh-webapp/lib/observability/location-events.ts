"use client";

import { trackEvent } from "@/lib/observability/client";
import {
  trackLocationActivationCompleted,
  trackLocationFunnelStepCompleted,
} from "@/lib/observability/growth";
import type { EventPayloadFor } from "@/lib/observability/events";
import type {
  EventResult,
  OneLocationJourneyAction,
  OneLocationJourneyEntrySurface,
  OneLocationJourneyTarget,
} from "@/lib/observability/events";
import { resolveRouteId, type RouteId } from "@/lib/observability/route-map";

export function oneLocationCountBucket(count: number): string {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 3) return "2_3";
  if (count <= 10) return "4_10";
  return "10_plus";
}

function currentRouteId(): RouteId {
  if (typeof window === "undefined") return "unknown";
  return resolveRouteId(window.location.pathname);
}

function entrySurfaceForRoute(routeId: RouteId): OneLocationJourneyEntrySurface {
  if (routeId === "one_location" || routeId === "one_location_map" || routeId === "one_location_check_in") {
    return "location_hub";
  }
  if (routeId === "connect") return "connect_people";
  if (routeId === "one_location_public_request") return "public_link";
  if (routeId === "consents") return "consent_center";
  if (routeId === "chat") return "agent";
  if (routeId === "profile" || routeId.startsWith("profile_")) return "profile";
  return "unknown";
}

/**
 * Shared metadata-only event for One Location's cross mutating and navigation
 * actions. Callers pass only enums and buckets; the schema rejects IDs, names,
 * phone numbers, coordinates, codes and user-authored text.
 */
export function trackOneLocationJourneyAction({
  action,
  result = "success",
  routeId = currentRouteId(),
  entrySurface,
  targetType = "none",
  circleKind,
  countBucket,
}: {
  action: OneLocationJourneyAction;
  result?: EventResult;
  routeId?: RouteId;
  entrySurface?: OneLocationJourneyEntrySurface;
  targetType?: OneLocationJourneyTarget;
  circleKind?: string;
  countBucket?: string;
}): void {
  try {
    trackEvent("one_location_journey_action", {
      route_id: routeId,
      action,
      result,
      entry_surface: entrySurface ?? entrySurfaceForRoute(routeId),
      target_type: targetType,
      ...(circleKind ? { circle_kind: circleKind } : {}),
      ...(countBucket ? { count_bucket: countBucket } : {}),
    });
  } catch {
    // Telemetry is best-effort. A blocked or failing analytics transport must
    // never interrupt the Location action the person actually requested.
  }
}

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
  trackOneLocationJourneyAction({
    action: "location_share_viewed",
    targetType: "person",
  });
  trackLocationActivationCompleted({ activationPath: "share_received" });
}

/** Count only a confirmed end of an active Nearby check-in, never a no-op. */
export function trackNearbyCheckOutCompleted(): void {
  try {
    trackEvent("one_location_check_out_completed", {
      route_id: "one_location_check_in",
      result: "success",
    });
  } catch {
    // Analytics must not turn a successful privacy action into a failed one.
  }
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
