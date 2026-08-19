"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Loader2,
  MessageCircle,
} from "lucide-react";
import { toast } from "sonner";

import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
} from "@/components/app-ui/surfaces";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import {
  clearCalendarSetupOAuthReturn,
  markCalendarSetupOAuthReturn,
} from "@/lib/calendar/calendar-oauth-journey";
import {
  GoogleCalendarService,
  type GoogleCalendarStatus,
} from "@/lib/services/google-calendar-service";
import { morphyToast } from "@/lib/morphy-ux/morphy";

type CalendarAgentPageProps = {
  journeyVariant?: "workspace" | "onboarding";
  onConnectionStateChange?: (connected: boolean) => void;
  onFinishSetup?: () => void;
  onSkipSetup?: () => void;
  finishingSetup?: boolean;
  skippingSetup?: boolean;
  /** OAuth callback is persisting the encrypted Google credential. */
  connectionPending?: boolean;
};

/**
 * Calendar's normal and onboarding surfaces share one owner-bound connection
 * body. The OAuth callback returns to this agent workspace; no profile-level
 * connected-apps surface owns Calendar anymore.
 */
export function CalendarAgentPage({
  journeyVariant = "workspace",
  onConnectionStateChange,
  onFinishSetup,
  onSkipSetup,
  finishingSetup = false,
  skippingSetup = false,
  connectionPending = false,
}: CalendarAgentPageProps) {
  const { user, loading } = useAuth();
  const agentPopover = useOptionalAgentPopover();
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!user || connectionPending) return;
    setStatus(
      await GoogleCalendarService.status(await user.getIdToken(), user.uid),
    );
  }, [connectionPending, user]);

  useEffect(() => {
    void refresh().catch((error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to load Calendar connection.",
      );
    });
  }, [refresh]);

  const connected =
    status?.connected === true && status.status !== "needs_reauth";

  useEffect(() => {
    onConnectionStateChange?.(connected);
  }, [connected, onConnectionStateChange]);

  /**
   * Ask for Calendar event management and free/busy once. Creating, changing,
   * and cancelling meetings remain confirmation-bound in the private agent;
   * this only avoids an unnecessary second OAuth trip for scheduling access.
   */
  const connect = async () => {
    if (!user) return;
    setBusy(true);
    try {
      if (journeyVariant === "onboarding") {
        markCalendarSetupOAuthReturn();
      } else {
        clearCalendarSetupOAuthReturn();
      }
      const start = await GoogleCalendarService.startConnect({
        idToken: await user.getIdToken(),
        userId: user.uid,
        accessLevel: "manage",
      });
      window.location.assign(start.authorize_url);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to connect Calendar.",
      );
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!user) return;
    setBusy(true);
    const operation = user
      .getIdToken()
      .then((idToken) => GoogleCalendarService.disconnect(idToken, user.uid));
    void morphyToast.promise(operation, {
      loading: "Disconnecting Google Calendar…",
      success: "Google Calendar disconnected.",
      error: "Google Calendar couldn’t be disconnected. Try again.",
      variant: "destructive",
    });
    try {
      const next = await operation;
      setStatus(next);
      setDisconnectConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const needsSchedulingReconnect =
    connected && status?.access_level !== "manage";
  const detail = connectionPending
    ? "Saving secure Google Calendar connection…"
    : !status
    ? "Checking Calendar connection…"
    : connected
      ? `${status.google_email || "Google account"}`
      : status.status === "needs_reauth"
        ? "Google authorization needs to be refreshed."
        : "One reads your schedule to help you plan.";

  const connectionLabel = connectionPending
    ? "Finishing connection"
    : connected
      ? "Connected"
      : status?.status === "needs_reauth"
        ? "Reconnect needed"
        : "Not connected";
  const permissionLabel = needsSchedulingReconnect
    ? "View events and availability"
    : "View availability and manage meetings after confirmation";
  const connectLabel = status?.status === "needs_reauth"
    ? "Reconnect Calendar"
    : "Connect Calendar";
  const shouldShowSetup = !connected && status?.status !== "needs_reauth";
  const isDisconnected = !connected;

  const openChat = (prompt?: string) => {
    if (!agentPopover) return;
    if (!prompt) {
      agentPopover.openAgent();
      return;
    }
    const createdAtMs = Date.now();
    agentPopover.openAgent({
      handoff: {
        id: `calendar-prompt-${createdAtMs}`,
        reason: "user_requested",
        transcript: prompt,
        createdAtMs,
      },
    });
  };

  return (
    <AppPageShell
      width="reading"
      className="motion-step-enter fixed inset-x-0 top-[64px] bottom-[115px] z-10 m-auto flex w-full max-w-[720px] flex-col items-center justify-center overflow-hidden px-4"
    >
      <AppPageHeaderRegion className="w-full max-w-md mx-auto mb-4 text-center">
        <PageHeader
          title="Calendar"
          className="text-center flex flex-col items-center justify-center space-y-1.5"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="w-full max-w-md mx-auto">
        <SurfaceCard className="overflow-hidden w-full shadow-md text-center">
          <SurfaceCardHeader className="pb-3 pt-5 flex flex-col items-center text-center space-y-0.5">
            <div className="flex size-11 items-center justify-center rounded-[12px] bg-primary/10 text-primary mb-2">
              <CalendarDays className="size-5" aria-hidden />
            </div>
            <SurfaceCardTitle className="text-lg font-semibold tracking-tight">
              {connected
                ? "Google Calendar"
                : "Connect Google Calendar"}
            </SurfaceCardTitle>
            <SurfaceCardDescription className="text-xs text-muted-foreground !mt-0.5">
              {detail}
            </SurfaceCardDescription>
          </SurfaceCardHeader>

          <SurfaceCardContent className="space-y-4 pt-0">
            {connectionPending || loading || (!status && !user) ? (
              <span className="inline-flex items-center gap-2 border-t border-border/60 pt-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {connectionPending
                  ? "Finishing Calendar connection…"
                  : "Loading Calendar…"}
              </span>
            ) : connected ? (
              <div className="border-t border-border/60 pt-4 space-y-4 flex flex-col items-center">
                {/* Connection Status & Permission */}
                <div className="flex flex-col items-center gap-1.5 text-center px-2">
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                    <span>{connectionLabel}</span>
                  </div>
                  <p className="text-xs text-muted-foreground max-w-sm leading-normal">
                    {permissionLabel}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex flex-col items-center gap-2.5 w-full pt-1">
                  <Button
                    disabled={busy || !agentPopover}
                    onClick={() => openChat("Summarize my calendar events")}
                    className="w-full justify-center"
                  >
                    <MessageCircle className="size-4" aria-hidden />
                    Try Calendar Agent with One
                  </Button>
                  <button
                    type="button"
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none"
                    disabled={busy}
                    onClick={() => setDisconnectConfirmOpen(true)}
                  >
                    Disconnect Calendar
                  </button>
                </div>
              </div>
            ) : shouldShowSetup ? (
              <div className="border-t border-border/60 pt-4 pb-1">
                <div className="flex flex-col items-center justify-center text-center space-y-3 w-full">
                  <Button
                    disabled={busy}
                    onClick={() => void connect()}
                    className="w-full justify-center h-11 text-base font-semibold shadow-sm"
                    data-voice-control-id="open_calendar_connector"
                    data-voice-action-id={
                      journeyVariant === "onboarding"
                        ? "setup.connect_calendar"
                        : undefined
                    }
                    data-voice-label={connectLabel}
                    data-voice-purpose="starts Google Calendar authorization from this Calendar agent."
                  >
                    {connectLabel}
                  </Button>
                  <p className="text-xs text-muted-foreground text-center">
                    Private by default. Disconnect anytime.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 border-t border-border/60 pt-4">
                <Button
                  disabled={busy}
                  onClick={() => void connect()}
                  className="w-full justify-center"
                  data-voice-control-id="open_calendar_connector"
                  data-voice-action-id={
                    journeyVariant === "onboarding"
                      ? "setup.connect_calendar"
                      : undefined
                  }
                  data-voice-label="Connect Calendar"
                  data-voice-purpose="starts Google Calendar authorization from this Calendar agent."
                >
                  {connectLabel}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Reconnect to keep using Calendar with One.
                </p>
              </div>
            )}
          </SurfaceCardContent>
        </SurfaceCard>

        {journeyVariant === "onboarding" && onFinishSetup && onSkipSetup ? (
          <SetupCompletionFooter
            label={connected ? "Finish setup" : "Skip for now"}
            onComplete={connected ? onFinishSetup : onSkipSetup}
            busy={connected ? finishingSetup : skippingSetup}
            disabled={busy}
            controlId={
              connected ? "finish_calendar_setup" : "skip_calendar_setup"
            }
            actionId={
              connected ? "setup.finish_calendar" : "setup.skip_calendar"
            }
            purpose={
              connected
                ? "records the verified Calendar connection and returns to setup."
                : "returns to setup without recording Calendar as complete."
            }
            variant={connected ? "blue-gradient" : "none"}
            effect={connected ? "fill" : "fade"}
            supportingText={
              connected
                ? undefined
                : "You can connect Calendar whenever you are ready."
            }
          />
        ) : null}
      </AppPageContentRegion>

      <AlertDialog
        open={disconnectConfirmOpen}
        onOpenChange={setDisconnectConfirmOpen}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader className="text-center">
            <AlertDialogTitle>Disconnect Google Calendar?</AlertDialogTitle>
            <AlertDialogDescription>
              One won’t be able to access your calendar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row justify-center gap-2">
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void disconnect();
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppPageShell>
  );
}
