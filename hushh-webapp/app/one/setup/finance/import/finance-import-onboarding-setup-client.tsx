"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { FinanceOnboardingPages } from "@/components/kai/onboarding/finance-onboarding-pages";
import { FinancePersonaForm } from "@/components/kai/onboarding/finance-persona-form";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { requireFinanceSession } from "@/lib/services/finance-sharing-service";
import { KaiProfileService } from "@/lib/services/kai-profile-service";
import type { PersonaPreferences } from "@/lib/kai/investing-persona";
import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { KaiFlow } from "@/components/kai/kai-flow";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { resolveOneSetupReturnTo } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import {
  FinanceOnboardingComplete,
  FinanceOnboardingDemo,
} from "@/components/kai/onboarding/finance-onboarding";
import {
  snapshotValidatedAuthSessionOwner,
  isValidatedAuthSessionOwnerCurrent,
} from "@/lib/auth/session-owner";

export function FinanceImportOnboardingSetupClient({
  showIntroduction = false,
}: {
  showIntroduction?: boolean;
}) {
  const { userId } = useAuth();
  const generation = snapshotValidatedAuthSessionOwner()?.generation;
  return (
    <OwnedFinanceImportSetup
      key={`${userId}:${generation}`}
      showIntroduction={showIntroduction}
    />
  );
}

function OwnedFinanceImportSetup({
  showIntroduction,
}: {
  showIntroduction: boolean;
}) {
  const { user, userId, loading } = useAuth();
  const { vaultOwnerToken } = useVault();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [introductionComplete, setIntroductionComplete] =
    useState(!showIntroduction);
  const [personaComplete, setPersonaComplete] = useState(!showIntroduction);
  const [personaSaving, setPersonaSaving] = useState(false);
  const [savedPreferences, setSavedPreferences] =
    useState<PersonaPreferences>();
  const { capture } = useFinanceShareContext();
  const [sourceSettled, setSourceSettled] = useState<
    "plaid" | "statement" | "later" | "resumed" | null
  >(null);
  const visit = useRef({
    live: true,
    owner: snapshotValidatedAuthSessionOwner(),
  });
  useEffect(() => {
    const activeVisit = visit.current;
    activeVisit.live = true;
    return () => {
      activeVisit.live = false;
    };
  }, []);
  const isCurrent = useCallback(
    () =>
      visit.current.live &&
      !!visit.current.owner &&
      visit.current.owner.userId === userId &&
      isValidatedAuthSessionOwnerCurrent(visit.current.owner),
    [userId],
  );
  const returnTo = resolveOneSetupReturnTo(searchParams.get("return_to"));
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "finance",
    isOperationallyReady: sourceSettled !== null,
    finishActionId: "setup.finish_finance",
    skipActionId: "setup.skip_finance",
    resumeReadinessFromCallback: true,
    settlementBlocked: sourceSettled === null,
    // Root setup may have been skipped before Finance is opened. This is still
    // an explicit Finance task and must retain the portfolio-source terminal.
    journeyMode: "auto",
    returnTo,
  });

  useEffect(() => {
    // A verified connector callback survives a refresh. Recover its explicit
    // terminal instead of replaying the demo or asking for a second import.
    if (
      coordinator.operationallyReady &&
      sourceSettled === null &&
      isCurrent()
    ) {
      setSourceSettled("resumed");
      setIntroductionComplete(true);
      setPersonaComplete(true);
    }
  }, [coordinator.operationallyReady, sourceSettled, isCurrent]);

  useBackLayer(pathname, 1, () => {
    if (coordinator.isSettling || personaSaving) return true;
    if (showIntroduction && introductionComplete && !personaComplete) {
      setIntroductionComplete(false);
      return true;
    }
    return false;
  });

  if (loading || !user || !userId || !coordinator.isReady) {
    return <SetupCapabilityLoading label="Preparing Finance setup…" />;
  }

  return (
    <FullscreenFlowShell
      as="div"
      width="agent"
      className="relative px-[var(--page-inline-gutter-standard)] pb-6"
    >
      <NativeTestBeacon
        routeId={
          showIntroduction ? "/one/setup/finance" : "/one/setup/finance/import"
        }
        marker={
          showIntroduction
            ? "native-route-one-setup-finance"
            : "native-route-one-setup-finance-import"
        }
        authState="authenticated"
        dataState="loaded"
      />
      <FinanceOnboardingPages
        stage={
          !introductionComplete
            ? 0
            : !personaComplete
              ? 1
              : sourceSettled
                ? 3
                : 2
        }
      >
        {!introductionComplete ? (
          <FinanceOnboardingDemo
            onContinue={() => setIntroductionComplete(true)}
          />
        ) : !personaComplete ? (
          <FinancePersonaForm
            onboarding
            initial={savedPreferences}
            onSavingChange={setPersonaSaving}
            onSkip={() => setPersonaComplete(true)}
            onDone={() => setPersonaComplete(true)}
            onSave={async (updates) => {
              const context = capture();
              if (!context || !isCurrent())
                throw new Error("Unlock your vault to save your persona.");
              const requireCurrentSetup = async () => {
                if (!isCurrent())
                  throw new Error(
                    "Finance setup has changed. Open it again to save your persona.",
                  );
                requireFinanceSession(context);
              };
              const profile = await KaiProfileService.savePreferences({
                ...context,
                mode: "onboarding",
                updates,
                beforeEffect: requireCurrentSetup,
              });
              await requireCurrentSetup();
              setSavedPreferences(profile.preferences);
            }}
          />
        ) : sourceSettled ? (
          <FinanceOnboardingComplete
            busy={coordinator.isSettling}
            rootSetup={coordinator.isInitialSetup}
            deferred={sourceSettled === "later"}
            onFinish={() => {
              void coordinator.finish();
            }}
          />
        ) : (
          <KaiFlow
            userId={userId}
            mode="import"
            setupSourcePicker
            onSetupIntroductionBack={
              showIntroduction ? () => setPersonaComplete(false) : undefined
            }
            vaultOwnerToken={vaultOwnerToken ?? ""}
            onSetupSourceSettled={async (source, callbackAttemptId) => {
              if (!userId || !isCurrent()) return false;
              const journey = await PreVaultUserStateService.bootstrapState(
                userId,
                {
                  force: true,
                },
              );
              if (!isCurrent()) return false;
              if (
                returnTo &&
                PreVaultUserStateService.isSetupResolved(journey)
              ) {
                // A deferred source resumes after root setup. Keep the import's
                // existing explicit terminal; do not revive its old journey attempt.
                setSourceSettled(source);
                return true;
              }
              if (
                journey.onboardingActiveCapability !== "finance" ||
                (callbackAttemptId &&
                  journey.onboardingCallbackAttemptId !== callbackAttemptId)
              ) {
                return false;
              }
              await PreVaultUserStateService.syncOnboardingJourney({
                userId,
                phase: "capability_setup",
                activeCapability: "finance",
                callbackState: "succeeded",
                expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
                expectedCallbackAttemptId: callbackAttemptId,
              });
              if (!isCurrent()) return false;
              setSourceSettled(source);
              return true;
            }}
            onSetupConnectorAttemptSettled={async (
              outcome,
              callbackAttemptId,
            ) => {
              if (!userId || !isCurrent()) return;
              const journey = await PreVaultUserStateService.bootstrapState(
                userId,
                {
                  force: true,
                },
              );
              if (!isCurrent()) return;
              if (
                journey.onboardingActiveCapability !== "finance" ||
                journey.onboardingPhase !== "external_connector" ||
                journey.onboardingCallbackState !== "pending" ||
                journey.onboardingCallbackAttemptId !== callbackAttemptId
              ) {
                return;
              }
              await PreVaultUserStateService.syncOnboardingJourney({
                userId,
                phase: "external_connector",
                activeCapability: "finance",
                callbackState: outcome,
                expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
                expectedCallbackAttemptId: callbackAttemptId,
              });
            }}
            deferSensitiveActionsUntilSetupFinalized
            voicePublisherRole="chrome"
          />
        )}
      </FinanceOnboardingPages>
    </FullscreenFlowShell>
  );
}
