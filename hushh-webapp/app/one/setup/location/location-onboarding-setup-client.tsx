"use client";

import { useState } from "react";

import OneLocationAgentPage from "@/app/one/location/page";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
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

  if (!coordinator.isReady) return <SetupCapabilityLoading label="Preparing location setup…" />;

  return (
    <div className="space-y-4 pb-[calc(var(--app-bottom-inset)+1rem)]">
      <OneLocationAgentPage onSetupReadinessChange={setReady} />
      <SetupCapabilityTerminalFooter
        capabilityId="location"
        isOperationallyReady={ready}
        coordinator={coordinator}
      />
    </div>
  );
}
