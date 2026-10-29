"use client";

import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { KaiPreferencesWizard } from "@/components/kai/onboarding/KaiPreferencesWizard";
import { KaiInviteHandshake } from "@/components/kai/onboarding/kai-invite-handshake";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { useKaiPreferencesWizard } from "@/components/kai/onboarding/use-kai-preferences-wizard";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import {
  usePublishVoiceSurfaceMetadata,
  type VoiceSurfacePublisherRole,
} from "@/lib/kai/actions/voice-surface-metadata";
import {
  KaiProfileService,
  computeRiskScore,
  mapRiskProfile,
  resolveKaiOnboardingCompletion,
  type KaiProfileV2,
  type DrawdownResponse,
  type InvestmentHorizon,
  type VolatilityPreference,
} from "@/lib/services/kai-profile-service";
import {
  PreVaultOnboardingService,
  type PreVaultOnboardingAnswers,
  type PreVaultOnboardingState,
} from "@/lib/services/pre-vault-onboarding-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  canActivateFinanceSetup,
  shouldShowFinanceSetupWizard,
} from "@/lib/onboarding/finance-setup-admission";
import { VaultService } from "@/lib/services/vault-service";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  buildOneSetupKaiRoute,
  buildOneSetupRoute,
  normalizeInternalRouteHref,
  ROUTES,
} from "@/lib/navigation/routes";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { trackEvent } from "@/lib/observability/client";
import { Card } from "@/lib/morphy-ux/card";
import { Button } from "@/lib/morphy-ux/button";
import { AlertTriangle } from "@/components/icons";
import { useNativeTestConfig } from "@/lib/testing/native-test";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

type Stage = "loading" | "vault_required" | "entry" | "wizard";
type OnboardingSource = "pre_vault" | "vault";

type WizardAnswers = {
  investment_horizon: InvestmentHorizon | null;
  drawdown_response: DrawdownResponse | null;
  volatility_preference: VolatilityPreference | null;
};

function profileToAnswers(profile: KaiProfileV2 | null): WizardAnswers {
  return {
    investment_horizon: profile?.preferences.investment_horizon ?? null,
    drawdown_response: profile?.preferences.drawdown_response ?? null,
    volatility_preference: profile?.preferences.volatility_preference ?? null,
  };
}

function pendingToAnswers(
  pending: PreVaultOnboardingState | null,
): WizardAnswers {
  return {
    investment_horizon: pending?.answers.investment_horizon ?? null,
    drawdown_response: pending?.answers.drawdown_response ?? null,
    volatility_preference: pending?.answers.volatility_preference ?? null,
  };
}

/**
 * Full-height region for the wizard's transient stages (loading, redirect,
 * error). The TopAppBar stays visible in this flow, so these stages must START
 * below the top shell + safe-area inset just like the preferences
 * stage does. `--top-content-pad` folds in `env(safe-area-inset-top)`, the
 * shell's reserved height, and the sub-nav gap; `--app-screen-footer-pad`
 * mirrors the bottom inset. Centering happens INSIDE this padded box so the
 * loader text can never tuck under the top bar on notched devices.
 */
function SetupKaiStageRegion({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] w-full max-w-full flex-col items-center justify-center px-4 sm:px-6 pt-[var(--top-content-pad)] pb-[var(--app-scroll-bottom-pad,var(--onboarding-agent-bar-clearance,4rem))]">
      {children}
    </div>
  );
}

function KaiOnboardingPageContent({
  voicePublisherRole = "route",
}: {
  voicePublisherRole?: VoiceSurfacePublisherRole;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const nativeTestConfig = useNativeTestConfig();
  const { user, userId, loading: authLoading } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();

  const [source, setSource] = useState<OnboardingSource | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<KaiProfileV2 | null>(null);
  const [preVaultState, setPreVaultState] =
    useState<PreVaultOnboardingState | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [vaultOpen, setVaultOpen] = useState(false);
  const onboardingStartedRef = useRef(false);
  const inviteToken = searchParams.get("invite");
  const onboardingFromHref = useMemo(
    () => normalizeInternalRouteHref(searchParams.get("from")),
    [searchParams],
  );
  const isStaticFinanceSetupRoute = pathname === ROUTES.ONE_SETUP_FINANCE;
  const financeSetupCoordinator = useSetupCapabilityCoordinator({
    capabilityId: "finance",
    isOperationallyReady: false,
    finishActionId: "setup.finish_finance",
    skipActionId: "setup.skip_finance",
    enabled: isStaticFinanceSetupRoute,
    screenId: "one_setup_finance",
    journeyMode: "auto",
  });
  // Intentional re-entry: a user who has ALREADY resolved the setup gate but
  // deliberately reopens this wizard (tapping the Finance tile, which forwards
  // with a `from` marker, or an explicit `edit=1`) must land ON the
  // questionnaire to review/edit their answers, NOT be bounced to the `/one/setup`
  // hub. Without this, Finance setup dead-loops back to the hub.
  // First-run gating (unresolved users) is unchanged.
  const wizardReentryRequested = useMemo(
    () => onboardingFromHref !== null || searchParams.get("edit") === "1",
    [onboardingFromHref, searchParams],
  );
  const onboardingSelfHref = useMemo(
    () =>
      buildOneSetupKaiRoute({ from: onboardingFromHref, invite: inviteToken }),
    [inviteToken, onboardingFromHref],
  );
  const preserveOnboardingAuditRoute =
    nativeTestConfig.enabled &&
    nativeTestConfig.expectedRoute === ROUTES.ONE_SETUP_KAI;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (authLoading) return;

      if (!user) {
        router.replace(
          `${ROUTES.LOGIN}?redirect=${encodeURIComponent(onboardingSelfHref)}`,
        );
        return;
      }

      if (inviteToken) {
        setLoadError(null);
        return;
      }
      if (!userId) return;

      try {
        setLoadError(null);
        setStage("loading");

        const hasVault = await VaultService.checkVault(userId);
        if (cancelled) return;

        if (!hasVault) {
          setSource("pre_vault");
          const remoteState = await PreVaultUserStateService.bootstrapState(
            userId,
          );
          if (cancelled) return;

          const onboardingResolved =
            PreVaultUserStateService.isSetupResolved(remoteState);
          if (onboardingResolved) {
            setOnboardingRequiredCookie(false);
            setOnboardingFlowActiveCookie(false);
          } else {
            setOnboardingRequiredCookie(true);
            setOnboardingFlowActiveCookie(false);
          }

          const pending = await PreVaultOnboardingService.load(userId);
          if (cancelled) return;
          setPreVaultState(pending);
          // The investor-preferences wizard renders here when the root flow is
          // unresolved and a draft exists, OR when a resolved user intentionally
          // re-enters to review/edit their answers (finance tile / edit=1).
          // Otherwise the canonical surface is the `/one/setup` capability hub,
          // so we redirect there instead of showing the legacy entry hub.
          if (
            shouldShowFinanceSetupWizard({
              onboardingResolved,
              hasPendingPreVaultState: Boolean(pending),
              isCanonicalFinanceSetupRoute: isStaticFinanceSetupRoute,
              wizardReentryRequested,
              preserveOnboardingAuditRoute,
            })
          ) {
            setStage("wizard");
          } else {
            router.replace(buildOneSetupRoute({ from: onboardingFromHref }));
          }
          return;
        }

        setSource("vault");

        if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
          const pending = await PreVaultOnboardingService.load(userId);
          if (cancelled) return;
          if (pending || isStaticFinanceSetupRoute) {
            setSource("pre_vault");
            setPreVaultState(pending);
            setStage("wizard");
            return;
          }
          setStage("vault_required");
          setVaultOpen(true);
          return;
        }

        const nextProfile = await KaiProfileService.getProfile({
          userId,
          vaultKey,
          vaultOwnerToken,
        });

        if (cancelled) return;

        setProfile(nextProfile);
        const completion = resolveKaiOnboardingCompletion(nextProfile);
        if (completion.completed) {
          // Finance preferences are a capability result, never the root setup
          // decision. Returning to the hub leaves its explicit Finish/Skip as
          // the sole authority for resolving onboarding.
          const rootState = await PreVaultUserStateService.bootstrapState(
            userId,
          ).catch(() => null);
          setOnboardingRequiredCookie(
            !PreVaultUserStateService.isSetupResolved(rootState),
          );
          setOnboardingFlowActiveCookie(false);
          // Onboarding is complete. A user who intentionally re-enters to edit
          // their preferences (finance tile / edit=1) stays on the questionnaire,
          // pre-filled from the saved profile. Everyone else returns to the
          // canonical `/one/setup` hub rather than the legacy entry screen.
          if (
            shouldShowFinanceSetupWizard({
              onboardingResolved: true,
              hasPendingPreVaultState: false,
              isCanonicalFinanceSetupRoute: isStaticFinanceSetupRoute,
              wizardReentryRequested,
              preserveOnboardingAuditRoute,
            })
          ) {
            setStage("wizard");
            return;
          }
          router.replace(buildOneSetupRoute({ from: onboardingFromHref }));
          return;
        }

        setOnboardingRequiredCookie(true);
        setOnboardingFlowActiveCookie(false);
        // Always return to the questionnaire until the onboarding completion flag is set.
        setStage("wizard");
      } catch (error) {
        console.warn("[OneOnboardingPage] Failed to load onboarding:", error);
        if (!cancelled) {
          setLoadError("Couldn't load onboarding state. Please retry.");
          setStage("loading");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [
    authLoading,
    inviteToken,
    user,
    userId,
    isVaultUnlocked,
    vaultKey,
    vaultOwnerToken,
    router,
    retryNonce,
    preserveOnboardingAuditRoute,
    onboardingSelfHref,
    onboardingFromHref,
    wizardReentryRequested,
    isStaticFinanceSetupRoute,
  ]);

  const wizardAnswers: WizardAnswers = useMemo(() => {
    if (source === "vault") return profileToAnswers(profile);
    return pendingToAnswers(preVaultState);
  }, [source, profile, preVaultState]);

  useEffect(() => {
    if (!source || stage !== "wizard" || onboardingStartedRef.current) return;
    onboardingStartedRef.current = true;
    trackEvent("onboarding_started", {
      source,
    });
  }, [source, stage]);

  // One operation owns touch and voice completion. Retire its asynchronous
  // continuations when the owner, vault authority or source changes.
  const epoch = snapshotVaultSessionEpoch();
  const generation = snapshotValidatedAuthSessionOwner()?.generation;
  const saveVisit = useMemo(() => ({ live: false, pending: false, draft: Promise.resolve(),
    owner: snapshotValidatedAuthSessionOwner(), epoch, generation, userId, source, key: vaultKey, token: vaultOwnerToken,
  }), [userId, source, vaultKey, vaultOwnerToken, epoch, generation]);
  const current = () => saveVisit.live && !!saveVisit.owner && saveVisit.owner.userId === saveVisit.userId &&
    saveVisit.owner.generation === saveVisit.generation &&
    isValidatedAuthSessionOwnerCurrent(saveVisit.owner) && snapshotVaultSessionEpoch() === saveVisit.epoch;
  const requireCurrent = () => { if (!current()) throw new Error("FINANCE_SETUP_RETIRED"); };
  useLayoutEffect(() => {
    saveVisit.live = true;
    setSaving(false);
    return () => { saveVisit.live = false; };
  }, [saveVisit]);
  const wizard = useKaiPreferencesWizard({
    mode: "onboarding",
    enabled: Boolean(user && userId && source && stage === "wizard" && !inviteToken &&
      (!isStaticFinanceSetupRoute || financeSetupCoordinator.isReady)),
    resetKey: saveVisit,
    initialAnswers: wizardAnswers,
    isSubmitting: saving,
    onAnswersChange: (answers) => {
      if (source !== "pre_vault" || !userId || !current()) return;
      // Preserve the existing memory-only draft, in order. Final submission
      // waits for these writes so an older partial answer cannot win later.
      saveVisit.draft = saveVisit.draft.then(async () => {
        if (!current()) return;
        const score = computeRiskScore(answers as PreVaultOnboardingAnswers);
        const saved = await PreVaultOnboardingService.saveDraft(userId, {
          answers, risk_score: score, risk_profile: score === null ? null : mapRiskProfile(score),
        });
        if (current()) setPreVaultState(saved);
      }).catch(() => { /* Continue retries the complete draft through the same writer. */ });
    },
    onComplete: async (payload) => {
      if (!current() || saveVisit.pending || !userId || !source) throw new Error("Finance setup is unavailable.");
      const answers: WizardAnswers = {
        investment_horizon: payload.investment_horizon,
        drawdown_response: payload.drawdown_response,
        volatility_preference: payload.volatility_preference,
      };
      saveVisit.pending = true;
      setSaving(true);
      try {
        await saveVisit.draft;
        requireCurrent();
        if (source === "vault") {
          if (!vaultKey || !vaultOwnerToken) throw new Error("Open your vault to continue.");
          const saved = await KaiProfileService.savePreferences({
            userId, vaultKey, vaultOwnerToken, updates: answers, mode: "onboarding",
          });
          requireCurrent();
          setProfile(saved);
        } else {
          const score = computeRiskScore(answers as PreVaultOnboardingAnswers);
          const saved = await PreVaultOnboardingService.saveDraft(userId, {
            answers, risk_score: score, risk_profile: score === null ? null : mapRiskProfile(score),
          });
          requireCurrent();
          setPreVaultState(saved);
        }
        // Preferences do not complete Finance or root setup. The portfolio
        // source's existing explicit terminal still owns that transition.
        const journey = await PreVaultUserStateService.bootstrapState(userId, { force: true });
        requireCurrent();
        if (!canActivateFinanceSetup(journey)) throw new Error("Another setup is active. Return to setup to continue Finance.");
        await PreVaultUserStateService.syncOnboardingJourney({
          userId, phase: "capability_setup", activeCapability: "finance", callbackState: "none",
          expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
        });
        requireCurrent();
        setOnboardingRequiredCookie(true);
        setOnboardingFlowActiveCookie(true);
        trackEvent("onboarding_step_completed", { action: "preferences", result: "success" });
        router.replace(ROUTES.ONE_SETUP_FINANCE_IMPORT);
      } catch (error) {
        if (current()) {
          trackEvent("onboarding_step_completed", { action: "preferences", result: "error" });
          toast.error(error instanceof Error && error.message.startsWith("Another setup")
            ? error.message : "Couldn't save preferences and continue. Please retry.");
        }
        throw error;
      } finally {
        saveVisit.pending = false;
        if (current()) setSaving(false);
      }
    },
  });
  usePublishVoiceSurfaceMetadata(
    stage === "wizard" && (!isStaticFinanceSetupRoute || financeSetupCoordinator.isReady) ? {
      screenId: "one_setup_finance",
      title: "Finance investment preferences",
      purpose: "Choose your preferences, then continue to portfolio import.",
      actions: [
        { id: "answer_horizon", actionId: "kai.setup.answer_horizon", label: "Investment horizon", purpose: "Choose how long you expect to stay invested." },
        { id: "answer_drawdown", actionId: "kai.setup.answer_drawdown", label: "Drawdown response", purpose: "Choose how you would react to a 20 percent drop." },
        { id: "answer_volatility", actionId: "kai.setup.answer_volatility", label: "Volatility preference", purpose: "Choose how much volatility feels comfortable." },
        { id: "launch_dashboard", actionId: "kai.setup.launch_dashboard", label: "Continue", purpose: "Save preferences and choose a portfolio source." },
      ],
    } : null,
    { role: voicePublisherRole },
  );

  if (
    authLoading ||
    (isStaticFinanceSetupRoute && !financeSetupCoordinator.isReady)
  ) {
    // No SetupKaiStageRegion here. SetupCapabilityLoading is already a
    // FullscreenFlowShell, and .fullscreen-flow-shell (globals.css) already sets
    // min-height:calc(100dvh - var(--app-fullscreen-flow-content-offset)) and
    // padding-bottom:var(--app-screen-footer-pad). Wrapping it in a region that
    // claims the viewport AND the footer pad again applied both twice down one
    // branch, so the first screen of Finance setup -- a spinner and one line of
    // text -- could be scrolled about 90px into nothing.
    //
    // The other branches below keep the region: they render plain content that
    // does need it.
    return <SetupCapabilityLoading label="Preparing Finance setup…" />;
  }

  if (!user || !userId) {
    return (
      <SetupKaiStageRegion>
        <HushhLoader label="Redirecting..." variant="inline" />
      </SetupKaiStageRegion>
    );
  }

  if (inviteToken) {
    return (
      <>
        <NativeTestBeacon
          routeId={ROUTES.ONE_SETUP_KAI}
          marker="native-route-one-setup-kai"
          authState={user ? "authenticated" : "pending"}
          dataState="loaded"
        />
        <KaiInviteHandshake inviteToken={inviteToken} />
      </>
    );
  }

  if (loadError) {
    return (
      <SetupKaiStageRegion>
        <NativeTestBeacon
          routeId={ROUTES.ONE_SETUP_KAI}
          marker="native-route-one-setup-kai"
          authState={user ? "authenticated" : "pending"}
          dataState="unavailable-valid"
          errorCode="one_setup"
          errorMessage={loadError}
        />
        <Card
          preset="default"
          effect="glass"
          glassAccent="soft"
          className="w-full max-w-sm text-center"
        >
          <div className="flex flex-col items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500/12 to-orange-500/12 dark:from-red-400/16 dark:to-orange-400/16">
              <AlertTriangle className="h-7 w-7 text-red-500 dark:text-red-400" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold tracking-tight">
                Couldn&apos;t load onboarding
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {loadError}
              </p>
            </div>
            <Button
              variant="blue-gradient"
              effect="fill"
              size="sm"
              onClick={() => setRetryNonce((value) => value + 1)}
            >
              Retry
            </Button>
          </div>
        </Card>
      </SetupKaiStageRegion>
    );
  }

  if (stage === "vault_required") {
    return (
      <SetupKaiStageRegion>
        <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
          <p className="text-sm text-muted-foreground">
            Open your private vault to continue Finance setup.
          </p>
          <Button
            variant="blue-gradient"
            effect="fill"
            onClick={() => setVaultOpen(true)}
          >
            Open private vault
          </Button>
          {isStaticFinanceSetupRoute ? (
            <SetupCapabilityTerminalFooter
              capabilityId="finance"
              isOperationallyReady={false}
              coordinator={financeSetupCoordinator}
              supportingText="You can return any time."
            />
          ) : null}
        </div>
        <VaultUnlockDialog
          user={user}
          open={vaultOpen}
          onOpenChange={setVaultOpen}
          title="Open your private vault"
          description="Continue Finance setup after your private vault is ready."
          allowVaultCreation={false}
          onSuccess={() => setVaultOpen(false)}
        />
      </SetupKaiStageRegion>
    );
  }

  if (stage === "loading" || !source) {
    return (
      <SetupKaiStageRegion>
        <HushhLoader label="Loading onboarding..." variant="inline" />
      </SetupKaiStageRegion>
    );
  }

  if (stage === "entry") {
    // The legacy entry hub is superseded by the `/one/setup` capability hub.
    // load() redirects before reaching this stage; this guard renders a loader
    // and re-issues the redirect to cover any residual `entry` state.
    if (typeof window !== "undefined") {
      router.replace(buildOneSetupRoute({ from: onboardingFromHref }));
    }
    return (
      <SetupKaiStageRegion>
        <HushhLoader label="Loading setup..." variant="inline" />
      </SetupKaiStageRegion>
    );
  }

  return (
    <>
      <NativeTestBeacon
        routeId={ROUTES.ONE_SETUP_KAI}
        marker="native-route-one-setup-kai"
        authState={user ? "authenticated" : "pending"}
        dataState="loaded"
      />
        <KaiPreferencesWizard
          mode="onboarding"
          layout="page"
          controller={wizard}
          onComplete={() => undefined}
          terminalFooter={
            isStaticFinanceSetupRoute ? (
              <SetupCapabilityTerminalFooter
                capabilityId="finance"
                isOperationallyReady={false}
                coordinator={financeSetupCoordinator}
                supportingText="You can return any time."
              />
            ) : null
          }

        />
    </>
  );
}

export default function KaiOnboardingPage({
  voicePublisherRole = "route",
}: {
  voicePublisherRole?: VoiceSurfacePublisherRole;
} = {}) {
  return (
    <Suspense
      fallback={
        <SetupKaiStageRegion>
          <HushhLoader label="Loading onboarding..." variant="inline" />
        </SetupKaiStageRegion>
      }
    >
      <KaiOnboardingPageContent voicePublisherRole={voicePublisherRole} />
    </Suspense>
  );
}
