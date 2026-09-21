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
  // Root setup is deliberately pre-vault, so it must always use the canonical
  // One Location journey that can stage its sensitive draft until the root
  // wizard creates the vault. One Voice readiness selects the microphone and
  // publisher owners in AgentOwnerGate; it must never swap this route's visual
  // tree or introduce a vault-gated setup path here.
  return <OneLocationAgentPage mode="setup" {...flowProps} />;
}
