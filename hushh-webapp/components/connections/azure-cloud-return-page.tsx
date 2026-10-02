"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { PageHeader } from "@/components/app-ui/page-sections";
import { AzureSubscriptionPicker } from "@/components/connections/azure-subscription-picker";
import { AzureUpgradeProgress } from "@/components/connections/azure-upgrade-progress";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";
import {
  azureRetryKind,
  azureSignInErrorMessage,
  useAzureSignIn,
} from "@/lib/one/azure-sign-in";
import { ApiService } from "@/lib/services/api-service";
import type {
  AzureAuthorizeCompletion,
  AzureSubscription,
} from "@/lib/services/azure-byoc-contract";

/**
 * `/one/setup/cloud/azure/return` — where Microsoft sends the person back.
 *
 * The code is exchanged exactly once (the in-memory promise survives a Strict
 * Mode double effect) and only for the Hussh account that started it. The
 * hub's answer decides the screen: setup goes to the cloud step's live
 * checklist, an update shows its own progress here, and an account with more
 * than one subscription picks one and signs in again for it.
 */

type ReturnView =
  | { kind: "completing" }
  | { kind: "redirecting" }
  | { kind: "needs_subscription"; subscriptions: AzureSubscription[] }
  | { kind: "upgrading" }
  | { kind: "error"; message: string };

const RETURN_MESSAGES = {
  cancelled: "Microsoft sign-in was cancelled. Nothing in your subscription changed.",
  failed: "Microsoft sign-in could not finish. Nothing in your subscription changed.",
  incomplete: "This sign-in link is incomplete. Start the Microsoft sign-in again.",
  signedOut: "Sign in to Hussh, then start the Microsoft sign-in again.",
  owner: "Your Hussh account changed during sign-in. Start again with the account you began with.",
} as const;

const TITLES: Record<ReturnView["kind"], string> = {
  completing: "Connecting Azure",
  redirecting: "Connecting Azure",
  needs_subscription: "Choose a subscription",
  upgrading: "Updating your agent",
  error: "Microsoft sign-in did not finish",
};

/** A Microsoft refusal or a malformed link, read before any exchange. */
function returnLinkProblem(input: {
  providerError: string | null;
  code: string | null;
  state: string | null;
}): string | null {
  if (input.providerError) {
    return input.providerError === "access_denied"
      ? RETURN_MESSAGES.cancelled
      : RETURN_MESSAGES.failed;
  }
  return input.code && input.state ? null : RETURN_MESSAGES.incomplete;
}

function viewForCompletion(result: AzureAuthorizeCompletion): ReturnView {
  if (result.status === "setup_started") return { kind: "redirecting" };
  if (result.status === "upgrade_started") return { kind: "upgrading" };
  return { kind: "needs_subscription", subscriptions: result.subscriptions };
}

function useAzureCompletion(): ReturnView {
  const search = useSearchParams();
  const { user, loading } = useAuth();
  const [view, setView] = useState<ReturnView>({ kind: "completing" });
  const flow = useRef<{ uid: string; result: Promise<AzureAuthorizeCompletion> } | null>(null);
  // Primitives only: a fresh search-params or user object must not re-run this.
  const providerError = search.get("error");
  const code = search.get("code");
  const state = search.get("state");
  const userId = user?.uid ?? null;

  useEffect(() => {
    if (loading) return;
    if (!flow.current) {
      const problem = returnLinkProblem({ providerError, code, state });
      if (problem || !code || !state) {
        setView({ kind: "error", message: problem ?? RETURN_MESSAGES.incomplete });
        return;
      }
      if (!userId) {
        setView({ kind: "error", message: RETURN_MESSAGES.signedOut });
        return;
      }
      flow.current = {
        uid: userId,
        result: ApiService.completeAzureByocAuthorize({ code, state }),
      };
    }
    const active = flow.current;
    if (active.uid !== userId) {
      setView({ kind: "error", message: RETURN_MESSAGES.owner });
      return;
    }
    let current = true;
    active.result
      .then((result) => {
        if (current) setView(viewForCompletion(result));
      })
      .catch((cause: unknown) => {
        if (current) {
          setView({ kind: "error", message: azureSignInErrorMessage(cause, "complete") });
        }
      });
    return () => {
      current = false;
    };
  }, [loading, providerError, code, state, userId]);

  return view;
}

function ReturnError({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-[var(--app-card-radius-compact)] border border-destructive/30 bg-destructive/5 px-4 py-3"
      data-testid="azure-return-error"
    >
      <p className="text-sm text-destructive">{message}</p>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="button" disabled={retrying} onClick={onRetry} data-testid="azure-return-retry">
          {retrying ? "Opening Microsoft sign-in…" : "Try again"}
        </Button>
        <Link
          className="min-h-11 content-center text-sm underline underline-offset-4"
          href={ROUTES.ONE_SETUP_CLOUD}
        >
          Back to cloud setup
        </Link>
      </div>
    </div>
  );
}

export function AzureCloudReturnPage() {
  const router = useRouter();
  const view = useAzureCompletion();
  const signIn = useAzureSignIn();
  const { start } = signIn;

  // Setup progress lives on the cloud step, which polls the same job record.
  useEffect(() => {
    if (view.kind === "redirecting") router.replace(ROUTES.ONE_SETUP_CLOUD);
  }, [view.kind, router]);

  const retry = useCallback(async () => {
    const status = await ApiService.getPersonalAgentStatus().catch(() => null);
    await start(azureRetryKind(status));
  }, [start]);

  return (
    <AppPageShell as="main" width="reading">
      <AppPageHeaderRegion>
        <PageHeader title={TITLES[view.kind]} accent="neutral" />
      </AppPageHeaderRegion>
      <AppPageContentRegion className="space-y-6">
        {view.kind === "completing" || view.kind === "redirecting" ? (
          <HushhLoader label="Finishing Microsoft sign-in…" variant="inline" />
        ) : view.kind === "needs_subscription" ? (
          <AzureSubscriptionPicker
            subscriptions={view.subscriptions}
            busy={signIn.starting}
            onContinue={(subscriptionId) => start("setup", subscriptionId)}
          />
        ) : view.kind === "upgrading" ? (
          <AzureUpgradeProgress onRetry={() => start("upgrade")} retrying={signIn.starting} />
        ) : (
          <ReturnError
            message={view.message}
            onRetry={() => void retry()}
            retrying={signIn.starting}
          />
        )}
        {signIn.error ? (
          <p role="alert" className="text-sm text-destructive" data-testid="azure-sign-in-error">
            {signIn.error}
          </p>
        ) : null}
      </AppPageContentRegion>
    </AppPageShell>
  );
}
