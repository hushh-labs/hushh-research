"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { KaiPersonaScreen } from "@/components/kai/onboarding/KaiPersonaScreen";
import { KaiPreferencesWizard } from "@/components/kai/onboarding/KaiPreferencesWizard";
import { KaiInviteHandshake } from "@/components/kai/onboarding/kai-invite-handshake";
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
import { VaultService } from "@/lib/services/vault-service";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { usePersonaState } from "@/lib/persona/persona-context";
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
import { trackGrowthFunnelStepCompleted } from "@/lib/observability/growth";
import { Card } from "@/lib/morphy-ux/card";
import { Button } from "@/lib/morphy-ux/button";
import { AlertTriangle } from "lucide-react";
import { useNativeTestConfig } from "@/lib/testing/native-test";

type Stage = "loading" | "entry" | "wizard" | "persona";
type OnboardingSource = "pre_vault" | "vault";

type WizardAnswers = {
  investment_horizon: InvestmentHorizon | null;
  drawdown_response: DrawdownResponse | null;
  volatility_preference: VolatilityPreference | null;
};

function buildRouteWithFrom(pathname: string, from: string): string {
  const params = new URLSearchParams();
  params.set("from", from);
  return `${pathname}?${params.toString()}`;
}

function profileToAnswers(profile: KaiProfileV2 | null): WizardAnswers {
  return {
    investment_horizon: profile?.preferences.investment_horizon ?? null,
    drawdown_response: profile?.preferences.drawdown_response ?? null,
    volatility_preference: profile?.preferences.volatility_preference ?? null,
  };
}

function pendingToAnswers(pending: PreVaultOnboardingState | null): WizardAnswers {
  return {
    investment_horizon: pending?.answers.investment_horizon ?? null,
    drawdown_response: pending?.answers.drawdown_response ?? null,
    volatility_preference: pending?.answers.volatility_preference ?? null,
  };
}

function computePersona(answers: WizardAnswers, explicit?: RiskProfile | null): RiskProfile {
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

function KaiOnboardingPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nativeTestConfig = useNativeTestConfig();
  const { user, loading: authLoading } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const { activePersona, loading: personaLoading, riaCapability } = usePersonaState();

  const [source, setSource] = useState<OnboardingSource | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<KaiProfileV2 | null>(null);
  const [preVaultState, setPreVaultState] = useState<PreVaultOnboardingState | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const onboardingStartedRef = useRef(false);
  const inviteToken = searchParams.get("invite");
  const onboardingFromHref = useMemo(
    () => normalizeInternalRouteHref(searchParams.get("from")),
    [searchParams],
  );
  // Intentional re-entry: a user who has ALREADY resolved the setup gate but
  // deliberately reopens this wizard (tapping the Finance tile, which forwards
  // with a `from` marker, or an explicit `edit=1`) must land ON the
  // questionnaire to review/edit their answers, NOT be bounced to the `/one/setup`
  // hub. Without this, finance "Unlock & continue" dead-loops back to the hub.
  // First-run gating (unresolved users) is unchanged.
  const wizardReentryRequested = useMemo(
    () => onboardingFromHref !== null || searchParams.get("edit") === "1",
    [onboardingFromHref, searchParams],
  );
  const onboardingSelfHref = useMemo(
    () => buildOneSetupKaiRoute({ from: onboardingFromHref, invite: inviteToken }),
    [inviteToken, onboardingFromHref],
  );
  const preserveOnboardingAuditRoute =
    nativeTestConfig.enabled &&
    nativeTestConfig.expectedRoute === ROUTES.ONE_SETUP_KAI;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (authLoading || personaLoading) return;

      if (!user) {
        router.replace(`${ROUTES.LOGIN}?redirect=${encodeURIComponent(onboardingSelfHref)}`);
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
          const remoteState = await PreVaultUserStateService.bootstrapState(user.uid);
          if (cancelled) return;

          const onboardingResolved = PreVaultUserStateService.isSetupResolved(remoteState);
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
          if (activePersona === "ria" && riaCapability !== "disabled") {
            router.replace(ROUTES.RIA_HOME);
            return;
          }
          // The investor-preferences wizard renders here when the root flow is
          // unresolved and a draft exists, OR when a resolved user intentionally
          // re-enters to review/edit their answers (finance tile / edit=1).
          // Otherwise the canonical surface is the `/one/setup` capability hub,
          // so we redirect there instead of showing the legacy entry hub.
          if ((!onboardingResolved && pending) || wizardReentryRequested) {
            setStage("wizard");
          } else {
            router.replace(buildOneSetupRoute({ from: onboardingFromHref }));
          }
          return;
        }

        setSource("vault");

        if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
          setStage("loading");
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
          void PreVaultUserStateService.syncKaiSetupState({
            userId: user.uid,
            completed: true,
            skipped: completion.skippedPreferences,
            completedAt: completion.completedAt,
          }).catch((syncError) => {
            console.warn("[OneOnboardingPage] Failed vault->remote onboarding bridge:", syncError);
          });
          setOnboardingRequiredCookie(false);
          setOnboardingFlowActiveCookie(false);
          // Onboarding is complete. A user who intentionally re-enters to edit
          // their preferences (finance tile / edit=1) stays on the questionnaire,
          // pre-filled from the saved profile. Everyone else returns to the
          // canonical `/one/setup` hub rather than the legacy entry screen.
          if (wizardReentryRequested) {
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
    activePersona,
    inviteToken,
    personaLoading,
    riaCapability,
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
  ]);

  const wizardAnswers: WizardAnswers = useMemo(() => {
    if (source === "vault") return profileToAnswers(profile);
    return pendingToAnswers(preVaultState);
  }, [source, profile, preVaultState]);

  const persona: RiskProfile = useMemo(() => {
    if (source === "vault") {
      return computePersona(wizardAnswers, profile?.preferences.risk_profile ?? null);
    }
    return computePersona(wizardAnswers, preVaultState?.risk_profile ?? null);
  }, [source, wizardAnswers, profile?.preferences.risk_profile, preVaultState?.risk_profile]);

  useEffect(() => {
    if (!source || stage !== "wizard" || onboardingStartedRef.current) return;
    onboardingStartedRef.current = true;
    trackEvent("onboarding_started", {
      source,
    });
  }, [source, stage]);

  if (authLoading) {
    return (
      <SetupKaiStageRegion>
        <HushhLoader label="Loading onboarding..." variant="inline" />
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
          onLaunchDashboard={async () => {
          if (saving) return;

          try {
            setSaving(true);
            const riskScore = computeRiskScore(wizardAnswers as PreVaultOnboardingAnswers);

            if (source === "vault") {
              if (!vaultKey || !vaultOwnerToken) {
                toast.error("Unlock your vault to continue.");
                return;
              }
              const nextProfile = await KaiProfileService.setOnboardingCompleted({
                userId: user.uid,
                vaultKey,
                vaultOwnerToken,
                skippedPreferences: false,
              });
              // Await the server pre-vault sync BEFORE navigating (same rationale
              // as the skip path) so the One gate is authoritative server-side the
              // instant the user leaves onboarding. Error-swallowed to stay
              // fail-open; vault profile remains the unlocked-path source.
              await PreVaultUserStateService.syncKaiSetupState({
                userId: user.uid,
                completed: true,
                skipped: false,
                completedAt: nextProfile.setup.completed_at,
              }).catch((syncError) => {
                console.warn(
                  "[OneOnboardingPage] Failed vault->remote onboarding bridge after completion:",
                  syncError
                );
              });
              setProfile(nextProfile);
            } else {
              const completedAt = Date.now();
              await PreVaultUserStateService.updatePreVaultState(user.uid, {
                setupCompleted: true,
                setupSkipped: false,
                setupCompletedAt: completedAt,
              });
              await PreVaultOnboardingService.markCompleted(user.uid, {
                skipped: false,
                answers: wizardAnswers,
                risk_score: riskScore,
                risk_profile: persona,
              }).catch(() => null);
              setPreVaultState((current) => {
                if (!current) return current;
                return {
                  ...current,
                  completed: true,
                  skipped: false,
                };
              });
            }

            toast.success("Preferences saved. Next step: connect your portfolio or Plaid.");
            setOnboardingRequiredCookie(false);
            setOnboardingFlowActiveCookie(true);
            trackEvent("onboarding_completed", {
              action: "complete",
              result: "success",
            });
            trackGrowthFunnelStepCompleted({
              journey: "investor",
              step: "onboarding_completed",
              dedupeKey: "growth:investor:onboarding_completed:complete",
              dedupeWindowMs: 5_000,
            });
            router.replace(buildRouteWithFrom(ROUTES.KAI_IMPORT, onboardingSelfHref));
          } catch (error) {
            console.error("[OneOnboardingPage] Failed to finalize onboarding:", error);
            trackEvent("onboarding_completed", {
              action: "complete",
              result: "error",
            });
            toast.error("Couldn't complete onboarding. Please retry.");
          } finally {
            setSaving(false);
          }
          }}
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
      <KaiPreferencesWizard
        mode="onboarding"
        layout="page"
        initialStep={0}
        initialAnswers={wizardAnswers}
        // Backing out of the investor-preferences sub-step returns to the One
        // setup hub at /one/setup so the user resumes the main onboarding. It
        // must NOT mark the root onboarding skipped: only the hub-level "Not now"
        // control does that. (The wizard's own intra-step Skip control is
        // intentionally not wired here so a sub-step can't satisfy/skip the root
        // flow.)
        onBack={() => router.replace(buildOneSetupRoute({ from: onboardingFromHref }))}
        onAnswersChange={(nextAnswers) => {
        if (source !== "pre_vault") return;
        const score = computeRiskScore(nextAnswers as PreVaultOnboardingAnswers);
        void PreVaultOnboardingService.saveDraft(user.uid, {
          answers: nextAnswers,
          risk_score: score,
          risk_profile: score === null ? null : mapRiskProfile(score),
        })
          .then((nextState) => {
            setPreVaultState(nextState);
          })
          .catch((error) => {
            console.warn("[OneOnboardingPage] Failed to save pre-vault onboarding draft:", error);
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
              toast.error("Unlock your vault to continue.");
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
            const score = computeRiskScore(nextAnswers as PreVaultOnboardingAnswers);
            const nextState = await PreVaultOnboardingService.saveDraft(user.uid, {
              answers: nextAnswers,
              risk_score: score,
              risk_profile: score === null ? null : mapRiskProfile(score),
            });
            setPreVaultState(nextState);
          }

          setStage("persona");
          trackEvent("onboarding_step_completed", {
            action: "preferences",
            result: "success",
          });
        } catch (error) {
          console.error("[OneOnboardingPage] Failed to save preferences:", error);
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
    </>
  );
}

export default function KaiOnboardingPage() {
  return (
    <Suspense
      fallback={
        <SetupKaiStageRegion>
          <HushhLoader label="Loading onboarding..." variant="inline" />
        </SetupKaiStageRegion>
      }
    >
      <KaiOnboardingPageContent />
    </Suspense>
  );
}
