"use client";

import { useEffect, useRef, useState } from "react";

import { OneLocationAgentPage } from "@/app/one/location/page";
import dynamic from "next/dynamic";
import { useOneVoiceLiveEnabled } from "@/lib/one-voice/readiness";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

const LocationSetupFlow = dynamic(
  () =>
    import("@/components/location/setup/location-setup-flow").then(
      (module) => module.LocationSetupFlow,
    ),
  {
    ssr: false,
    loading: () => <SetupCapabilityLoading label="Preparing location setup…" />,
  },
);

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
  const live = useOneVoiceLiveEnabled();
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
  // One route, two trees: the voice-first setup when Live is on, the legacy
  // flow otherwise. Both take the same coordinator-bound callbacks.
  if (live) return <LocationSetupFlow mode="setup" {...flowProps} />;
  return <OneLocationAgentPage mode="setup" {...flowProps} />;
}
