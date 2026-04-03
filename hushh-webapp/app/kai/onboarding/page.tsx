"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
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
import { ROUTES } from "@/lib/navigation/routes";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { trackEvent } from "@/lib/observability/client";
import { Card } from "@/lib/morphy-ux/card";
import { useNativeTestConfig } from "@/lib/testing/native-test";

type Stage = "loading" | "entry" | "wizard" | "persona";
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

function KaiOnboardingPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nativeTestConfig = useNativeTestConfig();
  const { user, loading: authLoading } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const { activePersona, loading: personaLoading, riaCapability, switchPersona } = usePersonaState();

  const [source, setSource] = useState<OnboardingSource | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<KaiProfileV2 | null>(null);
  const [preVaultState, setPreVaultState] = useState<PreVaultOnboardingState | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const onboardingStartedRef = useRef(false);
  const inviteToken = searchParams.get("invite");
  const preserveOnboardingAuditRoute =
    nativeTestConfig.enabled &&
    nativeTestConfig.expectedRoute === ROUTES.KAI_ONBOARDING;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (authLoading || personaLoading) return;

      if (!user) {
        router.replace("/login?redirect=%2Fkai%2Fonboarding");
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

          if (PreVaultUserStateService.isOnboardingResolved(remoteState)) {
            setOnboardingRequiredCookie(false);
            setOnboardingFlowActiveCookie(false);
            if (!preserveOnboardingAuditRoute) {
              router.replace("/kai");
              return;
            }
          }

          setOnboardingRequiredCookie(true);
          setOnboardingFlowActiveCookie(false);

          const pending = await PreVaultOnboardingService.load(user.uid);
          if (cancelled) return;
          setPreVaultState(pending);
          if (activePersona === "ria" && riaCapability !== "disabled") {
            router.replace(ROUTES.RIA_HOME);
            return;
          }
          // Always start from the questionnaire flow on reload until onboarding is completed.
          // We keep draft answers, but do not auto-jump to persona.
          setStage(pending ? "wizard" : "entry");
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
          void PreVaultUserStateService.syncKaiOnboardingState({
            userId: user.uid,
            completed: true,
            skipped: completion.skippedPreferences,
            completedAt: completion.completedAt,
          }).catch((syncError) => {
            console.warn("[KaiOnboardingPage] Failed vault->remote onboarding bridge:", syncError);
          });
          setOnboardingRequiredCookie(false);
          setOnboardingFlowActiveCookie(false);
          if (!preserveOnboardingAuditRoute) {
            router.replace("/kai");
            return;
          }
        }

        setOnboardingRequiredCookie(true);
        setOnboardingFlowActiveCookie(false);
        // Always return to the questionnaire until the onboarding completion flag is set.
        setStage("wizard");
      } catch (error) {
        console.warn("[KaiOnboardingPage] Failed to load onboarding:", error);
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
    return <HushhLoader label="Loading onboarding..." variant="fullscreen" />;
  }

  if (!user) {
    return <HushhLoader label="Redirecting..." variant="fullscreen" />;
  }

  if (inviteToken) {
    return (
      <>
        <NativeTestBeacon
          routeId="/kai/onboarding"
          marker="native-route-kai-onboarding"
          authState={user ? "authenticated" : "pending"}
          dataState="loaded"
        />
        <KaiInviteHandshake inviteToken={inviteToken} />
      </>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center px-5">
        <NativeTestBeacon
          routeId="/kai/onboarding"
          marker="native-route-kai-onboarding"
          authState={user ? "authenticated" : "pending"}
          dataState="unavailable-valid"
          errorCode="kai_onboarding"
          errorMessage={loadError}
        />
        <div className="w-full rounded-2xl border border-border bg-card/80 p-5 text-center">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <button
            type="button"
            className="mt-3 inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (stage === "loading" || !source) {
    return <HushhLoader label="Loading onboarding..." variant="fullscreen" />;
  }

  if (stage === "entry") {
    return (
      <div
        data-top-content-anchor="true"
        className="mx-auto flex min-h-[calc(100dvh-var(--app-fullscreen-flow-content-offset,0px))] w-full max-w-4xl items-start px-5 pb-8 pt-[var(--app-fullscreen-flow-content-offset)]"
      >
        <NativeTestBeacon
          routeId="/kai/onboarding"
          marker="native-route-kai-onboarding"
          authState={user ? "authenticated" : "pending"}
          dataState="loaded"
        />
        <div className="w-full space-y-6">
          <div className="text-center space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/80">
              Choose your starting path
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Start as an investor or set up RIA first
            </h1>
            <p className="mx-auto max-w-2xl text-sm leading-7 text-muted-foreground">
              You can add the other profile later from Profile. This choice only sets the first
              workflow we open right now.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card
              preset="hero"
              variant="none"
              effect="glass"
              showRipple
              interactive={!saving}
              className="transition-[border-color,background-color,box-shadow] enabled:hover:!border-primary/40"
            >
              <button
                type="button"
                disabled={saving}
                onClick={async () => {
                  if (saving) return;
                  try {
                    setSaving(true);
                    const nextState =
                      preVaultState || (await PreVaultOnboardingService.saveDraft(user.uid, {}));
                    setPreVaultState(nextState);
                    setStage("wizard");
                    trackEvent("onboarding_step_completed", {
                      action: "persona",
                      result: "success",
                    });
                  } catch (error) {
                    console.error("[KaiOnboardingPage] Failed to start investor onboarding:", error);
                    trackEvent("onboarding_step_completed", {
                      action: "persona",
                      result: "error",
                    });
                    toast.error("Couldn't start investor onboarding. Please retry.");
                  } finally {
                    setSaving(false);
                  }
                }}
                className="w-full p-6 text-left"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary/80">
                  Investor
                </p>
                <h2 className="mt-3 text-2xl font-semibold text-foreground">
                  Build your Kai profile first
                </h2>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">
                  Answer your risk and preference questions, then connect accounts and start using
                  Kai.
                </p>
              </button>
            </Card>

            <Card
              preset="hero"
              variant="none"
              effect="glass"
              showRipple
              interactive={!saving && riaCapability !== "disabled"}
              className="transition-[border-color,background-color,box-shadow] enabled:hover:!border-primary/40 disabled:opacity-60"
            >
              <button
                type="button"
                disabled={saving || riaCapability === "disabled"}
                onClick={async () => {
                  if (saving || riaCapability === "disabled") return;
                  try {
                    setSaving(true);
                    await switchPersona("ria");
                    trackEvent("onboarding_step_completed", {
                      action: "persona",
                      result: "success",
                    });
                    router.replace(ROUTES.RIA_HOME);
                  } catch (error) {
                    console.error("[KaiOnboardingPage] Failed to enter RIA setup:", error);
                    trackEvent("onboarding_step_completed", {
                      action: "persona",
                      result: "error",
                    });
                    toast.error("Couldn't enter RIA setup. Please retry.");
                  } finally {
                    setSaving(false);
                  }
                }}
                className="w-full p-6 text-left disabled:cursor-not-allowed"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary/80">
                  RIA
                </p>
                <h2 className="mt-3 text-2xl font-semibold text-foreground">
                  Verify the advisor workspace
                </h2>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">
                  Set up your advisor identity, verification, firm details, and marketplace trust
                  profile before sending consent requests.
                </p>
                {riaCapability === "disabled" ? (
                  <p className="mt-4 text-xs font-medium text-muted-foreground">
                    RIA mode is unavailable in this environment until IAM is active.
                  </p>
                ) : null}
              </button>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (stage === "persona") {
    return (
      <>
        <NativeTestBeacon
          routeId="/kai/onboarding"
          marker="native-route-kai-onboarding"
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
              void PreVaultUserStateService.syncKaiOnboardingState({
                userId: user.uid,
                completed: true,
                skipped: false,
                completedAt: nextProfile.onboarding.completed_at,
              }).catch((syncError) => {
                console.warn(
                  "[KaiOnboardingPage] Failed vault->remote onboarding bridge after completion:",
                  syncError
                );
              });
              setProfile(nextProfile);
            } else {
              const completedAt = Date.now();
              await PreVaultUserStateService.updatePreVaultState(user.uid, {
                preOnboardingCompleted: true,
                preOnboardingSkipped: false,
                preOnboardingCompletedAt: completedAt,
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
            router.replace("/kai/import");
          } catch (error) {
            console.error("[KaiOnboardingPage] Failed to finalize onboarding:", error);
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
        routeId="/kai/onboarding"
        marker="native-route-kai-onboarding"
        authState={user ? "authenticated" : "pending"}
        dataState="loaded"
      />
      <KaiPreferencesWizard
        mode="onboarding"
        layout="page"
        initialStep={0}
        initialAnswers={wizardAnswers}
        onBack={() => router.replace("/kai")}
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
            console.warn("[KaiOnboardingPage] Failed to save pre-vault onboarding draft:", error);
          });
      }}
      onSkip={async () => {
        if (saving) return;

        try {
          setSaving(true);
          if (source === "vault") {
            if (!vaultKey || !vaultOwnerToken) {
              toast.error("Unlock your vault to continue.");
              return;
            }
            const nextProfile = await KaiProfileService.setOnboardingCompleted({
              userId: user.uid,
              vaultKey,
              vaultOwnerToken,
              skippedPreferences: true,
            });
            void PreVaultUserStateService.syncKaiOnboardingState({
              userId: user.uid,
              completed: true,
              skipped: true,
              completedAt: nextProfile.onboarding.completed_at,
            }).catch((syncError) => {
              console.warn(
                "[KaiOnboardingPage] Failed vault->remote onboarding bridge after skip:",
                syncError
              );
            });
            setProfile(nextProfile);
          } else {
            const completedAt = Date.now();
            await PreVaultUserStateService.updatePreVaultState(user.uid, {
              preOnboardingCompleted: true,
              preOnboardingSkipped: true,
              preOnboardingCompletedAt: completedAt,
            });
            const nextState = await PreVaultOnboardingService.markCompleted(user.uid, {
              skipped: true,
              answers: wizardAnswers,
              risk_score: preVaultState?.risk_score ?? null,
              risk_profile: preVaultState?.risk_profile ?? null,
            });
            setPreVaultState(nextState);
          }

          toast.info("Preferences skipped. You can edit them later.");
          setOnboardingRequiredCookie(false);
          setOnboardingFlowActiveCookie(false);
          trackEvent("onboarding_completed", {
            action: "skip",
            result: "success",
          });
          router.replace("/kai");
        } catch (error) {
          console.error("[KaiOnboardingPage] Skip failed:", error);
          trackEvent("onboarding_completed", {
            action: "skip",
            result: "error",
          });
          toast.error("Couldn't skip onboarding. Please retry.");
        } finally {
          setSaving(false);
        }
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
          console.error("[KaiOnboardingPage] Failed to save preferences:", error);
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
    <Suspense fallback={<HushhLoader label="Loading onboarding..." variant="fullscreen" />}>
      <KaiOnboardingPageContent />
    </Suspense>
  );
}
