"use client";

import { useState } from "react";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { VaultStatusInline } from "@/components/app-ui/vault-status-inline";
import { KaiFlow } from "@/components/kai/kai-flow";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";

export function FinanceImportOnboardingSetupClient() {
  const { user, loading } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [sourceSettled, setSourceSettled] = useState<
    "plaid" | "statement" | "later" | null
  >(null);
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "finance",
    isOperationallyReady: sourceSettled !== null,
    finishActionId: "setup.finish_finance",
    skipActionId: "setup.skip_finance",
    resumeReadinessFromCallback: true,
    // Root setup may have been skipped before Finance is opened. This is still
    // an explicit Finance task and must retain the portfolio-source terminal.
    allowResolvedRootReentry: true,
  });

  if (loading || !user || !coordinator.isReady) {
    return <SetupCapabilityLoading label="Preparing Finance setup…" />;
  }

  return (
    <FullscreenFlowShell as="div" width="reading" className="relative space-y-2 pb-[calc(var(--app-bottom-inset)+1rem)]">
      <VaultStatusInline className="px-1" />
      <KaiFlow
        userId={user.uid}
        mode="import"
        vaultOwnerToken={vaultOwnerToken ?? ""}
        onSetupSourceSettled={async (source, callbackAttemptId) => {
          if (!user) return false;
          const journey = await PreVaultUserStateService.bootstrapState(user.uid, {
            force: true,
          });
          if (
            journey.onboardingActiveCapability !== "finance" ||
            (callbackAttemptId &&
              journey.onboardingCallbackAttemptId !== callbackAttemptId)
          ) {
            return false;
          }
          await PreVaultUserStateService.syncOnboardingJourney({
            userId: user.uid,
            phase: "capability_setup",
            activeCapability: "finance",
            callbackState: "succeeded",
            expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
            expectedCallbackAttemptId: callbackAttemptId,
          });
          setSourceSettled(source);
          return true;
        }}
        onSetupConnectorAttemptSettled={async (outcome, callbackAttemptId) => {
          if (!user) return;
          const journey = await PreVaultUserStateService.bootstrapState(user.uid, {
            force: true,
          });
          if (
            journey.onboardingActiveCapability !== "finance" ||
            journey.onboardingPhase !== "external_connector" ||
            journey.onboardingCallbackState !== "pending" ||
            journey.onboardingCallbackAttemptId !== callbackAttemptId
          ) {
            return;
          }
          await PreVaultUserStateService.syncOnboardingJourney({
            userId: user.uid,
            phase: "external_connector",
            activeCapability: "finance",
            callbackState: outcome,
            expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
            expectedCallbackAttemptId: callbackAttemptId,
          });
        }}
        voicePublisherRole="chrome"
      />
      {(sourceSettled !== null || coordinator.operationallyReady) ? (
        <SetupCapabilityTerminalFooter
          capabilityId="finance"
          isOperationallyReady
          coordinator={coordinator}
        />
      ) : null}
    </FullscreenFlowShell>
  );
}
