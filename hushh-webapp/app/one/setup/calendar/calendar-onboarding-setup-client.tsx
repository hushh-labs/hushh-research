"use client";

import { useState } from "react";

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";
import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";

/** Calendar setup adapter; the agent workspace owns OAuth and connection state. */
export function CalendarOnboardingSetupClient() {
  const [connected, setConnected] = useState(false);
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "calendar",
    isOperationallyReady: connected,
    finishActionId: "setup.finish_calendar",
    skipActionId: "setup.skip_calendar",
    resumeReadinessFromCallback: true,
    terminalControlId: (ready) =>
      ready ? "finish_calendar_setup" : "skip_calendar_setup",
  });

  if (!coordinator.isReady) {
    return <SetupCapabilityLoading label="Preparing Calendar setup…" />;
  }

  return (
    <CapabilityCinematicIntroGate capabilityId="calendar">
      <CalendarAgentPage
        journeyVariant="onboarding"
        onConnectionStateChange={setConnected}
        onFinishSetup={() => void coordinator.finish()}
        finishingSetup={coordinator.isSettling}
        onSkipSetup={() => void coordinator.skip()}
        skippingSetup={coordinator.isSettling}
      />
    </CapabilityCinematicIntroGate>
  );
}
