"use client";

import { useState } from "react";

import OneLocationAgentPage from "@/app/one/location/page";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";

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
    <OneLocationAgentPage
      mode="setup"
      onSetupReadinessChange={setReady}
      onSetupComplete={async () => {
        await coordinator.finish();
      }}
      onSetupSkip={async () => {
        await coordinator.skip();
      }}
    />
  );
}
