"use client";

// Frontend recognizer + presenter for One Location consent entries inside the
// shared consent center (/consents). This mirrors `email-helper-consent.ts`:
// the consent center stays generic over `ConsentCenterEntry`, and an agent
// "plugs in" purely through metadata flags + a small presenter helper.
//
// NOTE: location consent rows only appear in the consent center once the
// backend `ConsentCenterService` unions the `one_location_*` tables into the
// shared read model (tracked as the Phase C backend follow-up). This helper is
// the frontend half of that contract so the UI is ready when rows arrive.

import { buildOneLocationWorkflowHref } from "@/lib/one-location/notifications";

type MetadataLike = Record<string, unknown> | null | undefined;


function readString(metadata: MetadataLike, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A consent entry belongs to One Location when its metadata carries a
 * location request source or a location-family scope.
 */
export function isLocationConsent(
  metadata: MetadataLike,
  scope?: string | null,
): boolean {
  const requestSource = readString(metadata, "request_source");
  if (requestSource.startsWith("one_location")) return true;
  const normalizedScope = String(scope || "").trim().toLowerCase();
  return (
    normalizedScope.startsWith("cap.location.") ||
    normalizedScope.startsWith("attr.location.")
  );
}

/**
 * Deep link back to the One Location surface, optionally focused on the
 * relevant section (mirrors the in-app notification deep links).
 */
export function locationConsentWorkflowHref(metadata: MetadataLike): string {
  const section = readString(metadata, "section");
  const grantId = readString(metadata, "grant_id");
  const requestId = readString(metadata, "request_id");
  // Use the canonical One Location query params (section / grantId / requestId)
  // so the consent-manager deep link drives the exact same tab-switch + scroll
  // behavior as in-app notifications. A "shared" grant link also marks the
  // grant opened so its "Shared with me" map block is revealed on arrival.
  const isSharedGrant = Boolean(grantId) && (!section || section === "shared");
  return buildOneLocationWorkflowHref({
    grantId: grantId || null,
    requestId: requestId || null,
    section:
      (section as
        | "people"
        | "approvals"
        | "shared"
        | "my_requests"
        | "public_responses"
        | "activity"
        | null) || null,
    openGrant: isSharedGrant,
  });
}


/**
 * Human summary for a location consent row. Coordinate-free by contract:
 * we never surface latitude/longitude in consent metadata or copy.
 */
export function locationConsentSummary(metadata: MetadataLike): string {
  const requesterLabel = readString(metadata, "requester_label");
  const durationLabel = readString(metadata, "duration_label");
  const who = requesterLabel || "Someone in your One Network";
  if (durationLabel) {
    return `${who} wants to see your location for ${durationLabel}.`;
  }
  return `${who} wants to see your location through One Location.`;
}
