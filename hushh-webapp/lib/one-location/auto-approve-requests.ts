import type { OneLocationAccessRequest } from "@/lib/one-location/types";
import type { AutoApproveScope } from "@/lib/one-location/location-control-state";

/**
 * Which pending location requests may be approved without asking.
 *
 * This is the whole consent rule for auto-approve, kept apart from the screen
 * that runs it so it can be read and tested as one thing. Every branch here
 * refuses; the last line is the only one that lets a request through.
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
  /** When auto-approve was switched on, ISO-8601, or null while it is off. */
  enabledAt: string | null;
  /** Required scope. Missing or unreadable scopes fail closed. */
  scope: AutoApproveScope | null;
  /**
   * Circle membership is authoritative outside this selector. If the caller
   * cannot prove a requester is in the selected Circle, the request is refused.
   */
  isRequesterInScope?: (
    request: OneLocationAccessRequest,
    scope: AutoApproveScope,
  ) => boolean;
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
    isRequesterInScope,
    paused,
    alreadyAttemptedIds,
  } = input;

  if (!enabled || paused || !scope) return [];

  const enabledAtMs = Date.parse(enabledAt ?? "");
  // No readable watermark means nothing can be shown to have arrived after the
  // setting was switched on, so nothing qualifies. Failing closed here is the
  // point: a missing timestamp must not read as "approve everything".
  if (!Number.isFinite(enabledAtMs)) return [];

  return pendingRequests.filter((request) => {
    if (request.status !== "pending") return false;
    if (alreadyAttemptedIds.has(request.id)) return false;
    const requestedAtMs = Date.parse(request.requestedAt ?? "");
    if (!Number.isFinite(requestedAtMs)) return false;
    if (requestedAtMs <= enabledAtMs) return false;
    if (scope.kind === "all_contacts") return true;
    return Boolean(isRequesterInScope?.(request, scope));
  });
}
