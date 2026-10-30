"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  buildOneOnboardingRoute,
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
import {
  AlertTriangle,
  BrainCircuit,
  KeyRound,
  Mail,
  UserRound,
  WalletCards,
} from "lucide-react";
import { useNativeTestConfig } from "@/lib/testing/native-test";
import {
  kaiAppBodyClassName,
  kaiAppCardTitleClassName,
  kaiAppDisplayTitleClassName,
  kaiAppEyebrowClassName,
} from "@/components/kai/shared/kai-typography";

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

function SetupCard({
  eyebrow,
  title,
  description,
  actionLabel,
  icon,
  disabled = false,
  onClick,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Card
      preset="hero"
      variant="none"
      effect="glass"
      showRipple={!disabled}
      interactive={!disabled}
      className="transition-[border-color,background-color,box-shadow,transform] enabled:hover:!-translate-y-0.5 enabled:hover:!border-primary/30 disabled:opacity-60"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="flex h-full min-h-[138px] w-full flex-col justify-between gap-4 p-5 text-left disabled:cursor-not-allowed"
      >
        <span className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
            {icon}
          </span>
          <span className="min-w-0 space-y-2">
            <span className="block text-[10.5px] font-medium uppercase tracking-[0.16em] text-primary/75">
              {eyebrow}
            </span>
            <span
              role="heading"
              aria-level={2}
              className={`${kaiAppCardTitleClassName} block text-foreground`}
            >
              {title}
            </span>
            <span className="block max-w-[28rem] text-[14px] font-normal leading-[1.45] tracking-normal text-muted-foreground">
              {description}
            </span>
          </span>
        </span>
        <span className="inline-flex h-9 w-fit items-center rounded-full bg-primary px-4 text-[13.5px] font-medium text-primary-foreground shadow-[0_12px_26px_-18px_rgba(0,113,227,0.75)] disabled:bg-muted">
          {actionLabel}
        </span>
      </button>
    </Card>
  );
}

function MemoryImportComingSoonCard() {
  return (
    <Card
      preset="hero"
      variant="none"
      effect="glass"
      showRipple={false}
      className="opacity-75"
    >
      <div className="flex h-full min-h-[158px] w-full flex-col justify-between gap-4 p-5 text-left">
        <span className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
            <BrainCircuit className="h-5 w-5" />
          </span>
          <span className="min-w-0 space-y-2">
            <span className="block text-[10.5px] font-medium uppercase tracking-[0.16em] text-primary/75">
              Memory import
            </span>
            <span
              role="heading"
              aria-level={2}
              className={`${kaiAppCardTitleClassName} block text-foreground`}
            >
              Import memory
            </span>
            <span className="block max-w-[28rem] text-[14px] font-normal leading-[1.45] tracking-normal text-muted-foreground">
              Import memory as a whole from ChatGPT or Claude when this connector is ready.
            </span>
          </span>
        </span>
        <span className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            disabled
            className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 text-[13px] font-medium text-muted-foreground disabled:cursor-not-allowed"
          >
            <span className="grid h-5 w-5 place-items-center rounded-full border border-border/70 text-[10px] font-semibold">
              G
            </span>
            Continue with ChatGPT
          </button>
          <button
            type="button"
            disabled
            className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 text-[13px] font-medium text-muted-foreground disabled:cursor-not-allowed"
          >
            <span className="grid h-5 w-5 place-items-center rounded-full border border-border/70 text-[10px] font-semibold">
              C
            </span>
            Continue with Claude
          </button>
        </span>
        <span className="text-[12px] font-medium text-muted-foreground">
          Coming soon
        </span>
      </div>
    </Card>
  );
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
  const [setupAcknowledgement, setSetupAcknowledgement] = useState<"complete" | "skipped" | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const onboardingStartedRef = useRef(false);
  const inviteToken = searchParams.get("invite");
  const onboardingFromHref = useMemo(
    () => normalizeInternalRouteHref(searchParams.get("from")),
    [searchParams],
  );
  const onboardingReturnHref = onboardingFromHref || ROUTES.ONE_HOME;
  const onboardingSelfHref = useMemo(
    () => buildOneOnboardingRoute({ from: onboardingFromHref, invite: inviteToken }),
    [inviteToken, onboardingFromHref],
  );
  const preserveOnboardingAuditRoute =
    nativeTestConfig.enabled &&
    nativeTestConfig.expectedRoute === ROUTES.ONE_ONBOARDING;

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
        setSetupAcknowledgement(null);

        const hasVault = await VaultService.checkVault(user.uid);
        if (cancelled) return;

        if (!hasVault) {
          setSource("pre_vault");
          const remoteState = await PreVaultUserStateService.bootstrapState(user.uid);
          if (cancelled) return;

          const onboardingResolved = PreVaultUserStateService.isOnboardingResolved(remoteState);
          if (onboardingResolved) {
            setOnboardingRequiredCookie(false);
            setOnboardingFlowActiveCookie(false);
            setSetupAcknowledgement(remoteState.preOnboardingSkipped ? "skipped" : "complete");
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
          // Always start from the questionnaire flow on reload until onboarding is completed.
          // We keep draft answers, but do not auto-jump to persona.
          setStage(!onboardingResolved && pending ? "wizard" : "entry");
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
          setSetupAcknowledgement(completion.skippedPreferences ? "skipped" : "complete");
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
          setStage("entry");
          return;
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
    onboardingReturnHref,
    onboardingSelfHref,
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

  async function completeSetupAsSkipped(
    destination: string = onboardingReturnHref,
    options?: {
      flowActive?: boolean;
      toastMessage?: string;
    },
  ) {
    if (saving) return;
    if (!user) {
      router.replace(ROUTES.LOGIN);
      return;
    }

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

      toast.info(options?.toastMessage || "Setup skipped. You can come back anytime.");
      setOnboardingRequiredCookie(false);
      setOnboardingFlowActiveCookie(Boolean(options?.flowActive));
      setSetupAcknowledgement("skipped");
      trackEvent("onboarding_completed", {
        action: "skip",
        result: "success",
      });
      trackGrowthFunnelStepCompleted({
        journey: "investor",
        step: "onboarding_completed",
        dedupeKey: "growth:investor:onboarding_completed:skip",
        dedupeWindowMs: 5_000,
      });
      router.replace(destination);
    } catch (error) {
      console.error("[KaiOnboardingPage] Skip failed:", error);
      trackEvent("onboarding_completed", {
        action: "skip",
        result: "error",
      });
      toast.error("Couldn't skip setup. Please retry.");
    } finally {
      setSaving(false);
    }
  }

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
          routeId={ROUTES.ONE_ONBOARDING}
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
      <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center justify-center px-5">
        <NativeTestBeacon
          routeId={ROUTES.ONE_ONBOARDING}
          marker="native-route-kai-onboarding"
          authState={user ? "authenticated" : "pending"}
          dataState="unavailable-valid"
          errorCode="kai_onboarding"
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
        className="mx-auto flex min-h-[calc(100dvh_-_var(--top-content-pad))] w-full max-w-[40rem] items-start px-5 pb-8 pt-[calc(var(--top-content-pad)_+_0.25rem)] sm:px-6 lg:px-[var(--page-inline-gutter-standard)]"
      >
        <NativeTestBeacon
          routeId={ROUTES.ONE_ONBOARDING}
          marker="native-route-kai-onboarding"
          authState={user ? "authenticated" : "pending"}
          dataState="loaded"
        />
        <div className="w-full space-y-5">
          <div className="mx-auto max-w-[34rem] space-y-2.5 text-left">
            <p className={`${kaiAppEyebrowClassName} text-primary/75`}>
              Optional setup
            </p>
            {setupAcknowledgement ? (
              <span className="inline-flex h-7 w-fit items-center rounded-full border border-border/70 bg-background/70 px-3 text-[12px] font-medium text-muted-foreground">
                {setupAcknowledgement === "complete" ? "Setup acknowledged" : "Setup skipped"}
              </span>
            ) : null}
            <div
              role="heading"
              aria-level={1}
              className={`${kaiAppDisplayTitleClassName} text-foreground`}
            >
              Set up One at your pace
            </div>
            <p className={`max-w-[30rem] ${kaiAppBodyClassName} text-muted-foreground`}>
              These steps help One prepare your finance workspace. Start with one, or skip now and
              return when you are ready.
            </p>
          </div>

          <div className="mx-auto grid w-full max-w-[34rem] items-stretch gap-3.5">
            <SetupCard
              eyebrow="Preferences"
              title="Investor preferences"
              description="Answer three quick questions so Kai can tune risk, time horizon, and volatility language."
              actionLabel="Answer questions"
              icon={<UserRound className="h-5 w-5" />}
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
                  toast.error("Couldn't start investor setup. Please retry.");
                } finally {
                  setSaving(false);
                }
              }}
            />

            <SetupCard
              eyebrow="Finance"
              title="Connect portfolio"
              description="Bring in holdings when you want Kai to analyze positions, movers, and tradeoffs."
              actionLabel="Connect portfolio"
              icon={<WalletCards className="h-5 w-5" />}
              disabled={saving}
              onClick={() => {
                setOnboardingRequiredCookie(false);
                setOnboardingFlowActiveCookie(true);
                router.replace(buildRouteWithFrom(ROUTES.KAI_IMPORT, onboardingSelfHref));
              }}
            />

            <SetupCard
              eyebrow="Memory"
              title="Gmail receipts"
              description="Connect receipts so One can remember purchase context and saved financial details."
              actionLabel="Set up Gmail"
              icon={<Mail className="h-5 w-5" />}
              disabled={saving}
              onClick={() => {
                setOnboardingRequiredCookie(false);
                setOnboardingFlowActiveCookie(false);
                router.replace(buildRouteWithFrom(ROUTES.GMAIL, onboardingSelfHref));
              }}
            />

            <SetupCard
              eyebrow="Advisor"
              title="Advisor/RIA setup"
              description={
                riaCapability === "disabled"
                  ? "RIA mode is unavailable in this environment until IAM is active."
                  : "Switch into the advisor workspace for firm setup, verification, and client requests."
              }
              actionLabel={riaCapability === "disabled" ? "Unavailable" : "Open RIA setup"}
              icon={<UserRound className="h-5 w-5" />}
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
            />

            <SetupCard
              eyebrow="Security"
              title="Bring your own keys"
              description="BYOK and passkey-first setup will appear here after verification is complete."
              actionLabel="Coming soon"
              icon={<KeyRound className="h-5 w-5" />}
              disabled
            />

            <MemoryImportComingSoonCard />

            <button
              type="button"
              disabled={saving}
              onClick={() => void completeSetupAsSkipped()}
              className="mx-auto min-h-10 rounded-full px-4 text-[14px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
            >
              Skip for now
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (stage === "persona") {
    return (
      <>
        <NativeTestBeacon
          routeId={ROUTES.ONE_ONBOARDING}
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
            trackGrowthFunnelStepCompleted({
              journey: "investor",
              step: "onboarding_completed",
              dedupeKey: "growth:investor:onboarding_completed:complete",
              dedupeWindowMs: 5_000,
            });
            router.replace(buildRouteWithFrom(ROUTES.KAI_IMPORT, onboardingSelfHref));
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
        routeId={ROUTES.ONE_ONBOARDING}
        marker="native-route-kai-onboarding"
        authState={user ? "authenticated" : "pending"}
        dataState="loaded"
      />
      <KaiPreferencesWizard
        mode="onboarding"
        layout="page"
        initialStep={0}
        initialAnswers={wizardAnswers}
        onBack={() => router.replace(onboardingReturnHref)}
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
      onSkip={() => void completeSetupAsSkipped()}
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
