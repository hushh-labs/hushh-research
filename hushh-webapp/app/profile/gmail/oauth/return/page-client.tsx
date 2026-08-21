"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { ApiService } from "@/lib/services/api-service";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
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

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Gmail connection could not be completed.";
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
  journey: Awaited<
    ReturnType<typeof PreVaultUserStateService.bootstrapState>
  > | null,
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
  const pendingAttempt = resolvePendingGmailSetupAttempt(
    journey,
    params.intent,
  );
  if (!pendingAttempt) return false;
  if (!journey) return false;
  await PreVaultUserStateService.syncOnboardingJourney({
    userId: params.userId,
    phase: params.phase,
    activeCapability: "gmail",
    callbackState: params.callbackState,
    expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
    expectedCallbackAttemptId: pendingAttempt.correlationId,
  });
  return true;
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
  const searchParams = useSearchParams();
  const startedRef = useRef(false);
  const { user, loading } = useAuth();
  const [stage, setStage] = useState<CompleteStage>("loading");
  const [error, setError] = useState<string | null>(null);
  const [returnToSetup, setReturnToSetup] = useState(false);

  useEffect(() => {
    if (loading || startedRef.current) return;
    startedRef.current = true;

    const liveError = String(searchParams.get("error") || "").trim();
    const liveErrorDescription = String(
      searchParams.get("error_description") || "",
    ).trim();
    const liveCode = String(searchParams.get("code") || "").trim();
    const liveState = String(searchParams.get("state") || "").trim();

    const oauthError = liveError || initialError;
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
        liveErrorDescription || initialErrorDescription;
      setStage("error");
      setError(
        oauthErrorDescription ||
          oauthError ||
          "Google OAuth authorization was denied.",
      );
      void persistEarlyCallbackOutcome(
        oauthError.toLowerCase() === "access_denied" ? "cancelled" : "failed",
      ).finally(() => {
        settlePopupOpener({
          outcome:
            oauthError.toLowerCase() === "access_denied"
              ? "cancelled"
              : "failed",
          message:
            sanitizeGmailUserMessage(
              oauthErrorDescription || oauthError,
              {
                fallback: "Gmail connection could not be completed.",
              },
            ),
        });
      });
      return;
    }

    const code = liveCode || initialCode;
    const state = liveState || initialState;
    // The one-click cloud setup borrows this ALREADY-REGISTERED return door
    // (OAuth clients cannot be edited by API, and this is the URI the client
    // provably accepts for this origin). The byoc state prefix keeps the two
    // flows unmistakable; nothing Gmail-shaped runs for it.
    if (state && state.startsWith("byoc.")) {
      if (!user?.uid || !code) {
        router.replace("/one/setup/cloud");
        return;
      }
      void ApiService.completeByocAuthorize({ code, state })
        .then(() => {
          // The completion is a background JOB now: this resolved in about a
          // second with a claim ticket, and the cloud page renders the live
          // stage checklist from the status route. Nothing to wait for here.
          router.replace(ROUTES.ONE_SETUP_CLOUD);
        })
        .catch((byocError: unknown) => {
          const raw =
            byocError instanceof Error &&
            byocError.message &&
            byocError.message !== "BYOC_AUTHORIZE_FAILED"
              ? byocError.message
              : "";
          // A transport timeout is not a server verdict: the completion keeps
          // running server-side and usually lands moments later. Say that,
          // instead of leaking "Request timed out after 60000ms" into the
          // alert (audit finding, 2026-08-21).
          const reason = /timed out|timeout/i.test(raw)
            ? "This is taking longer than expected, and your cloud may still be " +
              "finishing in the background. Wait a moment, then press Continue " +
              "again; if it already finished, the setup list will show it."
            : raw || "We could not finish setting up your cloud. Try again.";
          router.replace(
            `/one/setup/cloud?authorize_error=${encodeURIComponent(reason)}`,
          );
        });
      return;
    }
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
      try {
        setStage("completing");
        const idToken = await user.getIdToken();

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

        setStage("redirecting");
        if (pendingSetupAttempt) {
          const settled = await settleGmailSetupAttempt({
            userId: user.uid,
            intent: pendingSetupAttempt,
            phase: "capability_setup",
            callbackState: "succeeded",
          }).catch((error) => {
            // Connector success is authoritative even if the resumable journey
            // echo is temporarily unavailable. Do not relabel a connected
            // account as a failed OAuth callback.
            console.warn(
              "[GmailOAuthReturn] Failed to persist setup return:",
              error,
            );
            return false;
          });
          clearOnboardingConnectorIntent();
          if (settlePopupOpener({ outcome: "succeeded" })) {
            return;
          }
          router.replace(
            settled ? ROUTES.ONE_SETUP_GMAIL : buildProfileGmailReturnPath(),
          );
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
              if (pendingSetupAttempt) {
                const settled = await settleGmailSetupAttempt({
                  userId: user.uid,
                  intent: pendingSetupAttempt,
                  phase: "capability_setup",
                  callbackState: "succeeded",
                }).catch((error) => {
                  console.warn(
                    "[GmailOAuthReturn] Failed to persist replay return:",
                    error,
                  );
                  return false;
                });
                clearOnboardingConnectorIntent();
                if (settlePopupOpener({ outcome: "succeeded" })) {
                  return;
                }
                router.replace(
                  settled
                    ? ROUTES.ONE_SETUP_GMAIL
                    : buildProfileGmailReturnPath(),
                );
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
        if (pendingSetupAttempt) {
          await settleGmailSetupAttempt({
            userId: user.uid,
            intent: pendingSetupAttempt,
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
    searchParams,
    user,
  ]);

  if (stage !== "error") {
    return (
      <AppPageShell
        as="div"
        width="reading"
        className="flex min-h-[60vh] items-center justify-center"
        nativeTest={{
          routeId: "/one/profile/gmail/oauth/return",
          marker: "native-route-profile-gmail-return",
          authState: user?.uid ? "authenticated" : "pending",
          dataState:
            stage === "redirecting" ? "redirect-valid" : "unavailable-valid",
          errorCode: error ? "gmail_oauth" : null,
          errorMessage: error,
        }}
      >
        <AppPageContentRegion className="flex min-h-[60vh] items-center justify-center">
          <HushhLoader
            label={
              (searchParams.get("state") || initialState || "").startsWith("byoc.")
                ? "Setting up your cloud. This can take a few minutes..."
                : stage === "redirecting"
                  ? "Returning to Gmail..."
                  : "Completing your Gmail connector setup..."
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
        routeId: "/one/profile/gmail/oauth/return",
        marker: "native-route-profile-gmail-return",
        authState: user?.uid ? "authenticated" : "pending",
        dataState: "unavailable-valid",
        errorCode: "gmail_oauth",
        errorMessage: error,
      }}
    >
      <AppPageContentRegion className="flex min-h-[60vh] items-center justify-center">
        <div className="w-full max-w-md rounded-2xl border border-border/60 bg-card/80 p-5 text-center shadow-sm">
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
      </AppPageContentRegion>
    </AppPageShell>
  );
}
