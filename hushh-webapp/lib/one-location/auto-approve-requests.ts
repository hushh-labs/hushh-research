import type { OneLocationAccessRequest } from "@/lib/one-location/types";
import type { AutoApproveScope } from "@/lib/one-location/location-control-state";
import { isLocationRequestPending } from "@/lib/one-location/request-expiry";

/**
 * Which pending location requests this browser may schedule for server review.
 *
 * This helper is deliberately not consent authority. The server owns the rule,
 * timestamp, relationship/Circle proof, and atomic grant decision. Every
 * browser-side branch here narrows work; the last line only queues a request
 * for that server validation.
 *
 * The rule the owner asked for: turning the setting on speaks for requests
 * that arrive afterwards, and for nothing else. Someone already waiting when
 * it was switched on is out of scope -- flipping a setting is not an answer to
 * a specific person who is already asking, and sweeping them up would approve
 * people the owner may have been deliberately leaving unanswered.
 */
export function selectAutoApprovableRequests(input: {
  pendingRequests: readonly OneLocationAccessRequest[];
  enabled: boolean;
  /** Server activation time, ISO-8601, or null while the rule is off. */
  enabledAt: string | null;
  /** Required rule shape. Exact relationship membership is checked by the server. */
  scope: AutoApproveScope | null;
  /** "Stop sending my location" outranks every convenience. */
  paused: boolean;
  /** Requests this device already put through; never attempted twice. */
  alreadyAttemptedIds: ReadonlySet<string>;
}): OneLocationAccessRequest[] {
  const {
    pendingRequests,
    enabled,
    enabledAt,
    scope,
    paused,
    alreadyAttemptedIds,
  } = input;

  if (!enabled || paused || !scope) return [];

  const enabledAtMs = Date.parse(enabledAt ?? "");
  // No readable watermark means nothing can be shown to have arrived after the
  // setting was switched on, so nothing qualifies. Failing closed here is the
  // point: a missing timestamp must not read as "approve everything".
  if (!Number.isFinite(enabledAtMs)) return [];

  const nowMs = Date.now();
  return pendingRequests.filter((request) => {
    if (!isLocationRequestPending(request, nowMs)) return false;
    if (alreadyAttemptedIds.has(request.id)) return false;
    // A standing people rule does not grant an open-ended duration. Requests
    // for ongoing access stay visible for an explicit owner decision.
    if (request.requestedDurationMode === "until_stopped") return false;
    const requestedAtMs = Date.parse(request.requestedAt ?? "");
    if (!Number.isFinite(requestedAtMs)) return false;
    if (requestedAtMs <= enabledAtMs) return false;
    // This is only a scheduler. The approval mutation locks the server-owned
    // rule and proves exact relationship/Circle membership transactionally.
    return true;
  });
}
