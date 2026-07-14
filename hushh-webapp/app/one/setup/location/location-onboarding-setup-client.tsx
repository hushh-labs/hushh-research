"use client";

import { useState } from "react";

import OneLocationAgentPage from "@/app/one/location/page";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { ROUTES } from "@/lib/navigation/routes";

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
    <div className="space-y-4">
      <OneLocationAgentPage
        onSetupReadinessChange={setReady}
        vaultPrerequisiteRouteKey={ROUTES.ONE_SETUP_LOCATION}
      />
      <SetupCapabilityTerminalFooter
        capabilityId="location"
        isOperationallyReady={ready}
        coordinator={coordinator}
      />
    </div>
  );
}
