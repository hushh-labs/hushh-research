"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";
import {
  clearPlaidOAuthResumeSession,
  loadPlaidOAuthResumeSession,
} from "@/lib/kai/brokerage/plaid-oauth-session";
import {
  KAI_AUXILIARY_STEP_TIMEOUT_MS,
  runKaiStepWithTimeout,
} from "@/lib/kai/brokerage/kai-operation-timeout";
import { completeVaultOAuthReturn } from "@/lib/kai/plaid-vault/vault-sync";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { useVault } from "@/lib/vault/vault-context";

type ResumeStage = "loading" | "resuming" | "redirecting" | "error";

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "The bank connection could not be finished.";
}

async function settleOnboardingPlaidAttempt(params: {
  userId: string;
  attemptId?: string;
  outcome: "succeeded" | "cancelled" | "failed";
}): Promise<boolean> {
  if (!params.attemptId) return false;
  const journey = await runKaiStepWithTimeout(
    "Checking Plaid setup state",
    PreVaultUserStateService.bootstrapState(params.userId, {
      force: true,
    }),
    KAI_AUXILIARY_STEP_TIMEOUT_MS,
  ).catch(() => null);
  const matches = Boolean(
    journey &&
      !PreVaultUserStateService.isSetupResolved(journey) &&
      journey.onboardingPhase === "external_connector" &&
      journey.onboardingActiveCapability === "finance" &&
      journey.onboardingCallbackState === "pending" &&
      journey.onboardingCallbackAttemptId === params.attemptId,
  );
  if (!matches || !journey) return false;
  await runKaiStepWithTimeout(
    "Updating Plaid setup state",
    PreVaultUserStateService.syncOnboardingJourney({
      userId: params.userId,
      phase:
        params.outcome === "succeeded" ? "capability_setup" : "external_connector",
      activeCapability: "finance",
      callbackState: params.outcome,
      expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
      expectedCallbackAttemptId: params.attemptId,
    }),
    KAI_AUXILIARY_STEP_TIMEOUT_MS,
  );
  return true;
}

export default function KaiPlaidOauthReturnPage() {
  const router = useRouter();
  const startedRef = useRef(false);
  const { user, loading } = useAuth();
  // This route sits behind the vault unlock screen (OneAuthGate), so by the
  // time it renders the person has unlocked again after the bank's page.
  const { vaultKey, vaultOwnerToken } = useVault();
  const [stage, setStage] = useState<ResumeStage>("loading");
  const [error, setError] = useState<string | null>(null);
  const [returnPath, setReturnPath] = useState<string>(ROUTES.KAI_DASHBOARD);

  useEffect(() => {
    if (loading || startedRef.current) return;
    if (!user?.uid) {
      const redirectTarget =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : ROUTES.KAI_PLAID_OAUTH_RETURN;
      router.replace(`/login?redirect=${encodeURIComponent(redirectTarget)}`);
      return;
    }
    if (!vaultKey || !vaultOwnerToken) return;

    const session = loadPlaidOAuthResumeSession();
    if (!session) {
      setStage("error");
      setError("This bank login has expired or was already used. Start the connection again from Finance.");
      return;
    }
    setReturnPath(session.returnPath || ROUTES.KAI_DASHBOARD);

    startedRef.current = true;
    const userId = user.uid;
    void (async () => {
      try {
        setStage("resuming");
        const { kind, result } = await completeVaultOAuthReturn({
          userId,
          vaultKey,
          vaultOwnerToken,
          session,
          currentUrl: window.location.href,
        });
        if (result.status === "blocked") throw new Error(result.reason);
        if (kind === "connect") {
          await settleOnboardingPlaidAttempt({
            userId,
            attemptId: session.onboardingAttemptId,
            outcome: result.status === "connected" ? "succeeded" : "cancelled",
          }).catch(() => undefined);
        }
        if (result.status === "connected") {
          toast.success(
            result.institutionName ? `${result.institutionName} connected.` : "Bank connected with Plaid.",
          );
        } else if (result.status === "repaired") {
          toast.success("Plaid connection updated.");
        }
        setStage("redirecting");
        router.replace(session.returnPath || ROUTES.KAI_DASHBOARD);
      } catch (resumeError) {
        await settleOnboardingPlaidAttempt({
          userId,
          attemptId: session.onboardingAttemptId,
          outcome: "failed",
        }).catch(() => undefined);
        setStage("error");
        setError(formatErrorMessage(resumeError));
      }
    })();
  }, [loading, router, user?.uid, vaultKey, vaultOwnerToken]);

  if (stage !== "error") {
    return (
      <AppPageShell
        as="div"
        width="reading"
        className="flex min-h-[60vh] items-center justify-center"
        nativeTest={{
          routeId: "/one/kai/plaid/oauth/return",
          marker: "native-route-kai-plaid-return",
          authState: user?.uid ? "authenticated" : "pending",
          dataState: stage === "redirecting" ? "redirect-valid" : "unavailable-valid",
          errorCode: error ? "plaid_resume" : null,
          errorMessage: error,
        }}
      >
        <AppPageContentRegion className="flex min-h-[60vh] items-center justify-center">
          <HushhLoader
            label={
              stage === "redirecting"
                ? "Returning to Finance..."
                : "Resuming your Plaid connection..."
            }
          />
        </AppPageContentRegion>
      </AppPageShell>
    );
  }

  return (
    <AppPageShell
      as="div"
      width="reading"
      className="flex min-h-[60vh] items-center justify-center"
      nativeTest={{
        routeId: "/one/kai/plaid/oauth/return",
        marker: "native-route-kai-plaid-return",
        authState: user?.uid ? "authenticated" : "pending",
        dataState: "unavailable-valid",
        errorCode: "plaid_resume",
        errorMessage: error,
      }}
    >
      <AppPageContentRegion className="flex min-h-[60vh] items-center justify-center">
        <div className="w-full max-w-md rounded-2xl border border-border/60 bg-card/80 p-5 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">Plaid connection needs attention</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <div className="mt-4 flex flex-col gap-2">
            <Button onClick={() => router.replace(returnPath)} className="w-full">
              Back to Finance
            </Button>
            <Button
              variant="none"
              effect="fade"
              onClick={() => {
                clearPlaidOAuthResumeSession();
                router.replace(ROUTES.KAI_DASHBOARD);
              }}
              className="w-full"
            >
              Start over
            </Button>
          </div>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
