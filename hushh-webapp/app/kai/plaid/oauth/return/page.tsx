"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

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
import { loadPlaidLink } from "@/lib/kai/brokerage/plaid-link-loader";
import { PlaidPortfolioService } from "@/lib/kai/brokerage/plaid-portfolio-service";
import { VaultService } from "@/lib/services/vault-service";
import { useVault } from "@/lib/vault/vault-context";

type ResumeStage = "loading" | "resuming" | "redirecting" | "error";

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Plaid OAuth could not be completed.";
}

export default function KaiPlaidOauthReturnPage() {
  const router = useRouter();
  const startedRef = useRef(false);
  const { user, loading } = useAuth();
  const { vaultKey, unlockVault } = useVault();
  const [stage, setStage] = useState<ResumeStage>("loading");
  const [error, setError] = useState<string | null>(null);
  const [returnPath, setReturnPath] = useState<string>(ROUTES.KAI_DASHBOARD);

  useEffect(() => {
    if (loading || startedRef.current) return;

    const session = loadPlaidOAuthResumeSession();
    if (!session) {
      setStage("error");
      setError("No active Plaid OAuth session was found. Start the connection again from Kai.");
      return;
    }

    setReturnPath(session.returnPath || ROUTES.KAI_DASHBOARD);
    const flowKind = session.flowKind === "funding" ? "funding" : "investments";

    if (!user?.uid) {
      const redirectTarget =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : ROUTES.KAI_PLAID_OAUTH_RETURN;
      router.replace(`/login?redirect=${encodeURIComponent(redirectTarget)}`);
      return;
    }

    if (session.userId !== user.uid) {
      clearPlaidOAuthResumeSession();
      setStage("error");
      setError("This Plaid OAuth session belongs to a different signed-in user.");
      return;
    }

    startedRef.current = true;
    void (async () => {
      try {
        setStage("loading");
        const issued = await VaultService.getOrIssueVaultOwnerToken(user.uid);
        if (vaultKey) {
          unlockVault(vaultKey, issued.token, issued.expiresAt);
        }

        const resume = await PlaidPortfolioService.resumeOAuth({
          userId: user.uid,
          resumeSessionId: session.resumeSessionId,
          vaultOwnerToken: issued.token,
        });
        const linkTokenValue = resume.link_token;
        if (!resume.configured || !linkTokenValue) {
          throw new Error("Plaid is not configured for this environment.");
        }

        const Plaid = await loadPlaidLink();
        setStage("resuming");

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            callback();
          };

          const handler = Plaid.create({
            token: linkTokenValue,
            receivedRedirectUri: window.location.href,
            onSuccess: (publicToken: string, metadata: Record<string, unknown>) => {
              void (
                flowKind === "funding"
                  ? PlaidPortfolioService.exchangeFundingPublicToken({
                      userId: user.uid,
                      publicToken,
                      vaultOwnerToken: issued.token,
                      metadata,
                      resumeSessionId: session.resumeSessionId,
                    })
                  : PlaidPortfolioService.exchangePublicToken({
                      userId: user.uid,
                      publicToken,
                      vaultOwnerToken: issued.token,
                      metadata,
                      resumeSessionId: session.resumeSessionId,
                    })
              )
                .then(() => {
                  clearPlaidOAuthResumeSession();
                  finish(resolve);
                })
                .catch((resumeError) => {
                  finish(() =>
                    reject(
                      resumeError instanceof Error
                        ? resumeError
                        : new Error("Plaid exchange failed.")
                    )
                  );
                })
                .finally(() => {
                  handler.destroy?.();
                });
            },
            onExit: (exitError: Record<string, unknown> | null) => {
              handler.destroy?.();
              clearPlaidOAuthResumeSession();
              if (exitError && typeof exitError === "object") {
                const detail =
                  typeof exitError.error_message === "string"
                    ? exitError.error_message
                    : "Plaid Link closed with an error.";
                finish(() => reject(new Error(detail)));
                return;
              }
              finish(resolve);
            },
          });

          handler.open();
        });

        setStage("redirecting");
        router.replace(session.returnPath || ROUTES.KAI_DASHBOARD);
      } catch (resumeError) {
        clearPlaidOAuthResumeSession();
        setStage("error");
        setError(formatErrorMessage(resumeError));
      }
    })();
  }, [loading, router, unlockVault, user?.uid, vaultKey]);

  if (stage !== "error") {
    return (
      <AppPageShell
        as="div"
        width="reading"
        className="flex min-h-[60vh] items-center justify-center"
        nativeTest={{
          routeId: "/kai/plaid/oauth/return",
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
                ? "Returning to Kai..."
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
        routeId: "/kai/plaid/oauth/return",
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
              Back to Kai
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
              Reset Plaid Resume
            </Button>
          </div>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
