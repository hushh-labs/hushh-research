"use client";

import { useState } from "react";
import { CalendarPlus, Clock3 } from "lucide-react";

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
    <CapabilityCinematicIntroGate
      capabilityId="calendar"
      introSupplement={
        <div
          className="grid overflow-hidden rounded-[var(--app-radius-md)] border border-border/60 bg-card/50 text-left sm:grid-cols-2"
          aria-label="What Calendar can do"
        >
          <div className="border-b border-border/60 p-4 sm:border-b-0 sm:border-r">
            <Clock3 className="size-4 text-primary" aria-hidden />
            <p className="mt-2 font-semibold text-foreground">Find time</p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              See availability without the back-and-forth.
            </p>
          </div>
          <div className="p-4">
            <CalendarPlus className="size-4 text-primary" aria-hidden />
            <p className="mt-2 font-semibold text-foreground">
              Schedule with control
            </p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              One always asks before making a change.
            </p>
          </div>
        </div>
      }
    >
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
