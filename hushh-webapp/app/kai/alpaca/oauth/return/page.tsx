"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";
import {
  clearAlpacaOAuthResumeSession,
  loadAlpacaOAuthResumeSession,
} from "@/lib/kai/brokerage/alpaca-oauth-session";
import { VaultService } from "@/lib/services/vault-service";
import { useVault } from "@/lib/vault/vault-context";

type ResumeStage = "loading" | "redirecting" | "error";

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Alpaca login could not be completed.";
}

export default function KaiAlpacaOauthReturnPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const startedRef = useRef(false);
  const { user, loading } = useAuth();
  const { vaultKey, unlockVault } = useVault();
  const [stage, setStage] = useState<ResumeStage>("loading");
  const [error, setError] = useState<string | null>(null);
  const [returnPath, setReturnPath] = useState<string>(ROUTES.KAI_PORTFOLIO);

  useEffect(() => {
    if (loading || startedRef.current) return;

    const session = loadAlpacaOAuthResumeSession();
    if (!session) {
      setStage("error");
      setError("No active Alpaca OAuth session was found. Start again from funding settings.");
      return;
    }
    setReturnPath(session.returnPath || ROUTES.KAI_PORTFOLIO);

    if (!user?.uid) {
      const redirectTarget =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : ROUTES.KAI_ALPACA_OAUTH_RETURN;
      router.replace(`/login?redirect=${encodeURIComponent(redirectTarget)}`);
      return;
    }

    if (session.userId !== user.uid) {
      clearAlpacaOAuthResumeSession();
      setStage("error");
      setError("This Alpaca OAuth session belongs to a different signed-in user.");
      return;
    }

    const code = String(searchParams.get("code") || "").trim();
    const state = String(searchParams.get("state") || "").trim();
    if (!code || !state) {
      clearAlpacaOAuthResumeSession();
      setStage("error");
      setError("Alpaca did not return a valid authorization response.");
      return;
    }

    if (state !== session.state) {
      clearAlpacaOAuthResumeSession();
      setStage("error");
      setError("Alpaca OAuth state mismatch. Please try connecting again.");
      return;
    }

    startedRef.current = true;
    void (async () => {
      try {
        const issued = await VaultService.getOrIssueVaultOwnerToken(user.uid);
        if (vaultKey) {
          unlockVault(vaultKey, issued.token, issued.expiresAt);
        }

        await PlaidPortfolioService.completeAlpacaConnect({
          userId: user.uid,
          vaultOwnerToken: issued.token,
          state,
          code,
        });
        clearAlpacaOAuthResumeSession();
        setStage("redirecting");
        router.replace(session.returnPath || ROUTES.KAI_PORTFOLIO);
      } catch (resumeError) {
        clearAlpacaOAuthResumeSession();
        setStage("error");
        setError(formatErrorMessage(resumeError));
      }
    })();
  }, [loading, router, searchParams, unlockVault, user?.uid, vaultKey]);

  if (stage !== "error") {
    return (
      <AppPageShell
        as="div"
        width="narrow"
        className="flex min-h-[60vh] items-center justify-center"
        nativeTest={{
          routeId: "/kai/alpaca/oauth/return",
          marker: "native-route-kai-alpaca-return",
          authState: user?.uid ? "authenticated" : "pending",
          dataState: stage === "redirecting" ? "redirect-valid" : "unavailable-valid",
          errorCode: error ? "alpaca_connect_resume" : null,
          errorMessage: error,
        }}
      >
        <AppPageContentRegion className="flex min-h-[60vh] items-center justify-center">
          <HushhLoader
            label={stage === "redirecting" ? "Returning to Kai..." : "Completing Alpaca login..."}
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
        routeId: "/kai/alpaca/oauth/return",
        marker: "native-route-kai-alpaca-return",
        authState: user?.uid ? "authenticated" : "pending",
        dataState: "unavailable-valid",
        errorCode: "alpaca_connect_resume",
        errorMessage: error,
      }}
    >
      <AppPageContentRegion className="flex min-h-[60vh] items-center justify-center">
        <div className="w-full max-w-md rounded-2xl border border-border/60 bg-card/80 p-5 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">Alpaca connection needs attention</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <div className="mt-4 flex flex-col gap-2">
            <Button onClick={() => router.replace(returnPath)} className="w-full">
              Back to Kai
            </Button>
            <Button
              variant="none"
              effect="fade"
              onClick={() => {
                clearAlpacaOAuthResumeSession();
                router.replace(ROUTES.KAI_PORTFOLIO);
              }}
              className="w-full"
            >
              Reset Alpaca Connect
            </Button>
          </div>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
