"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import {
  buildOneSetupCapabilityFinishRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import {
  buildProfileGmailReturnPath,
  isRecoverableGmailOAuthReplayError,
  stashProfileGmailReturnStatus,
} from "@/lib/profile/mail-flow";
import { primeConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import {
  clearOnboardingConnectorIntent,
  readOnboardingConnectorIntent,
} from "@/lib/onboarding/onboarding-connector-intent";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";

type CompleteStage = "loading" | "completing" | "redirecting" | "error";

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Gmail connection could not be completed.";
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
      const shouldReturnToSetup = Boolean(
        onboardingIntent ||
        (durableJourney &&
          !PreVaultUserStateService.isSetupResolved(durableJourney) &&
          durableJourney.onboardingActiveCapability === "gmail"),
      );
      setReturnToSetup(shouldReturnToSetup);
      if (!shouldReturnToSetup) return;
      await PreVaultUserStateService.syncOnboardingJourney({
        userId: user.uid,
        phase: "external_connector",
        activeCapability: "gmail",
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
      );
      return;
    }

    const code = liveCode || initialCode;
    const state = liveState || initialState;
    if (!code || !state) {
      setStage("error");
      setError(
        "Missing OAuth code or state. Start Connect Gmail again from Gmail.",
      );
      void persistEarlyCallbackOutcome("failed");
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
      const shouldReturnToSetup = Boolean(
        onboardingIntent ||
        (durableJourney &&
          !PreVaultUserStateService.isSetupResolved(durableJourney) &&
          durableJourney.onboardingActiveCapability === "gmail"),
      );
      setReturnToSetup(shouldReturnToSetup);
      try {
        setStage("completing");
        const idToken = await user.getIdToken();
        const redirectUri =
          typeof window !== "undefined"
            ? `${window.location.origin}${ROUTES.PROFILE_GMAIL_OAUTH_RETURN}`
            : ROUTES.PROFILE_GMAIL_OAUTH_RETURN;

        const status = await GmailReceiptsService.completeConnect({
          idToken,
          userId: user.uid,
          code,
          state,
          redirectUri,
        });
        primeConnectorStatus({
          userId: user.uid,
          status,
          routeHref: buildProfileGmailReturnPath(),
          source: "oauth_return",
        });
        stashProfileGmailReturnStatus(status);

        setStage("redirecting");
        if (shouldReturnToSetup) {
          await PreVaultUserStateService.syncOnboardingJourney({
            userId: user.uid,
            phase: "capability_setup",
            activeCapability: "gmail",
            callbackState: "succeeded",
          }).catch((error) => {
            // Connector success is authoritative even if the resumable journey
            // echo is temporarily unavailable. Do not relabel a connected
            // account as a failed OAuth callback.
            console.warn(
              "[GmailOAuthReturn] Failed to persist setup return:",
              error,
            );
          });
          clearOnboardingConnectorIntent();
          router.replace(buildOneSetupCapabilityFinishRoute("gmail"));
        } else {
          router.replace(buildProfileGmailReturnPath());
        }
      } catch (completeError) {
        if (isRecoverableGmailOAuthReplayError(completeError)) {
          try {
            const idToken = await user.getIdToken();
            const status = await GmailReceiptsService.getStatus({
              idToken,
              userId: user.uid,
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
              if (shouldReturnToSetup) {
                await PreVaultUserStateService.syncOnboardingJourney({
                  userId: user.uid,
                  phase: "capability_setup",
                  activeCapability: "gmail",
                  callbackState: "succeeded",
                }).catch((error) => {
                  console.warn(
                    "[GmailOAuthReturn] Failed to persist replay return:",
                    error,
                  );
                });
                clearOnboardingConnectorIntent();
                router.replace(buildOneSetupCapabilityFinishRoute("gmail"));
              } else {
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
        if (shouldReturnToSetup) {
          await PreVaultUserStateService.syncOnboardingJourney({
            userId: user.uid,
            phase: "external_connector",
            activeCapability: "gmail",
            callbackState: "failed",
          }).catch(() => undefined);
          clearOnboardingConnectorIntent();
        }
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
          routeId: "/profile/gmail/oauth/return",
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
              stage === "redirecting"
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
        routeId: "/profile/gmail/oauth/return",
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
