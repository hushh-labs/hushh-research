"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { KaiPersonaScreen } from "@/components/kai/onboarding/KaiPersonaScreen";
import { KaiPreferencesWizard } from "@/components/kai/onboarding/KaiPreferencesWizard";
import { KaiInviteHandshake } from "@/components/kai/onboarding/kai-invite-handshake";
import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import {
  usePublishVoiceSurfaceMetadata,
  type VoiceSurfacePublisherRole,
} from "@/lib/voice/voice-surface-metadata";
import {
  KaiProfileService,
  computeRiskScore,
  mapRiskProfile,
  resolveKaiOnboardingCompletion,
  type KaiProfileV2,
  type RiskProfile,
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
import { AlertTriangle } from "lucide-react";
import { useNativeTestConfig } from "@/lib/testing/native-test";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

type Stage = "loading" | "vault_required" | "entry" | "wizard" | "persona";
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

function computePersona(
  answers: WizardAnswers,
  explicit?: RiskProfile | null,
): RiskProfile {
  if (explicit) return explicit;
  const score = computeRiskScore(answers as PreVaultOnboardingAnswers);
  return score === null ? "balanced" : mapRiskProfile(score);
}

/**
 * Full-height region for the wizard's transient stages (loading, redirect,
 * error). The TopAppBar stays visible in this flow, so these stages must START
 * below the top shell + safe-area inset just like the questionnaire/persona
 * stages do. `--top-content-pad` folds in `env(safe-area-inset-top)`, the
 * shell's reserved height, and the sub-nav gap; `--app-screen-footer-pad`
 * mirrors the bottom inset. Centering happens INSIDE this padded box so the
 * loader text can never tuck under the top bar on notched devices.
 */
function SetupKaiStageRegion({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center justify-center px-5 pt-[var(--top-content-pad)] pb-[var(--app-screen-footer-pad)]">
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
  const { user, loading: authLoading } = useAuth();
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

      try {
        setLoadError(null);
        setStage("loading");

        const hasVault = await VaultService.checkVault(user.uid);
        if (cancelled) return;

        if (!hasVault) {
          setSource("pre_vault");
          const remoteState = await PreVaultUserStateService.bootstrapState(
            user.uid,
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

          const pending = await PreVaultOnboardingService.load(user.uid);
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
          const pending = await PreVaultOnboardingService.load(user.uid);
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
          userId: user.uid,
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
            user.uid,
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
    user?.uid,
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

  const persona: RiskProfile = useMemo(() => {
    if (source === "vault") {
      return computePersona(
        wizardAnswers,
        profile?.preferences.risk_profile ?? null,
      );
    }
    return computePersona(wizardAnswers, preVaultState?.risk_profile ?? null);
  }, [
    source,
    wizardAnswers,
    profile?.preferences.risk_profile,
    preVaultState?.risk_profile,
  ]);

  useEffect(() => {
    if (!source || stage !== "wizard" || onboardingStartedRef.current) return;
    onboardingStartedRef.current = true;
    trackEvent("onboarding_started", {
      source,
    });
  }, [source, stage]);

  const handleLaunchDashboard = async () => {
    if (saving || !user) {
      return {
        status: "blocked" as const,
        summary: "Finance setup is not ready to finish yet.",
      };
    }

    try {
      setSaving(true);
      // Preferences are only the first Finance checkpoint. Continue into the
      // existing portfolio-source choice; the explicit terminal Finance step
      // marks the capability complete after Plaid, statement, or "later" settles.
      const journey = await PreVaultUserStateService.bootstrapState(user.uid, {
        force: true,
      });
      if (!canActivateFinanceSetup(journey)) {
        router.replace(ROUTES.ONE_SETUP);
        return {
          status: "blocked" as const,
          summary: "Finance is no longer the active setup. Returning to setup.",
          routeAfter: ROUTES.ONE_SETUP,
        };
      }
      await PreVaultUserStateService.syncOnboardingJourney({
        userId: user.uid,
        phase: "capability_setup",
        activeCapability: "finance",
        callbackState: "none",
        expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
      });
      toast.success(
        "Finance preferences saved. Choose how to add your portfolio.",
      );
      setOnboardingRequiredCookie(true);
      setOnboardingFlowActiveCookie(true);
      trackEvent("onboarding_step_completed", {
        action: "preferences",
        result: "success",
      });
      router.replace(ROUTES.ONE_SETUP_FINANCE_IMPORT);
      return {
        status: "started" as const,
        summary:
          "Finance preferences saved. Choose Plaid, a statement, or later.",
        routeAfter: ROUTES.ONE_SETUP_FINANCE_IMPORT,
      };
    } catch (error) {
      console.error(
        "[OneOnboardingPage] Failed to finalize onboarding:",
        error,
      );
      trackEvent("onboarding_completed", {
        action: "complete",
        result: "error",
      });
      toast.error("Couldn't complete onboarding. Please retry.");
      return {
        status: "failed" as const,
        summary:
          "Finance preferences could not be finalized. Please try again.",
      };
    } finally {
      setSaving(false);
    }
  };

  // Voice parity: "launch my dashboard" drives the exact same completion
  // flow as tapping the persona screen's Continue Finance Setup button. Registered
  // unconditionally (not just while stage === "persona") to satisfy Rules of
  // Hooks; the handler itself is a no-op unless a user session exists.
  useLocalOnboardingActionHandler("kai.setup.launch_dashboard", async () => {
    if (!user) {
      return { status: "blocked", summary: "Sign in to finish Finance setup." };
    }
    if (stage !== "persona") {
      return {
        status: "blocked",
        summary: "Answer all three questions first.",
      };
    }
    return handleLaunchDashboard();
  });
  // Publish the screen id the generated action contract expects
  // (kai_setup_wizard) so voice grounding and reachability checks resolve
  // against the same screen the wizard/persona actions declare, overriding
  // the route-derived default of "one_setup" for this sub-route.
  usePublishVoiceSurfaceMetadata(
    stage === "wizard" || stage === "persona"
      ? {
          screenId: "one_setup_finance",
          title: "Finance investor preferences",
          purpose:
            stage === "wizard"
              ? "Three quick questions tune One to your investing style."
              : "Review your computed investor persona and launch the dashboard.",
          actions:
            stage === "wizard"
              ? [
                  {
                    id: "answer_horizon",
                    actionId: "kai.setup.answer_horizon",
                    label: "Investment horizon",
                    purpose: "Answer how long you expect to stay invested.",
                  },
                  {
                    id: "answer_drawdown",
                    actionId: "kai.setup.answer_drawdown",
                    label: "Drawdown response",
                    purpose: "Answer how you'd react to a 20 percent drop.",
                  },
                  {
                    id: "answer_volatility",
                    actionId: "kai.setup.answer_volatility",
                    label: "Volatility preference",
                    purpose: "Answer how much volatility feels comfortable.",
                  },
                ]
              : [
                  {
                    id: "launch_dashboard",
                    actionId: "kai.setup.launch_dashboard",
                    label: "Continue Finance Setup",
                    purpose: "Save preferences and choose a portfolio source.",
                  },
                ],
        }
      : null,
    { role: voicePublisherRole },
  );

  if (
    authLoading ||
    (isStaticFinanceSetupRoute && !financeSetupCoordinator.isReady)
  ) {
    return (
      <SetupKaiStageRegion>
        <SetupCapabilityLoading label="Preparing Finance setup…" />
      </SetupKaiStageRegion>
    );
  }

  if (!user) {
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

  if (stage === "persona") {
    return (
      <>
        <NativeTestBeacon
          routeId={ROUTES.ONE_SETUP_KAI}
          marker="native-route-one-setup-kai"
          authState={user ? "authenticated" : "pending"}
          dataState="loaded"
        />
        <KaiPersonaScreen
          riskProfile={persona}
          onEditAnswers={() => setStage("wizard")}
          onLaunchDashboard={handleLaunchDashboard}
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

  return (
    <>
      <NativeTestBeacon
        routeId={ROUTES.ONE_SETUP_KAI}
        marker="native-route-one-setup-kai"
        authState={user ? "authenticated" : "pending"}
        dataState="loaded"
      />
      <CapabilityCinematicIntroGate capabilityId="finance">
        <KaiPreferencesWizard
          mode="onboarding"
          layout="page"
          initialStep={0}
          initialAnswers={wizardAnswers}
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
          // Back returns to the hub but retains the active task. Only the
          // explicit terminal Skip action may clear it.
          onBack={() => {
            if (user && isStaticFinanceSetupRoute) {
              router.replace(ROUTES.ONE_SETUP);
              return;
            }
            router.replace(buildOneSetupRoute({ from: onboardingFromHref }));
          }}
          onAnswersChange={(nextAnswers) => {
            if (source !== "pre_vault") return;
            const score = computeRiskScore(
              nextAnswers as PreVaultOnboardingAnswers,
            );
            void PreVaultOnboardingService.saveDraft(user.uid, {
              answers: nextAnswers,
              risk_score: score,
              risk_profile: score === null ? null : mapRiskProfile(score),
            })
              .then((nextState) => {
                setPreVaultState(nextState);
              })
              .catch((error) => {
                console.warn(
                  "[OneOnboardingPage] Failed to save pre-vault onboarding draft:",
                  error,
                );
              });
          }}
          onComplete={async (payload) => {
            if (saving) return;
            const nextAnswers: WizardAnswers = {
              investment_horizon: payload.investment_horizon,
              drawdown_response: payload.drawdown_response,
              volatility_preference: payload.volatility_preference,
            };

            try {
              setSaving(true);

              if (source === "vault") {
                if (!vaultKey || !vaultOwnerToken) {
                  toast.error("Set up or open your private vault to continue.");
                  return;
                }

                const nextProfile = await KaiProfileService.savePreferences({
                  userId: user.uid,
                  vaultKey,
                  vaultOwnerToken,
                  updates: nextAnswers,
                  mode: "onboarding",
                });
                setProfile(nextProfile);
              } else {
                const score = computeRiskScore(
                  nextAnswers as PreVaultOnboardingAnswers,
                );
                const nextState = await PreVaultOnboardingService.saveDraft(
                  user.uid,
                  {
                    answers: nextAnswers,
                    risk_score: score,
                    risk_profile: score === null ? null : mapRiskProfile(score),
                  },
                );
                setPreVaultState(nextState);
              }

              setStage("persona");
              trackEvent("onboarding_step_completed", {
                action: "preferences",
                result: "success",
              });
            } catch (error) {
              console.error(
                "[OneOnboardingPage] Failed to save preferences:",
                error,
              );
              trackEvent("onboarding_step_completed", {
                action: "preferences",
                result: "error",
              });
              toast.error("Couldn't save preferences. Please retry.");
            } finally {
              setSaving(false);
            }
          }}
        />
      </CapabilityCinematicIntroGate>
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
