"use client";

import { useCallback } from "react";
import { CheckCircle2, Mail, MessageCircle } from "lucide-react";
import { useRouter } from "next/navigation";

import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
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
import { ROUTES } from "@/lib/navigation/routes";

const EMAIL_AGENT_PROMPT =
  "Help me draft an email. I will review and approve it before anything is sent.";

/**
 * A compact entry point for Gmail-powered drafting. The connection itself is
 * owned by the Gmail workspace so the app has exactly one OAuth/token store.
 */
export function EmailAgentPageClient() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const agentPopover = useOptionalAgentPopover();
  const gmail = useGmailConnectorStatus({
    userId: user?.uid || null,
    enabled: Boolean(user?.uid) && !authLoading,
    idTokenProvider: user?.getIdToken ? () => user.getIdToken() : null,
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
    const createdAtMs = Date.now();
    if (agentPopover) {
      agentPopover.openAgent({
        handoff: {
          id: `email-agent-prompt-${createdAtMs}`,
          reason: "user_requested",
          emailDraftInstruction: EMAIL_AGENT_PROMPT,
          createdAtMs,
        },
      });
      return;
    }
    // This fallback retains navigation if this page is rendered outside the
    // app provider. The normal app shell always uses the in-memory handoff.
    router.push(ROUTES.AGENT);
  }, [agentPopover, router]);

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="min-h-[calc(100dvh-var(--top-shell-reserved-height,4rem))] pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10"
      nativeTest={{
        routeId: ROUTES.EMAIL_AGENT,
        marker: "native-route-email-agent",
        authState: user ? "authenticated" : "pending",
        dataState,
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="Email Agent"
          description="Use Gmail context to classify receipts and inbox activity, then draft mail with One. Every email stays editable and needs your final Send email click."
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SurfaceStack compact>
          {authLoading || gmail.loadingStatus ? (
            <SurfaceInset aria-busy="true" aria-label="Loading Gmail connection" className="space-y-4 px-4 py-5 sm:px-5">
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
                  <h2 className="font-semibold text-foreground">Gmail connected</h2>
                  <p className="text-sm leading-6 text-muted-foreground">
                    One can use your Gmail connection for receipt and inbox context, and help draft an email. Sending remains off until you enable it in Gmail, then review each draft and click Send email.
                  </p>
                </div>
              </div>
              <Button type="button" onClick={openOneForDraft} className="w-full sm:w-auto">
                <MessageCircle className="mr-2 h-4 w-4" />
                Try Email Agent with One
              </Button>
            </SurfaceInset>
          ) : (
            <SurfaceInset className="space-y-4 px-4 py-5 sm:px-5">
              <div className="flex items-start gap-3">
                <Mail className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="space-y-1">
                  <h2 className="font-semibold text-foreground">Connect Gmail</h2>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Connect Gmail once to classify receipts and inbox context, and to prepare approval-gated email drafts. One will never send from a chat reply.
                  </p>
                </div>
              </div>
              <Button type="button" onClick={() => router.push(ROUTES.GMAIL)} className="w-full sm:w-auto">
                <Mail className="mr-2 h-4 w-4" />
                Connect Gmail
              </Button>
            </SurfaceInset>
          )}
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
