"use client";

import { useState } from "react";

import OneLocationAgentPage from "@/app/one/location/page";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { CapabilityVaultPrerequisite } from "@/components/vault/capability-vault-prerequisite";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

export function LocationOnboardingSetupClient() {
  const [ready, setReady] = useState(false);
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "location",
    isOperationallyReady: ready,
    finishActionId: "setup.finish_location",
    skipActionId: "setup.skip_location",
  });

  if (!coordinator.isReady)
    return <SetupCapabilityLoading label="Preparing location setup…" />;

  return (
    <CapabilityVaultPrerequisite
      capabilityLabel="Location"
      routeKey="/one/setup/location"
    >
      <OneLocationAgentPage
        mode="setup"
        onSetupReadinessChange={setReady}
        onSetupComplete={async () => {
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
        }}
        onSetupSkip={async () => {
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
        }}
      />
    </CapabilityVaultPrerequisite>
  );
}
