"use client";

import { useState } from "react";

import OneKycPage from "@/app/one/kyc/page";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";

export function EmailOnboardingSetupClient() {
  const [ready, setReady] = useState(false);
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "email",
    isOperationallyReady: ready,
    finishActionId: "setup.finish_email",
    skipActionId: "setup.skip_email",
  });

  if (!coordinator.isReady) return <SetupCapabilityLoading label="Preparing KYC setup…" />;

  return (
    <div className="space-y-4 pb-[calc(var(--app-bottom-inset)+1rem)]">
      <OneKycPage
        onSetupReadinessChange={setReady}
        voicePublisherRole="chrome"
      />
      <SetupCapabilityTerminalFooter
        capabilityId="email"
        isOperationallyReady={ready}
        coordinator={coordinator}
      />
    </div>
  );
}
