"use client";

import { useState } from "react";

import GmailReceiptsPage from "@/components/gmail/gmail-receipts-page";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";

/**
 * Gmail's setup adapter. The feature body keeps OAuth and receipt behavior;
 * this route owns only the first-run goal and the explicit terminal action.
 */
export function GmailOnboardingSetupClient() {
  const [connected, setConnected] = useState(false);
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "gmail",
    isOperationallyReady: connected,
    finishActionId: "setup.finish_gmail",
    skipActionId: "setup.skip_gmail",
    terminalControlId: (ready) =>
      ready ? "finish_gmail_setup" : "skip_gmail_setup",
  });

  if (!coordinator.isReady) {
    return <SetupCapabilityLoading label="Preparing Gmail setup…" />;
  }

  return (
    <GmailReceiptsPage
      journeyVariant="onboarding"
      onConnectionStateChange={setConnected}
      onFinishSetup={() => void coordinator.finish()}
      finishingSetup={coordinator.isSettling}
      onSkipSetup={() => void coordinator.skip()}
      skippingSetup={coordinator.isSettling}
      voicePublisherRole="chrome"
    />
  );
}
