"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import GmailReceiptsPage from "@/components/gmail/gmail-receipts-page";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { ROUTES } from "@/lib/navigation/routes";
import { isOneCapabilityEnabled } from "@/lib/onboarding/one-capabilities";

/**
 * Gmail's setup adapter. The feature body keeps OAuth and receipt behavior;
 * this route owns only the first-run goal and the explicit terminal action.
 */
export function GmailOnboardingSetupClient() {
  if (!isOneCapabilityEnabled("gmail")) {
    return <PausedGmailSetupRedirect />;
  }

  return <EnabledGmailOnboardingSetup />;
}

function PausedGmailSetupRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace(ROUTES.ONE_SETUP);
  }, [router]);

  return <RouteLoadingState label="Opening setup…" />;
}

function EnabledGmailOnboardingSetup() {
  const [connected, setConnected] = useState(false);
  const finishStartedRef = useRef(false);
  const router = useRouter();
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "gmail",
    isOperationallyReady: connected,
    finishActionId: "setup.finish_gmail",
    skipActionId: "setup.skip_gmail",
    resumeReadinessFromCallback: true,
    terminalControlId: (ready) =>
      ready ? "finish_gmail_setup" : "skip_gmail_setup",
  });

  const handleFinishSetup = useCallback(() => {
    if (finishStartedRef.current) return;
    finishStartedRef.current = true;

    router.replace(ROUTES.ONE_SETUP);
    void coordinator
      .finish()
      .catch((error) => {
        console.warn("[GmailOnboardingSetup] Background finish failed:", error);
      })
      .finally(() => {
        finishStartedRef.current = false;
      });
  }, [coordinator, router]);

  if (!coordinator.isReady) {
    return <SetupCapabilityLoading label="Preparing Gmail setup…" />;
  }

  return (
    <GmailReceiptsPage
      journeyVariant="onboarding"
      onConnectionStateChange={setConnected}
      onFinishSetup={handleFinishSetup}
      finishingSetup={false}
      onSkipSetup={() => void coordinator.skip()}
      skippingSetup={coordinator.isSettling}
      voicePublisherRole="chrome"
    />
  );
}
