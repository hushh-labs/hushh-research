"use client";

import { useEffect, useRef, useState } from "react";

import { OneLocationAgentPage } from "@/app/one/location/page";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { useAuth } from "@/lib/firebase/auth-context";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { useOptionalOneLocationInteractionSurface } from "@/components/one-location/onboarding/location-onboarding-interaction-surface";
import { finishVerifiedLocationSetup } from "@/lib/one-location/legacy-setup-finish";

function LocationSetupReturn({ onReturn }: { onReturn: () => void }) {
  const returnedRef = useRef(false);
  useEffect(() => {
    if (returnedRef.current) return;
    returnedRef.current = true;
    onReturn();
  }, [onReturn]);

  return <SetupCapabilityLoading label="Returning to setup..." />;
}

export function LocationOnboardingSetupClient() {
  const auth = useAuth();
  const interaction = useOptionalOneLocationInteractionSurface();
  const sessionRef = useRef({ mounted: true, userId: auth.userId });
  useEffect(() => {
    sessionRef.current = { mounted: true, userId: auth.userId };
    return () => { sessionRef.current.mounted = false; };
  }, [auth.userId]);
  const [ready, setReady] = useState(false);
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "location",
    isOperationallyReady: ready,
    finishActionId: "setup.finish_location_intro",
    skipActionId: "setup.skip_location",
    terminalPresentation: "automatic",
  });
  useLocalOnboardingActionHandler("setup.finish_location", (_slots, context) => {
    const userId = auth.userId;
    const session = sessionRef.current;
    return finishVerifiedLocationSetup({
      userId,
      runId: interaction?.currentRun?.runId ?? null,
      isCurrent: () => sessionRef.current === session && session.mounted && session.userId === userId && !context?.signal?.aborted,
      onVerified: coordinator.returnToSetup,
    });
  }, { enabled: coordinator.isReady && Boolean(auth.userId) });

  if (!coordinator.isReady)
    return <SetupCapabilityLoading label="Preparing location setup…" />;

  if (coordinator.isAlreadyComplete) {
    return <LocationSetupReturn onReturn={coordinator.returnToSetup} />;
  }

  // The introduction completes independently of device access; its optional
  // Save a place step is skippable and a refused grant moves on to Ready.
  // Location is requested later through the workspace toggle or Save a place.
  const flowProps = {
    onSetupReadinessChange: setReady,
    onSetupComplete: async () => {
      await toast
        .promise(
          coordinator.finish({ suppressErrorToast: true }).then((result) => {
            if (result.status !== "succeeded") throw new Error(result.summary);
            return result;
          }),
          {
            loading: "Finishing Location setup…",
            success: (result) => result.summary,
            error: "Location setup could not be saved. Please try again.",
          },
        )
        .unwrap();
    },
    onSetupSkip: async () => {
      await toast
        .promise(
          coordinator.skip({ suppressErrorToast: true }).then((result) => {
            if (result.status !== "succeeded") throw new Error(result.summary);
            return result;
          }),
          {
            loading: "Skipping Location setup…",
            success: (result) => result.summary,
            error: "Location setup could not be updated. Please try again.",
          },
        )
        .unwrap();
    },
  };
  // Keep setup paired with the established /one/location workspace. That
  // workspace was restored as the unconditional customer-facing route and its
  // setup completion is persisted by the coordinator above. The migration-223
  // progress UI belongs to the separate LocationArea experiment; mounting it
  // here would create a split-brain journey and would also gate root setup on a
  // vault token that deliberately does not exist yet. One Voice readiness may
  // select runtime owners in AgentOwnerGate, but it must not select this route's
  // presentation.
  return <OneLocationAgentPage mode="setup" {...flowProps} />;
}
