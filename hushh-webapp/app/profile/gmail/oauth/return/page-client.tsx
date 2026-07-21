"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import {
  ROUTES,
} from "@/lib/navigation/routes";
import {
  buildProfileGmailReturnPath,
  isRecoverableGmailOAuthReplayError,
  sanitizeGmailUserMessage,
  stashProfileGmailReturnStatus,
} from "@/lib/profile/mail-flow";
import { primeConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import {
  clearOnboardingConnectorIntent,
  type OnboardingConnectorIntent,
  readOnboardingConnectorIntent,
} from "@/lib/onboarding/onboarding-connector-intent";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  clearGmailOAuthPopupAttempt,
  notifyGmailOAuthPopupOpener,
  notifyGmailOAuthPopupOpenerFallback,
  readGmailOAuthPopupAttempt,
} from "@/lib/profile/gmail-oauth-popup";

type CompleteStage = "loading" | "completing" | "redirecting" | "error";
type OnboardingConnectorIntentRef = Pick<
  OnboardingConnectorIntent,
  "correlationId"
>;
type PreVaultJourney = Awaited<
  ReturnType<typeof PreVaultUserStateService.bootstrapState>
>;

const DURABLE_SETUP_RECOVERY_TIMEOUT_MS = 750;

function GmailOAuthReturnFrame({
  authState,
  dataState,
  errorCode,
  errorMessage,
  children,
}: {
  authState: "authenticated" | "pending";
  dataState: "redirect-valid" | "unavailable-valid";
  errorCode?: string | null;
  errorMessage?: string | null;
  children: ReactNode;
}) {
  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground"
      data-native-test-beacon="true"
      data-native-route-marker="true"
      data-native-route-id="/one/profile/gmail/oauth/return"
      data-native-auth-state={authState}
      data-native-data-state={dataState}
      data-native-error-code={errorCode || undefined}
      data-native-error-message={errorMessage || undefined}
    >
      {children}
    </main>
  );
}

function GmailOAuthReturnLoader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-full border border-border/60 bg-card/85 px-5 py-3 text-sm text-muted-foreground shadow-sm">
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      />
      <span>{label}</span>
    </div>
  );
}

function readBrowserOAuthReturnParams(): {
  code: string;
  state: string;
  error: string;
  errorDescription: string;
} {
  if (typeof window === "undefined") {
    return { code: "", state: "", error: "", errorDescription: "" };
  }

  const params = new URLSearchParams(window.location.search);
  return {
    code: String(params.get("code") || "").trim(),
    state: String(params.get("state") || "").trim(),
    error: String(params.get("error") || "").trim(),
    errorDescription: String(params.get("error_description") || "").trim(),
  };
}

function resolveErrorMessage(error: unknown): string {
  return sanitizeGmailUserMessage(error, {
    fallback: "Gmail connection could not be completed.",
  });
}

/**
 * A same-origin OAuth popup returns the terminal state to the retained
 * opener via both postMessage (primary) and a localStorage "storage" event
 * (fallback, for when `window.opener` is null/inaccessible). The payload
 * contains no OAuth or vault material either way.
 *
 * This page only reaches here when it was opened as the retained popup (an
 * attempt marker exists in its own sessionStorage). In that case it always
 * closes itself once both channels have been attempted, regardless of
 * whether postMessage delivery succeeded, so the popup never falls through
 * to rendering the full app in place of closing. Direct/non-popup visits
 * (no attempt marker) return false and take the existing route-replace
 * recovery path instead.
 */
function settlePopupOpener(params: {
  outcome: "succeeded" | "cancelled" | "failed";
  message?: string;
}): boolean {
  const attempt = readGmailOAuthPopupAttempt();
  if (!attempt) return false;
  const settlement = {
    schemaVersion: 1 as const,
    type: "gmail_oauth_settlement" as const,
    attemptId: attempt.attemptId,
    outcome: params.outcome,
    ...(params.message ? { message: params.message } : {}),
  };
  notifyGmailOAuthPopupOpener(settlement);
  notifyGmailOAuthPopupOpenerFallback(settlement);
  clearGmailOAuthPopupAttempt();
  window.setTimeout(() => window.close(), 0);
  return true;
}

function resolvePendingGmailSetupAttempt(
  journey: PreVaultJourney | null,
  intent: OnboardingConnectorIntentRef | null,
): OnboardingConnectorIntentRef | null {
  if (
    !journey ||
    PreVaultUserStateService.isSetupResolved(journey) ||
    journey.onboardingPhase !== "external_connector" ||
    journey.onboardingActiveCapability !== "gmail" ||
    journey.onboardingCallbackState !== "pending" ||
    typeof journey.onboardingCallbackAttemptId !== "string"
  ) {
    return null;
  }
  const durableAttemptId = journey.onboardingCallbackAttemptId.trim();
  if (!durableAttemptId) return null;
  if (intent && durableAttemptId !== intent.correlationId) return null;
  return intent ?? { correlationId: durableAttemptId };
}

async function settleGmailSetupAttempt(params: {
  userId: string;
  intent: OnboardingConnectorIntentRef;
  phase: "external_connector" | "capability_setup";
  callbackState: "cancelled" | "failed" | "succeeded";
}): Promise<boolean> {
  const journey = await PreVaultUserStateService.bootstrapState(params.userId, {
    force: true,
  }).catch(() => null);
  return settleResolvedGmailSetupAttempt({ ...params, journey });
}

async function settleResolvedGmailSetupAttempt(params: {
  userId: string;
  intent: OnboardingConnectorIntentRef | null;
  journey: PreVaultJourney | null;
  phase: "external_connector" | "capability_setup";
  callbackState: "cancelled" | "failed" | "succeeded";
}): Promise<boolean> {
  const pendingAttempt = resolvePendingGmailSetupAttempt(
    params.journey,
    params.intent,
  );
  if (!pendingAttempt) return false;
  if (!params.journey) return false;
  await PreVaultUserStateService.syncOnboardingJourney({
    userId: params.userId,
    phase: params.phase,
    activeCapability: "gmail",
    callbackState: params.callbackState,
    expectedJourneyUpdatedAt: params.journey.onboardingJourneyUpdatedAt,
    expectedCallbackAttemptId: pendingAttempt.correlationId,
  });
  return true;
}

function waitForDurableSetupRecovery(
  durableJourneyPromise: Promise<PreVaultJourney | null>,
): Promise<PreVaultJourney | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: number | undefined;
    const finish = (journey: PreVaultJourney | null) => {
      if (settled) return;
      settled = true;
      if (typeof timer === "number") {
        window.clearTimeout(timer);
      }
      resolve(journey);
    };
    timer = window.setTimeout(
      () => finish(null),
      DURABLE_SETUP_RECOVERY_TIMEOUT_MS,
    );
    durableJourneyPromise.then(finish).catch(() => finish(null));
  });
}

async function resolveSetupReturnIntent(params: {
  onboardingIntent: OnboardingConnectorIntentRef | null;
  durableJourneyPromise: Promise<PreVaultJourney | null>;
}): Promise<{
  intent: OnboardingConnectorIntentRef | null;
  journey: PreVaultJourney | null;
}> {
  if (params.onboardingIntent) {
    return { intent: params.onboardingIntent, journey: null };
  }
  const durableJourney = await waitForDurableSetupRecovery(
    params.durableJourneyPromise,
  );
  return {
    intent: resolvePendingGmailSetupAttempt(durableJourney, null),
    journey: durableJourney,
  };
}

function persistSuccessfulSetupReturn(params: {
  userId: string;
  intent: OnboardingConnectorIntentRef | null;
  journey: PreVaultJourney | null;
  logLabel: string;
}): void {
  if (!params.intent) return;
  const persistPromise = params.journey
    ? settleResolvedGmailSetupAttempt({
        userId: params.userId,
        intent: params.intent,
        journey: params.journey,
        phase: "capability_setup",
        callbackState: "succeeded",
      })
    : settleGmailSetupAttempt({
        userId: params.userId,
        intent: params.intent,
        phase: "capability_setup",
        callbackState: "succeeded",
      });
  void persistPromise
    .catch((error) => {
      // Connector success is authoritative even if the resumable journey echo
      // is temporarily unavailable. Do not block return.
      console.warn(params.logLabel, error);
    })
    .finally(() => clearOnboardingConnectorIntent());
}

export default function ProfileGmailOAuthReturnPageClient({
  initialCode,
  initialState,
  initialError,
  initialErrorDescription,
}: {
  initialCode: string;
  initialState: string;
  initialError: string;
  initialErrorDescription: string;
}) {
  const router = useRouter();
  const startedRef = useRef(false);
  const { user, loading } = useAuth();
  const [stage, setStage] = useState<CompleteStage>("loading");
  const [error, setError] = useState<string | null>(null);
  const [returnToSetup, setReturnToSetup] = useState(false);

  useEffect(() => {
    if (loading || startedRef.current) return;
    startedRef.current = true;

    const liveParams = readBrowserOAuthReturnParams();

    const oauthError = liveParams.error || initialError;
    const onboardingIntent = readOnboardingConnectorIntent();
    setReturnToSetup(Boolean(onboardingIntent));

    const persistEarlyCallbackOutcome = async (
      callbackState: "cancelled" | "failed",
    ) => {
      if (!user?.uid) return;
      const durableJourney = await PreVaultUserStateService.bootstrapState(
        user.uid,
        { force: true },
      ).catch(() => null);
      const pendingSetupAttempt = resolvePendingGmailSetupAttempt(
        durableJourney,
        onboardingIntent,
      );
      const shouldReturnToSetup = Boolean(pendingSetupAttempt);
      setReturnToSetup(shouldReturnToSetup);
      if (!shouldReturnToSetup) return;
      await settleGmailSetupAttempt({
        userId: user.uid,
        intent: pendingSetupAttempt!,
        phase: "external_connector",
        callbackState,
      }).catch((persistError) => {
        console.warn(
          "[GmailOAuthReturn] Failed to persist callback recovery:",
          persistError,
        );
      });
      clearOnboardingConnectorIntent();
    };

    if (oauthError) {
      const oauthErrorDescription =
        liveParams.errorDescription || initialErrorDescription;
      const safeMessage = sanitizeGmailUserMessage(
        oauthErrorDescription || oauthError,
        {
          fallback: "Gmail connection could not be completed.",
        },
      );
      setStage("error");
      setError(safeMessage);
      void persistEarlyCallbackOutcome(
        oauthError.toLowerCase() === "access_denied" ? "cancelled" : "failed",
      ).finally(() => {
        settlePopupOpener({
          outcome:
            oauthError.toLowerCase() === "access_denied"
              ? "cancelled"
              : "failed",
          message: safeMessage,
        });
      });
      return;
    }

    const code = liveParams.code || initialCode;
    const state = liveParams.state || initialState;
    if (!code || !state) {
      setStage("error");
      setError(
        "Missing OAuth code or state. Start Connect Gmail again from Gmail.",
      );
      void persistEarlyCallbackOutcome("failed").finally(() => {
        settlePopupOpener({
          outcome: "failed",
          message: "Gmail connection could not be completed.",
        });
      });
      return;
    }

    if (!user?.uid) {
      const redirectTarget =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : ROUTES.PROFILE_GMAIL_OAUTH_RETURN;
      router.replace(`/login?redirect=${encodeURIComponent(redirectTarget)}`);
      return;
    }

    void (async () => {
      try {
        setStage("completing");
        const idToken = await user.getIdToken();
        const durableJourneyPromise = PreVaultUserStateService.bootstrapState(
          user.uid,
          { force: true },
        ).catch(() => null);

        const status = await GmailReceiptsService.completeConnect({
          idToken,
          userId: user.uid,
          code,
          state,
        });
        primeConnectorStatus({
          userId: user.uid,
          status,
          routeHref: buildProfileGmailReturnPath(),
          source: "oauth_return",
        });
        stashProfileGmailReturnStatus(status);

        const setupReturn = await resolveSetupReturnIntent({
          onboardingIntent,
          durableJourneyPromise,
        });
        const shouldReturnToSetup = Boolean(setupReturn.intent);
        setReturnToSetup(shouldReturnToSetup);
        setStage("redirecting");

        if (setupReturn.intent) {
          persistSuccessfulSetupReturn({
            userId: user.uid,
            intent: setupReturn.intent,
            journey: setupReturn.journey,
            logLabel: "[GmailOAuthReturn] Failed to persist setup return:",
          });
        }

        if (shouldReturnToSetup) {
          if (settlePopupOpener({ outcome: "succeeded" })) {
            return;
          }
          router.replace(ROUTES.ONE_SETUP_GMAIL);
        } else {
          if (settlePopupOpener({ outcome: "succeeded" })) {
            return;
          }
          router.replace(buildProfileGmailReturnPath());
        }
      } catch (completeError) {
        if (isRecoverableGmailOAuthReplayError(completeError)) {
          try {
            const idToken = await user.getIdToken();
            const durableJourneyPromise =
              PreVaultUserStateService.bootstrapState(user.uid, {
                force: true,
              }).catch(() => null);
            const status = await GmailReceiptsService.getStatus({
              idToken,
              userId: user.uid,
              force: true,
            });
            if (status.connected) {
              primeConnectorStatus({
                userId: user.uid,
                status,
                routeHref: buildProfileGmailReturnPath(),
                source: "oauth_return",
              });
              stashProfileGmailReturnStatus(status);
              setStage("redirecting");
              const setupReturn = await resolveSetupReturnIntent({
                onboardingIntent,
                durableJourneyPromise,
              });
              setReturnToSetup(Boolean(setupReturn.intent));
              if (setupReturn.intent) {
                persistSuccessfulSetupReturn({
                  userId: user.uid,
                  intent: setupReturn.intent,
                  journey: setupReturn.journey,
                  logLabel:
                    "[GmailOAuthReturn] Failed to persist replay return:",
                });
                if (settlePopupOpener({ outcome: "succeeded" })) {
                  return;
                }
                router.replace(ROUTES.ONE_SETUP_GMAIL);
              } else {
                if (settlePopupOpener({ outcome: "succeeded" })) {
                  return;
                }
                router.replace(buildProfileGmailReturnPath());
              }
              return;
            }
          } catch {
            // Fall through to the standard error path if status refresh fails.
          }
        }
        setStage("error");
        setError(resolveErrorMessage(completeError));
        if (onboardingIntent) {
          await settleGmailSetupAttempt({
            userId: user.uid,
            intent: onboardingIntent,
            phase: "external_connector",
            callbackState: "failed",
          }).catch(() => undefined);
          clearOnboardingConnectorIntent();
        }
        settlePopupOpener({
          outcome: "failed",
          message: sanitizeGmailUserMessage(completeError, {
            fallback: "Gmail connection could not be completed.",
          }),
        });
      }
    })();
  }, [
    initialCode,
    initialError,
    initialErrorDescription,
    initialState,
    loading,
    router,
    user,
  ]);

  if (stage !== "error") {
    return (
      <GmailOAuthReturnFrame
        authState={user?.uid ? "authenticated" : "pending"}
        dataState={
          stage === "redirecting" ? "redirect-valid" : "unavailable-valid"
        }
        errorCode={error ? "gmail_oauth" : null}
        errorMessage={error}
      >
        <GmailOAuthReturnLoader
          label={
            stage === "redirecting"
              ? "Returning to Gmail..."
              : "Completing your Gmail connector setup..."
          }
        />
      </GmailOAuthReturnFrame>
    );
  }

  return (
    <GmailOAuthReturnFrame
      authState={user?.uid ? "authenticated" : "pending"}
      dataState="unavailable-valid"
      errorCode="gmail_oauth"
      errorMessage={error}
    >
      <div className="w-full max-w-md rounded-2xl border border-border/60 bg-card/90 p-5 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">
          Gmail connection needs attention
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <div className="mt-4 flex flex-col gap-2">
          <Button
            onClick={() =>
              router.replace(
                returnToSetup
                  ? ROUTES.ONE_SETUP
                  : buildProfileGmailReturnPath(),
              )
            }
            className="w-full"
          >
            {returnToSetup ? "Back to setup" : "Back to Gmail"}
          </Button>
        </div>
      </div>
    </GmailOAuthReturnFrame>
  );
}
