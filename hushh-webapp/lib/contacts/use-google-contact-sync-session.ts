"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { isNative } from "@/lib/capacitor/platform";
import { trackEvent } from "@/lib/observability/client";
import type { RouteId } from "@/lib/observability/route-map";
import {
  syncOneLocationContactSignals,
  type OneLocationContactSignalResult,
} from "@/lib/one-location/contact-signals";
import {
  requestGoogleContactsToken,
  isGoogleContactsConsentCancelled,
} from "./google-contacts-token";
import { googlePeopleContactSource } from "./google-people-source";
import { contactCountBucket } from "./contact-count-bucket";
import { oneLocationErrorMessage } from "@/lib/one-location/error-message";

type SyncOptions = Omit<
  Parameters<typeof syncOneLocationContactSignals>[0],
  "source" | "signal" | "idToken"
> & {
  routeId: RouteId;
  beginInvites?: () => SyncOptions["onInviteCandidates"];
};
type Phase =
  "idle" | "authorizing" | "syncing" | "complete" | "cancelled" | "error";
type Snapshot = {
  phase: Phase;
  result: OneLocationContactSignalResult | null;
  error: string | null;
  open: boolean;
};
const EMPTY: Snapshot = {
  phase: "idle",
  result: null,
  error: null,
  open: false,
};
const EMPTY_COUNTS = {
  contact_count_bucket: contactCountBucket(0),
  matched_count: 0,
  invite_candidate_count: 0,
};

/** Browser-only work survives a temporary auth-gate remount, never an account/route change.
 * This owns no auth authority and never renders protected results above the gate.
 */
export function useGoogleContactSyncSession(
  owner: string | null,
  scope = "local",
) {
  const identity = useRef({ owner, scope });
  const operation = useRef<AbortController | null>(null);
  const previousCounts = useRef(EMPTY_COUNTS);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const clear = useCallback(() => {
    operation.current?.abort();
    operation.current = null;
    previousCounts.current = EMPTY_COUNTS;
    setSnapshot(EMPTY);
  }, []);
  useLayoutEffect(() => {
    identity.current = { owner, scope };
    clear();
    return () => {
      operation.current?.abort();
      operation.current = null;
    };
  }, [owner, scope, clear]);

  const run = useCallback(
    async (options: SyncOptions) => {
      if (
        !owner ||
        isNative() ||
        operation.current ||
        identity.current.owner !== owner ||
        identity.current.scope !== scope
      )
        return null;
      const abort = new AbortController();
      operation.current = abort;
      let authorized = false;
      const current = () =>
        operation.current === abort &&
        !abort.signal.aborted &&
        identity.current.owner === owner &&
        identity.current.scope === scope;
      const assertCurrent = () => {
        if (!current())
          throw new DOMException("Contact sync ended.", "AbortError");
      };
      const guard =
        <T>(resolve: () => T | Promise<T>) =>
        async () => {
          assertCurrent();
          const value = await resolve();
          assertCurrent();
          return value;
        };
      try {
        // Invoke GIS in the original tap, before any await or UI transition.
        const onInviteCandidates =
          options.beginInvites?.() ?? options.onInviteCandidates;
        const pendingToken = requestGoogleContactsToken(abort.signal);
        setSnapshot({
          phase: "authorizing",
          result: null,
          error: null,
          open: true,
        });
        const token = await pendingToken;
        assertCurrent();
        authorized = true;
        setSnapshot({
          phase: "syncing",
          result: null,
          error: null,
          open: true,
        });
        const {
          routeId,
          beginInvites: _beginInvites,
          ...syncOptions
        } = options;
        const result = await syncOneLocationContactSignals({
          ...syncOptions,
          source: googlePeopleContactSource(token, abort.signal),
          signal: abort.signal,
          ...(options.resolveIdToken
            ? { resolveIdToken: guard(options.resolveIdToken) }
            : {}),
          ...(options.resolveAccountPhoneNumber
            ? {
                resolveAccountPhoneNumber: guard(
                  options.resolveAccountPhoneNumber,
                ),
              }
            : {}),
          onInviteCandidates: onInviteCandidates
            ? (candidates) => {
                if (current()) onInviteCandidates(candidates);
              }
            : undefined,
        });
        assertCurrent();
        setSnapshot({ phase: "complete", result, error: null, open: true });
        previousCounts.current = {
          contact_count_bucket: contactCountBucket(result.totalContacts),
          matched_count: result.matchedUserIds.length,
          invite_candidate_count: result.inviteCandidateCount,
        };
        try {
          if (
            result.autoConnectedCount + result.alreadyConnectedCount > 0 ||
            result.mutationOutcomeUnknown
          ) {
            CacheSyncService.onConnectionGraphMutated(owner);
          }
        } catch {
          /* The mounted route separately refreshes the graph with recovery. */
        }
        try {
          trackEvent("one_location_contact_signal_synced", {
            route_id: routeId,
            result: "success",
            source_platform: result.sourcePlatform,
            ...previousCounts.current,
            contact_region: result.region ?? "unknown",
            partial_access: result.limited,
            truncated: result.truncated,
          });
        } catch {
          /* Analytics must not erase a completed sync. */
        }
        return result;
      } catch (error) {
        if (!current()) return null;
        const cancelled =
          !authorized && isGoogleContactsConsentCancelled(error);
        setSnapshot({
          phase: cancelled ? "cancelled" : "error",
          result: null,
          open: true,
          error: cancelled
            ? null
            : oneLocationErrorMessage(
                error,
                "Could not sync Google contacts. Try again.",
              ),
        });
        if (!cancelled) {
          try {
            trackEvent("one_location_contact_signal_synced", {
              route_id: options.routeId,
              result: "error",
              source_platform: "google",
              // A failed read has no new counts; retain only the prior size band/counts.
              ...previousCounts.current,
              failure_reason: "error",
            });
          } catch {
            /* Recovery must remain usable when analytics is unavailable. */
          }
        }
        return null;
      } finally {
        if (operation.current === abort) operation.current = null;
      }
    },
    [owner, scope],
  );

  const valid =
    identity.current.owner === owner && identity.current.scope === scope;
  const state = valid ? snapshot : EMPTY;
  return {
    ...state,
    busy: state.phase === "authorizing" || state.phase === "syncing",
    run,
    clear,
  };
}

export type GoogleContactSyncController = ReturnType<
  typeof useGoogleContactSyncSession
>;
export const GoogleContactSyncSessionContext = createContext<{
  owner: string | null;
  controller: GoogleContactSyncController;
} | null>(null);
export function useGoogleContactSync(userId: string | null | undefined) {
  const session = useContext(GoogleContactSyncSessionContext);
  const local = useGoogleContactSyncSession(session ? null : (userId ?? null));
  return session?.owner === (userId ?? null) ? session.controller : local;
}
