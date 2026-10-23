import type { OneLocationAccessRequest, OneLocationGrant } from "@/lib/one-location/types";
import { isLocationRequestPending } from "@/lib/one-location/request-expiry";

/**
 * A pending location access request is actionable in the viewer's "Needs you"
 * feed only when the viewer OWNS the request (location is being asked for)
 * and did NOT send it themselves. `state.requests` carries BOTH directions, so
 * without this guard a user's own OUTGOING request leaks back onto their feed as
 * an incoming "wants to see your location" card labelled with their own name.
 * Mirrors the `pendingOwnerRequests` predicate in the Location page, plus an
 * explicit sender-≠-recipient check so a self-request never becomes actionable.
 */
export function isIncomingLocationRequestActionable(
  request: OneLocationAccessRequest,
  userId: string,
  nowMs = Date.now(),
): boolean {
  return (
    isLocationRequestPending(request, nowMs) &&
    request.ownerUserId === userId &&
    request.requesterUserId !== userId
  );
}

/**
 * A received share a contact started as an emergency SOS (SMS · Save My Soul)
 * that is still live. These surface as pinned, emergency-styled feed cards so a
 * safety alert is never buried under routine activity. The share point stays
 * end-to-end encrypted; only the emergency intent (`shareKind`) is read here.
 */
export function isActiveSmsEmergencyGrant(grant: OneLocationGrant): boolean {
  // Location projects expiry using server time. A handset clock must never
  // remove a live emergency's map link or make it eligible for Clear.
  return grant.status === "active" && grant.shareKind === "sos";
}

/**
 * Any available SOS grant a contact sent, live or revoked. Unlike
 * `isActiveSmsEmergencyGrant`, this keeps a revoked/expired SOS in Feed
 * as a historical alert instead of silently dropping it the instant
 * the sender cancels — a safety event must stay visible until the recipient
 * explicitly clears it.
 */
export function isSmsEmergencyGrant(grant: OneLocationGrant): boolean {
  return grant.shareKind === "sos";
}
