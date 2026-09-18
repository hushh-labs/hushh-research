"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
} from "@/lib/consent/consent-events";
import { usePersonaState } from "@/lib/persona/persona-context";
import {
  ConsentCenterService,
  type ConsentCenterActor,
  type ConsentCenterPageSummary,
} from "@/lib/services/consent-center-service";
import { CACHE_KEYS } from "@/lib/services/cache-service";

/**
 * Returns `null` until the current persona's summary has resolved. Consumers
 * must treat that as an unknown count, never as zero: zero is a meaningful
 * statement that there are no pending requests.
 */
export function useConsentPendingSummaryCount(
  options?: { enabled?: boolean },
): number | null {
  const { user } = useAuth();
  const pathname = usePathname();
  const { activePersona } = usePersonaState();
  const actor: ConsentCenterActor | undefined =
    pathname?.startsWith("/ria") && activePersona === "ria" ? "ria" : undefined;
  const mode = "consents";
  const [mutationTick, setMutationTick] = useState(0);
  const scope = actor === "ria" ? "ria" : "one";
  const cacheKey = user?.uid
    ? CACHE_KEYS.CONSENT_CENTER_SUMMARY(user.uid, `${scope}:${mode}`)
    : "consent_center_summary_guest";
  const [retainedSummary, setRetainedSummary] = useState<{
    key: string;
    data: ConsentCenterPageSummary;
  } | null>(null);

  useEffect(() => {
    const handleMutation = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail || {};
      const source = String(detail.source || "").trim();
      if (source === "cached_pending" || source === "queued_pending") {
        return;
      }
      setMutationTick((value) => value + 1);
    };
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleMutation);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, handleMutation);
    return () => {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleMutation);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, handleMutation);
    };
  }, []);

  const summaryResource = useStaleResource({
    cacheKey,
    refreshKey: `${scope}:${mode}:${mutationTick}`,
    // A NAV BADGE MUST NOT RACE THE SETUP GATE.
    //
    // This call is chrome for a nav that is already hidden on every setup
    // surface, and it was measured at 125,614 ms on a brand-new person's first
    // paint -- because `useSessionChromeSuppression` hides the chrome with a DOM
    // attribute while every component under it stays mounted and every fetch
    // still fires. Hidden was doing no work; only stopping the fetch does.
    enabled: Boolean(user?.uid) && (options?.enabled ?? true),
    load: async () => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) {
        throw new Error("Sign in to review consents");
      }
      return ConsentCenterService.getSummary({
        idToken,
        userId: user.uid,
        actor,
        mode,
        force: mutationTick > 0,
      });
    },
  });

  useEffect(() => {
    if (summaryResource.data) {
      setRetainedSummary({ key: cacheKey, data: summaryResource.data });
    }
  }, [cacheKey, summaryResource.data]);

  const summaryData =
    summaryResource.data ??
    (retainedSummary?.key === cacheKey ? retainedSummary.data : null);

  // `counts` is optional-chained too: a partial/error payload from the summary
  // endpoint would otherwise throw here, and this hook runs in the Navbar --
  // inside the root shell -- so that throw takes down the entire app rather
  // than just hiding a pending-consent badge.
  return summaryData?.counts?.pending ?? null;
}
