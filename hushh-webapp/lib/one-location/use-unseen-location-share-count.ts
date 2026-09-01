"use client";

import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { OneLocationService } from "@/lib/one-location/service";
import {
  isLocationRequestPending,
  locationRequestExpiryMs,
} from "@/lib/one-location/request-expiry";
import {
  isOneLocationGrantOpened,
  ONE_LOCATION_GRANT_OPENED_EVENT,
  ONE_LOCATION_GRANT_UNWATCHED_EVENT,
} from "@/lib/one-location/notifications";

type LocationNotificationState = {
  /** Active grants shared with me (plain shares AND quick actions: SOS,
   *  check-in, drive-to, pick-me-up, safe-arrival — each is a received grant). */
  receivedGrantIds: string[];
  /** Pending access requests where someone is asking to see MY location. */
  pendingIncomingRequests: number;
  /** Nearest explicit deadline, used to retire the badge without polling. */
  nextPendingRequestExpiryAtMs: number | null;
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * App-wide count of location notifications needing your attention, powering the
 * badge on the Location nav item so they surface wherever you are (like other
 * notifications), not only when you open the Location tab. Covers:
 *   - shares someone gave you, including quick actions (SOS / check-in / drive-to
 *     / pick-me-up / safe-arrival) — each is an active received grant; and
 *   - incoming access requests (someone asking to see your location).
 *
 * A received grant clears from the count once you open/view it ("opened" state is
 * client-side via markOneLocationGrantOpened). An access request clears once it
 * leaves "pending" (you approve/deny it) — mirroring how consent requests behave.
 *
 * Data comes from the same `/api/one/location/state` the Location tab uses,
 * cached + shared via useStaleResource so this adds no polling.
 */
export function useUnseenLocationShareCount(): number {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  // Bumped on grant open/unwatch and on location notification events so the
  // active-grant list re-fetches and the unopened filter re-runs immediately.
  const [tick, setTick] = useState(0);

  const uid = user?.uid ?? null;
  const enabled = Boolean(uid && isVaultUnlocked);
  const cacheKey = uid
    ? `one_location_received_active:${uid}`
    : "one_location_received_active:guest";

  const resource = useStaleResource<LocationNotificationState>({
    cacheKey,
    refreshKey: `${uid ?? "guest"}:${isVaultUnlocked ? "unlocked" : "locked"}:${tick}`,
    enabled,
    load: async () => {
      const token = getVaultOwnerToken();
      if (!token) throw new Error("LOCATION_STATE_VAULT_LOCKED");
      const state = await OneLocationService.getState(token);
      const receivedGrantIds = (state.receivedGrants ?? [])
        .filter((grant) => grant.status === "active")
        .map((grant) => grant.id);
      const requestNowMs = Date.now();
      const pendingIncoming = (state.requests ?? []).filter(
        (request) =>
          request.ownerUserId === uid &&
          isLocationRequestPending(request, requestNowMs),
      );
      const nextPendingRequestExpiryAtMs = pendingIncoming.reduce<
        number | null
      >((nearest, request) => {
        const expiresAt = locationRequestExpiryMs(request);
        if (expiresAt === null || expiresAt <= requestNowMs) return nearest;
        return nearest === null ? expiresAt : Math.min(nearest, expiresAt);
      }, null);
      return {
        receivedGrantIds,
        pendingIncomingRequests: pendingIncoming.length,
        nextPendingRequestExpiryAtMs,
      };
    },
  });

  const nextPendingRequestExpiryAtMs =
    resource.data?.nextPendingRequestExpiryAtMs ?? null;
  useEffect(() => {
    if (nextPendingRequestExpiryAtMs === null) return;
    // One millisecond beyond the inclusive deadline avoids a timer callback
    // racing the same exact clock value that still produced the cached count.
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, nextPendingRequestExpiryAtMs - Date.now() + 1),
    );
    const timeoutId = window.setTimeout(
      () => setTick((value) => value + 1),
      delay,
    );
    return () => window.clearTimeout(timeoutId);
  }, [nextPendingRequestExpiryAtMs]);

  useEffect(() => {
    const bump = () => setTick((value) => value + 1);
    window.addEventListener(ONE_LOCATION_GRANT_OPENED_EVENT, bump);
    window.addEventListener(ONE_LOCATION_GRANT_UNWATCHED_EVENT, bump);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, bump);
    return () => {
      window.removeEventListener(ONE_LOCATION_GRANT_OPENED_EVENT, bump);
      window.removeEventListener(ONE_LOCATION_GRANT_UNWATCHED_EVENT, bump);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, bump);
    };
  }, []);

  const activeGrantIds = useMemo(
    () => resource.data?.receivedGrantIds ?? [],
    [resource.data],
  );
  const pendingIncomingRequests = resource.data?.pendingIncomingRequests ?? 0;

  return useMemo(() => {
    if (!uid) return 0;
    const unopenedShares = activeGrantIds.filter(
      (id) => !isOneLocationGrantOpened(uid, id),
    ).length;
    return unopenedShares + pendingIncomingRequests;
    // `tick` re-runs the filter after an open event (localStorage changed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGrantIds, pendingIncomingRequests, uid, tick]);
}
