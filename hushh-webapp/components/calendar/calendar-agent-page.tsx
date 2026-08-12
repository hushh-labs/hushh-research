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
    ? "Saving your secure Google Calendar connection…"
    : !status
    ? "Checking your Calendar connection…"
    : connected
      ? `${status.google_email || "Google account"} · ${
          needsSchedulingReconnect
            ? "View events and availability"
            : "Scheduling enabled — meeting changes always need your confirmation"
        }`
      : status.status === "needs_reauth"
        ? "Your Google authorization needs to be refreshed."
        : "Connect once to summarize your schedule, find availability, and schedule confirmed meetings.";

  const connectionLabel = connectionPending
    ? "Finishing connection"
    : connected
      ? "Connected"
      : status?.status === "needs_reauth"
        ? "Reconnect needed"
        : "Not connected";
  const permissionLabel = needsSchedulingReconnect
    ? "View events and availability"
    : "View availability and create, reschedule, or cancel meetings after your confirmation";
  const connectLabel = status?.status === "needs_reauth"
    ? "Reconnect Calendar"
    : "Connect Calendar";
  const shouldShowSetup = !connected && status?.status !== "needs_reauth";

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
    <AppPageShell width="reading" className="motion-step-enter">
      <AppPageHeaderRegion>
        <PageHeader
          title="Calendar"
          description="Plan your schedule with One."
          icon={CalendarDays}
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SurfaceCard className="overflow-hidden">
          <SurfaceCardHeader className="pb-4 sm:pb-5">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-primary/10 text-primary sm:size-11">
                <CalendarDays className="size-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <SurfaceCardTitle>
                  {connected
                    ? "Google Calendar is connected"
                    : "Connect Google Calendar"}
                </SurfaceCardTitle>
                <SurfaceCardDescription className="mt-1.5 max-w-2xl">
                  {detail}
                </SurfaceCardDescription>
              </div>
            </div>
          </SurfaceCardHeader>
          <SurfaceCardContent className="space-y-0">
            {connectionPending || loading || (!status && !user) ? (
              <span className="inline-flex items-center gap-2 border-t border-border/60 pt-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {connectionPending
                  ? "Finishing Calendar connection…"
                  : "Loading Calendar…"}
              </span>
            ) : connected ? (
              <div className="border-t border-border/60 pt-4 sm:pt-5">
                <div className="grid gap-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:gap-6">
                  <div className="flex items-start gap-3">
                    <CheckCircle2
                      className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-300"
                      aria-hidden
                    />
                    <div>
                      <p className="text-sm text-muted-foreground">Connection</p>
                      <p className="mt-1 font-semibold text-foreground">
                        {connectionLabel}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {status?.google_email || "Google account"}
                      </p>
                    </div>
                  </div>
                  <div className="border-t border-border/60 pt-4 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
                    <p className="text-sm text-muted-foreground">One can help you</p>
                    <p className="mt-1.5 font-semibold leading-6 text-foreground">
                      {permissionLabel}
                    </p>
                    <p className="mt-2 text-sm leading-5 text-muted-foreground">
                      Every create, reschedule, or cancellation still needs
                      your confirmation.
                    </p>
                  </div>
                </div>
                <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Button
                    disabled={busy || !agentPopover}
                    onClick={() => openChat("Summarize my calendar events")}
                    className="w-full sm:w-auto"
                  >
                    <MessageCircle className="size-4" aria-hidden />
                    Try Calendar Agent with One
                  </Button>
                  <button
                    type="button"
                    className="text-sm font-semibold text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    disabled={busy}
                    onClick={() => setDisconnectConfirmOpen(true)}
                  >
                    Disconnect Calendar
                  </button>
                </div>
              </div>
            ) : shouldShowSetup ? (
              <div className="border-t border-border/60 pt-4 sm:pt-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                  <Button
                    disabled={busy}
                    onClick={() => void connect()}
                    className="w-full sm:w-auto"
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
                  <p className="text-sm leading-5 text-muted-foreground">
                    Private by default. You can disconnect at any time.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:gap-3">
                <Button
                  disabled={busy}
                  onClick={() => void connect()}
                  className="w-full sm:w-auto"
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
                <p className="text-sm text-muted-foreground">
                  Reconnect to keep using Calendar with One.
                </p>
              </div>
            )}
          </SurfaceCardContent>
        </SurfaceCard>

        {journeyVariant === "onboarding" && onFinishSetup && onSkipSetup ? (
          <SetupCompletionFooter
            label={connected ? "Finish Calendar setup" : "Skip Calendar setup"}
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
                : "You can connect Calendar from setup whenever you are ready."
            }
          />
        ) : null}
      </AppPageContentRegion>

      <AlertDialog
        open={disconnectConfirmOpen}
        onOpenChange={setDisconnectConfirmOpen}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Google Calendar?</AlertDialogTitle>
            <AlertDialogDescription>
              One will no longer be able to view or manage your calendar until you connect it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep connected</AlertDialogCancel>
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
