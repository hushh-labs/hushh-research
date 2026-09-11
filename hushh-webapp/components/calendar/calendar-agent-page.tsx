"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { CalendarDays, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { AskOneButton } from "@/components/agent/ask-one-button";
import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
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
  CALENDAR_SETUP_REGION_CLASSNAME,
  CALENDAR_SETUP_SHELL_CLASSNAME,
} from "@/components/calendar/calendar-agent-page-layout";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
} from "@/components/app-ui/surfaces";
import { useAuth } from "@/hooks/use-auth";
import { HushhAuth } from "@/lib/capacitor";
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
import {
  createGoogleOAuthPopupAttempt,
  isGoogleOAuthPopupSettlement,
  navigateGoogleOAuthPopup,
  openGoogleOAuthPopup,
  readGoogleOAuthPopupSettlement,
} from "@/lib/google/google-oauth-popup";

const CALENDAR_OAUTH_POPUP_TIMEOUT_MS = 120_000;

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
  const expectedPopupAttempt = useRef<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const popupStartedAtRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!user || connectionPending) return null;
    const next = await GoogleCalendarService.status(
      await user.getIdToken(),
      user.uid,
    );
    setStatus(next);
    return next;
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

  useEffect(() => {
    const clearAttempt = () => {
      expectedPopupAttempt.current = null;
      popupRef.current = null;
      popupStartedAtRef.current = null;
      setBusy(false);
    };
    const settle = async (
      attemptId: string,
      outcome: "succeeded" | "cancelled" | "failed",
      message?: string,
    ) => {
      if (
        !expectedPopupAttempt.current ||
        attemptId !== expectedPopupAttempt.current
      ) {
        return;
      }
      clearAttempt();
      if (outcome === "succeeded") {
        const currentStatus = await refresh().catch(() => null);
        if (currentStatus?.connected) {
          morphyToast.success("Google Calendar connected.");
        } else {
          morphyToast.error(
            "Google authorization finished, but Calendar is still connecting. Check again in a moment.",
          );
        }
      } else if (outcome === "failed") {
        morphyToast.error(message || "Google Calendar could not be connected.");
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== popupRef.current ||
        !isGoogleOAuthPopupSettlement(event.data) ||
        event.data.service !== "calendar"
      ) {
        return;
      }
      void settle(event.data.attemptId, event.data.outcome, event.data.message);
    };
    const onStorage = (event: StorageEvent) => {
      const value = readGoogleOAuthPopupSettlement(event);
      if (value?.service === "calendar") {
        void settle(value.attemptId, value.outcome, value.message);
      }
    };
    const recoverAbandonedPopup = async (message: string) => {
      if (!expectedPopupAttempt.current) return;
      clearAttempt();
      const currentStatus = await refresh().catch(() => null);
      if (currentStatus?.connected) {
        morphyToast.success("Google Calendar connected.");
        return;
      }
      morphyToast.error(message);
    };
    const popupWatcher = window.setInterval(() => {
      const popup = popupRef.current;
      const startedAt = popupStartedAtRef.current;
      if (!popup || !startedAt) return;
      if (popup.closed) {
        void recoverAbandonedPopup(
          "The Google Calendar window closed before the connection finished. You can try again.",
        );
        return;
      }
      if (Date.now() - startedAt >= CALENDAR_OAUTH_POPUP_TIMEOUT_MS) {
        popup.close();
        void recoverAbandonedPopup(
          "Calendar connection is taking too long. Check your connection and try again.",
        );
      }
    }, 500);
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
      window.clearInterval(popupWatcher);
    };
  }, [refresh]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("calendar") === "error") {
      morphyToast.error("Google Calendar was not connected. Please try again.");
    }
  }, []);

  const connected =
    status?.connected === true && status.status !== "needs_reauth";

  useEffect(() => {
    onConnectionStateChange?.(connected);
  }, [connected, onConnectionStateChange]);

  const connect = async (accessLevel: "read" | "manage" = "read") => {
    if (!user) return;
    setBusy(true);
    try {
      if (journeyVariant === "onboarding") {
        markCalendarSetupOAuthReturn();
      } else {
        clearCalendarSetupOAuthReturn();
      }
      const idToken = await user.getIdToken();
      if (Capacitor.isNativePlatform()) {
        const start = await GoogleCalendarService.startNativeConnect({
          idToken,
          accessLevel,
        });
        const nativeResult = await HushhAuth.connectCalendar({
          serverClientId: start.server_client_id,
          accessLevel: start.access_level,
        });
        const completed = await GoogleCalendarService.completeNativeConnect({
          idToken,
          userId: user.uid,
          accessLevel,
          serverAuthCode: nativeResult.serverAuthCode,
        });
        setStatus(completed);
        if (!completed.connected) {
          throw new Error(
            "Calendar authorization did not create an active connection.",
          );
        }
        setBusy(false);
        morphyToast.success("Google Calendar connected.");
        return;
      }

      // Create the blank window while this click still has browser gesture
      // authority. If storage or the popup is unavailable, continue with the
      // existing same-window callback contract instead of stranding the user.
      const attempt = createGoogleOAuthPopupAttempt("calendar");
      const popup = openGoogleOAuthPopup(attempt);
      const start = await GoogleCalendarService.startConnect({
        idToken,
        userId: user.uid,
        accessLevel: accessLevel,
      });
      if (!popup) {
        window.location.assign(start.authorize_url);
        return;
      }
      expectedPopupAttempt.current = attempt.attemptId;
      popupRef.current = popup;
      popupStartedAtRef.current = Date.now();
      navigateGoogleOAuthPopup(popup, start.authorize_url);
    } catch (error) {
      popupRef.current?.close();
      expectedPopupAttempt.current = null;
      popupRef.current = null;
      popupStartedAtRef.current = null;
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
    ? "View events and availability. Enable scheduling only when you want One to propose meeting changes."
    : "View availability and manage meetings after confirmation";
  const connectLabel =
    status?.status === "needs_reauth"
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
    <AppPageShell width="reading" className={CALENDAR_SETUP_SHELL_CLASSNAME}>
      <AppPageContentRegion className={CALENDAR_SETUP_REGION_CLASSNAME}>
        <SurfaceCard className="overflow-hidden w-full shadow-md text-center">
          <SurfaceCardHeader className="pb-3 pt-5 flex flex-col items-center text-center space-y-0.5">
            <div className="flex size-11 items-center justify-center rounded-[12px] bg-primary/10 text-primary mb-2">
              <CalendarDays className="size-5" aria-hidden />
            </div>
            <SurfaceCardTitle className="text-lg font-semibold tracking-tight">
              {connected ? "Google Calendar" : "Connect Google Calendar"}
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
                  <AskOneButton
                    disabled={busy || !agentPopover}
                    onClick={() => openChat("Summarize my calendar events")}
                    // Full width at every size: this card is a centred column,
                    // not a page whose actions sit inline.
                    className="sm:w-full"
                  >
                    Try Calendar Agent with One
                  </AskOneButton>
                  {needsSchedulingReconnect ? (
                    <Button
                      variant="muted"
                      disabled={busy}
                      onClick={() => void connect("manage")}
                      className="w-full justify-center"
                    >
                      Enable scheduling
                    </Button>
                  ) : null}
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
                    onClick={() => void connect("read")}
                    className="w-full justify-center h-11 text-base font-semibold shadow-sm"
                    data-voice-control-id="open_calendar_connector"
                    data-voice-action-id={
                      journeyVariant === "onboarding"
                        ? "setup.connect_calendar"
                        : undefined
                    }
                    data-voice-label="Connect Calendar"
                    data-voice-purpose="starts read-only Google Calendar authorization from this Calendar agent."
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
                  onClick={() => void connect("read")}
                  className="w-full justify-center"
                  data-voice-control-id="open_calendar_connector"
                  data-voice-action-id={
                    journeyVariant === "onboarding"
                      ? "setup.connect_calendar"
                      : undefined
                  }
                  data-voice-label="Connect Calendar"
                  data-voice-purpose="starts read-only Google Calendar authorization from this Calendar agent."
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
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppPageShell>
  );
}
