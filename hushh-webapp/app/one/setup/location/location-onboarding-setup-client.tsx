"use client";

import { useEffect, useRef, useState } from "react";

import { OneLocationAgentPage } from "@/app/one/location/page";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

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
  const [ready, setReady] = useState(false);
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "location",
    isOperationallyReady: ready,
    finishActionId: "setup.finish_location",
    skipActionId: "setup.skip_location",
    terminalPresentation: "automatic",
  });

  if (!coordinator.isReady)
    return <SetupCapabilityLoading label="Preparing location setup…" />;

  if (coordinator.isAlreadyComplete) {
    return <LocationSetupReturn onReturn={coordinator.returnToSetup} />;
  }

  // No cinematic intro or separate permission primer here. The flow's own
  // Welcome and Features screens frame the value, and Location is requested
  // only after the person taps "Set up my location". Notifications are
  // deliberately outside this onboarding journey. Other capabilities keep
  // their intro gate: this is a Location-only change.
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
