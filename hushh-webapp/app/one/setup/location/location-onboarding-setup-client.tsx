"use client";

import { useEffect, useRef, useState } from "react";

import OneLocationAgentPage from "@/app/one/location/page";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

function LocationSetupReturn({
  onReturn,
}: {
  onReturn: () => void;
}) {
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

  // No cinematic intro and no permission primer here any more. Both sat in
  // front of the flow's own welcome screen, which already frames the value, and
  // the features screen already requests Location and notifications the moment
  // it opens -- so the primer was asking a second time for the same thing. That
  // put first-run Location at five taps; it is now three. Other capabilities
  // keep their intro gate: this is a Location-only change.
  return (
    <OneLocationAgentPage
      mode="setup"
      onSetupReadinessChange={setReady}
      onSetupComplete={async () => {
        await toast
          .promise(
            coordinator.finish({ suppressErrorToast: true }).then((result) => {
              if (result.status !== "succeeded")
                throw new Error(result.summary);
              return result;
            }),
            {
              loading: "Finishing Location setup…",
              success: (result) => result.summary,
              error: "Location setup could not be saved. Please try again.",
            },
          )
          .unwrap();
      }}
      onSetupSkip={async () => {
        await toast
          .promise(
            coordinator.skip({ suppressErrorToast: true }).then((result) => {
              if (result.status !== "succeeded")
                throw new Error(result.summary);
              return result;
            }),
            {
              loading: "Skipping Location setup…",
              success: (result) => result.summary,
              error: "Location setup could not be updated. Please try again.",
            },
          )
          .unwrap();
      }}
    />
  );
}
