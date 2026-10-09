"use client";

import { useCallback } from "react";
import { CheckCircle2, Mail } from "@/components/icons";
import { useRouter } from "next/navigation";

import { AskOneButton } from "@/components/agent/ask-one-button";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { Button } from "@/lib/morphy-ux/button";
import { navigateToAgentChat } from "@/lib/navigation/agent-navigation";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * A compact entry point for Gmail-powered drafting. The connection itself is
 * owned by the Gmail workspace so the app has exactly one OAuth/token store.
 */
export function EmailAgentPageClient() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const idTokenProvider = useCallback(
    () => (user?.getIdToken ? user.getIdToken() : Promise.resolve("")),
    [user],
  );
  const gmail = useGmailConnectorStatus({
    userId: user?.uid || null,
    enabled: Boolean(user?.uid) && !authLoading,
    idTokenProvider: user?.getIdToken ? idTokenProvider : null,
    routeHref: ROUTES.EMAIL_AGENT,
    refreshKey: user?.uid || "",
  });
  const connected = gmail.presentation.isConnected;
  const dataState = authLoading || gmail.loadingStatus
    ? "loading"
    : connected
      ? "loaded"
      : "unavailable-valid";

  const openOneForDraft = useCallback(() => {
    // Enter with an empty composer; only the owner's instruction starts a turn.
    navigateToAgentChat();
  }, []);

  return (
    <AppPageShell
      as="main"
      width="reading"
      // Subtract BOTH edges the scroll root spends, not just the top bar. The
      // shell renders a top spacer of --app-top-content-offset AND pads the
      // scroll root by --app-bottom-content-clearance; a floor that only
      // subtracts the bar turns the rest into empty travel. No pb- either: the
      // scroll root already owns the bottom bars.
      // Canonical idiom: components/calendar/calendar-agent-page-layout.ts:48.
      className="min-h-[calc(100dvh-var(--app-top-content-offset,6rem)-var(--app-bottom-content-clearance,7rem))]"
      nativeTest={{
        routeId: ROUTES.EMAIL_AGENT,
        marker: "native-route-email-agent",
        authState: user ? "authenticated" : "pending",
        dataState,
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="Mail Agent"
          description="Use Mail context to classify receipts and inbox activity, then draft mail with One. Every mail message stays editable and needs your final Send click."
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SurfaceStack compact>
          {authLoading || gmail.loadingStatus ? (
            <SurfaceInset aria-busy="true" aria-label="Loading Mail connection" className="space-y-4 px-4 py-5 sm:px-5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-7 w-44" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-10 w-44" />
            </SurfaceInset>
          ) : connected ? (
            <SurfaceInset className="space-y-4 px-4 py-5 sm:px-5">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
                <div className="space-y-1">
                  <h2 className="font-semibold text-foreground">Mail connected</h2>
                  <p className="text-sm leading-6 text-muted-foreground">
                    One can use your Mail connection for receipt and inbox context, and help draft a mail message. Review each draft, then click Send when you are ready.
                  </p>
                </div>
              </div>
              <AskOneButton onClick={openOneForDraft}>
                Ask One about Mail
              </AskOneButton>
            </SurfaceInset>
          ) : (
            <SurfaceInset className="space-y-4 px-4 py-5 sm:px-5">
              <div className="flex items-start gap-3">
                <Mail className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="space-y-1">
                  <h2 className="font-semibold text-foreground">Connect Mail</h2>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Connect Mail once to classify receipts and inbox context, and to prepare approval-gated mail drafts. One will never send from a chat reply.
                  </p>
                </div>
              </div>
              <Button type="button" onClick={() => router.push(ROUTES.GMAIL)} className="w-full sm:w-auto">
                <Mail className="mr-2 h-4 w-4" />
                Connect Mail
              </Button>
            </SurfaceInset>
          )}
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
