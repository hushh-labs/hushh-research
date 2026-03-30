"use client";

import { useEffect, useState } from "react";

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

export function useConsentPendingSummaryCount() {
  const { user } = useAuth();
  const { activePersona } = usePersonaState();
  const actor: ConsentCenterActor = activePersona === "ria" ? "ria" : "investor";
  const [mutationTick, setMutationTick] = useState(0);
  const cacheKey = user?.uid
    ? `consent_center_summary_${user.uid}_${actor}`
    : "consent_center_summary_guest";
  const [retainedSummary, setRetainedSummary] = useState<{
    key: string;
    data: ConsentCenterPageSummary;
  } | null>(null);

  useEffect(() => {
    const handleMutation = () => setMutationTick((value) => value + 1);
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleMutation);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, handleMutation);
    return () => {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleMutation);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, handleMutation);
    };
  }, []);

  const summaryResource = useStaleResource({
    cacheKey,
    refreshKey: `${actor}:${mutationTick}`,
    enabled: Boolean(user?.uid),
    load: async () => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) {
        throw new Error("Sign in to review consents");
      }
      return ConsentCenterService.getSummary({
        idToken,
        userId: user.uid,
        actor,
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

  return summaryData?.counts.pending ?? 0;
}
