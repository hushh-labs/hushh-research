"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import {
  buildProfileGmailReturnPath,
  isRecoverableGmailOAuthReplayError,
  stashProfileGmailReturnStatus,
} from "@/lib/profile/mail-flow";
import { primeConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";

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
  const startedRef = useRef(false);
  const { user, loading } = useAuth();
  const [stage, setStage] = useState<CompleteStage>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || startedRef.current) return;

    const oauthError = initialError;
    if (oauthError) {
      const oauthErrorDescription = initialErrorDescription;
      setStage("error");
      setError(oauthErrorDescription || oauthError || "Google OAuth authorization was denied.");
      return;
    }

    const code = initialCode;
    const state = initialState;
    if (!code || !state) {
      setStage("error");
      setError("Missing OAuth code or state. Start Connect Gmail again from Profile.");
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

    startedRef.current = true;
    void (async () => {
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
        router.replace(buildProfileGmailReturnPath());
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
              router.replace(buildProfileGmailReturnPath());
              return;
            }
          } catch {
            // Fall through to the standard error path if status refresh fails.
          }
        }
        setStage("error");
        setError(resolveErrorMessage(completeError));
      }
    })();
  }, [initialCode, initialError, initialErrorDescription, initialState, loading, router, user]);

  if (stage !== "error") {
    return (
      <AppPageShell
        as="div"
        width="narrow"
        className="flex min-h-[60vh] items-center justify-center"
        nativeTest={{
          routeId: "/profile/gmail/oauth/return",
          marker: "native-route-profile-gmail-return",
          authState: user?.uid ? "authenticated" : "pending",
          dataState: stage === "redirecting" ? "redirect-valid" : "unavailable-valid",
          errorCode: error ? "gmail_oauth" : null,
          errorMessage: error,
        }}
      >
        <AppPageContentRegion className="flex min-h-[60vh] items-center justify-center">
          <HushhLoader
            label={
              stage === "redirecting"
                ? "Returning to your profile..."
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
      width="narrow"
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
          <h1 className="text-lg font-semibold text-foreground">Gmail connection needs attention</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <div className="mt-4 flex flex-col gap-2">
            <Button onClick={() => router.replace(buildProfileGmailReturnPath())} className="w-full">
              Back to Profile
            </Button>
          </div>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
