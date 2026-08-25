"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import GmailReceiptsPage from "@/components/gmail/gmail-receipts-page";
import { GmailWorkspaceSkeleton } from "@/components/gmail/gmail-workspace-skeleton";
import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import { CapabilityVaultPrerequisite } from "@/components/vault/capability-vault-prerequisite";
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
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "gmail",
    isOperationallyReady: connected,
    finishActionId: "setup.finish_gmail",
    skipActionId: "setup.skip_gmail",
    resumeReadinessFromCallback: true,
    terminalControlId: (ready) =>
      ready ? "finish_gmail_setup" : "skip_gmail_setup",
  });

  if (!coordinator.isReady) {
    return <SetupCapabilityLoading label="Preparing Gmail setup…" />;
  }

  return (
    <CapabilityCinematicIntroGate capabilityId="gmail">
      <CapabilityVaultPrerequisite
        capabilityLabel="Gmail"
        routeKey={ROUTES.ONE_SETUP_GMAIL}
        checkingFallback={<GmailWorkspaceSkeleton />}
      >
        <GmailReceiptsPage
          journeyVariant="onboarding"
          onConnectionStateChange={setConnected}
          onFinishSetup={() => void coordinator.finish()}
          finishingSetup={coordinator.isSettling}
          onSkipSetup={() => void coordinator.skip()}
          skippingSetup={coordinator.isSettling}
          voicePublisherRole="chrome"
        />
      </CapabilityVaultPrerequisite>
    </CapabilityCinematicIntroGate>
  );
}
