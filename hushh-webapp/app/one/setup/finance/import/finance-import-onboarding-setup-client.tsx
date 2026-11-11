"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import styles from "@/components/kai/onboarding/finance-onboarding.module.css";

import { FinanceOnboardingPages } from "@/components/kai/onboarding/finance-onboarding-pages";
import { FinancePersonaForm } from "@/components/kai/onboarding/finance-persona-form";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { requireFinanceSession } from "@/lib/services/finance-sharing-service";
import { KaiProfileService } from "@/lib/services/kai-profile-service";
import type { PersonaPreferences } from "@/lib/kai/investing-persona";
import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { KaiFlow } from "@/components/kai/kai-flow";
import {
  SetupCapabilityLoading,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { resolveOneSetupReturnTo } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { takeFinanceSetupPlaidSuccess } from "@/lib/kai/brokerage/plaid-oauth-session";
import { FinanceOnboardingComplete } from "@/components/kai/onboarding/finance-onboarding";
import {
  snapshotValidatedAuthSessionOwner,
  isValidatedAuthSessionOwnerCurrent,
} from "@/lib/auth/session-owner";

export function FinanceImportOnboardingSetupClient({
  startWithPersona = false,
}: {
  startWithPersona?: boolean;
}) {
  const { userId } = useAuth();
  const generation = snapshotValidatedAuthSessionOwner()?.generation;
  return (
    <OwnedFinanceImportSetup
      key={`${userId}:${generation}`}
      startWithPersona={startWithPersona}
    />
  );
}

function OwnedFinanceImportSetup({
  startWithPersona,
}: {
  startWithPersona: boolean;
}) {
  const { user, userId, loading } = useAuth();
  const { vaultOwnerToken, getVaultKey, retryOwnerTokenRenewal } = useVault();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [personaComplete, setPersonaComplete] = useState(!startWithPersona);
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaVaultPrompt, setPersonaVaultPrompt] = useState<"unlock" | "create" | null>(null);
  const resolvePersonaVaultPrompt = useRef<((unlocked: boolean) => void) | null>(null);
  const [savedPreferences, setSavedPreferences] =
    useState<PersonaPreferences>();
  const { capture } = useFinanceShareContext();
  const [sourceSettled, setSourceSettled] = useState<
    "plaid" | "statement" | "later" | "resumed" | null
  >(null);
  const [plaidHandoff, setPlaidHandoff] = useState<"confirming" | "opening" | "retry">("confirming");
  const visit = useRef({
    live: true,
    owner: snapshotValidatedAuthSessionOwner(),
  });
  useEffect(() => {
    const activeVisit = visit.current;
    activeVisit.live = true;
    return () => {
      activeVisit.live = false;
      resolvePersonaVaultPrompt.current?.(false);
      resolvePersonaVaultPrompt.current = null;
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
  const plaidFinanceHandoff = sourceSettled === "plaid" && !returnTo;
  const autoContinuing = plaidFinanceHandoff && plaidHandoff !== "retry";
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "finance",
    allowCompletedFinanceEntry: startWithPersona && !returnTo && !searchParams.has("stage"),
    isOperationallyReady: sourceSettled !== null,
    finishActionId: "setup.finish_finance",
    skipActionId: "setup.skip_finance",
    resumeReadinessFromCallback: true,
    settlementBlocked: sourceSettled === null,
    terminalPresentation: autoContinuing ? "automatic" : "explicit",
    // Root setup may have been skipped before Finance is opened. This is still
    // an explicit Finance task and must retain the portfolio-source terminal.
    journeyMode: "auto",
    returnTo,
  });

  useEffect(() => {
    if (sourceSettled !== null || !isCurrent() || !coordinator.isReady) return;
    const plaidConnected = takeFinanceSetupPlaidSuccess(pathname);
    // A verified connector callback survives a refresh. Recover its explicit
    // terminal without repeating the questionnaire or import.
    if (plaidConnected || coordinator.operationallyReady) {
      setSourceSettled(plaidConnected ? "plaid" : "resumed");
      setPersonaComplete(true);
    }
  }, [coordinator.isReady, coordinator.operationallyReady, sourceSettled, isCurrent, pathname]);

  const finish = coordinator.finish;
  const openFinanceAfterPlaid = useCallback(async (recordAttempt = false) => {
    if (!isCurrent()) return;
    setPlaidHandoff("opening");
    try {
      const result = await finish({ recordAttempt });
      if (result.status === "succeeded") return;
    } catch {
      // The linked account is already saved. Retry setup settlement only.
    }
    if (isCurrent()) setPlaidHandoff("retry");
  }, [finish, isCurrent]);

  useEffect(() => {
    if (!plaidFinanceHandoff || plaidHandoff !== "confirming" ||
        !coordinator.isReady || !coordinator.operationallyReady || !isCurrent()) return;
    const timer = window.setTimeout(() => void openFinanceAfterPlaid(), 1500);
    return () => window.clearTimeout(timer);
  }, [plaidFinanceHandoff, plaidHandoff, coordinator.isReady, coordinator.operationallyReady, isCurrent, openFinanceAfterPlaid]);

  useBackLayer(pathname, 1, () => coordinator.isSettling || personaSaving || autoContinuing);

  function closePersonaVaultPrompt(unlocked: boolean) {
    const resolve = resolvePersonaVaultPrompt.current;
    resolvePersonaVaultPrompt.current = null;
    setPersonaVaultPrompt(null);
    resolve?.(unlocked);
  }

  async function savePersona(updates: PersonaPreferences): Promise<void | false> {
    if (!userId || !isCurrent()) return false;
    let context = capture();

    if (!context && getVaultKey()) {
      await retryOwnerTokenRenewal();
      if (!isCurrent()) return false;
      context = capture();
      if (!context && getVaultKey()) {
        throw new Error("Couldn’t restore vault access. Try saving again.");
      }
    }

    if (!context) {
      const journey = await PreVaultUserStateService.bootstrapState(userId, { force: true })
        .catch(() => { throw new Error("Couldn’t check your vault. Try saving again."); });
      if (!isCurrent()) return false;
      context = capture();
      if (!context) {
        if (journey.hasVault === false && coordinator.isInitialSetup) {
          PreVaultSensitiveDraftService.stageFinancePreferences(userId, updates);
          setSavedPreferences(updates);
          return;
        }
        if (journey.hasVault == null || getVaultKey()) {
          throw new Error("Couldn’t confirm vault access. Try saving again.");
        }

        // The form keeps the submission in memory while the shared dialog is open.
        const unlocked = await new Promise<boolean>((resolve) => {
          resolvePersonaVaultPrompt.current = resolve;
          setPersonaVaultPrompt(journey.hasVault === false ? "create" : "unlock");
        });
        if (!unlocked || !isCurrent()) return false;
        context = capture();
      }
    }

    if (!context || context.userId !== userId) {
      throw new Error("Couldn’t open your vault. Try saving again.");
    }
    const session = context;
    const requireCurrentSetup = async () => {
      if (!isCurrent()) throw new Error("Finance setup has changed. Open it again to save your persona.");
      requireFinanceSession(session);
    };
    await requireCurrentSetup();
    const profile = await KaiProfileService.savePreferences({
      ...session,
      mode: "onboarding",
      updates,
      beforeEffect: requireCurrentSetup,
    });
    await requireCurrentSetup();
    setSavedPreferences(profile.preferences);
  }

  if (loading || !user || !userId || !coordinator.isReady) {
    return <SetupCapabilityLoading label="Preparing Finance setup…" />;
  }

  return (
    <FullscreenFlowShell
      as="div"
      width="agent"
      data-finance-setup-flow
      className={`${styles.setupFlowShell} relative shrink-0 px-[var(--page-inline-gutter-standard)]`}
    >
      <NativeTestBeacon
        routeId={
          startWithPersona ? "/one/setup/finance" : "/one/setup/finance/import"
        }
        marker={
          startWithPersona
            ? "native-route-one-setup-finance"
            : "native-route-one-setup-finance-import"
        }
        authState="authenticated"
        dataState="loaded"
      />
      <FinanceOnboardingPages
        stage={!personaComplete ? 1 : sourceSettled ? 3 : 2}
      >
        {!personaComplete ? (
          <FinancePersonaForm
            onboarding
            initial={savedPreferences}
            onSavingChange={setPersonaSaving}
            onDone={() => setPersonaComplete(true)}
            onSave={savePersona}
          />
        ) : sourceSettled ? (
          <FinanceOnboardingComplete
            busy={coordinator.isSettling}
            rootSetup={coordinator.isInitialSetup}
            deferred={sourceSettled === "later"}
            plaidConnected={plaidFinanceHandoff}
            autoContinuing={autoContinuing}
            onFinish={() => {
              if (plaidFinanceHandoff) void openFinanceAfterPlaid(true);
              else void finish({ recordAttempt: true });
            }}
          />
        ) : (
          <KaiFlow
            userId={userId}
            mode="import"
            setupSourcePicker
            onSetupPersonaBack={
              startWithPersona ? () => setPersonaComplete(false) : undefined
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
              if (PreVaultUserStateService.isSetupResolved(journey)) {
                // Individual Finance setup still needs its terminal. The
                // coordinator settles it without reviving the root journey.
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
      <VaultUnlockDialog
        user={user}
        open={personaVaultPrompt !== null}
        allowVaultCreation={personaVaultPrompt === "create"}
        onOpenChange={(open) => { if (!open) closePersonaVaultPrompt(false); }}
        onSuccess={() => closePersonaVaultPrompt(true)}
        title={personaVaultPrompt === "create" ? "Set up your vault" : "Unlock your vault"}
        description="Save your investing preferences in your vault."
      />
    </FullscreenFlowShell>
  );
}
