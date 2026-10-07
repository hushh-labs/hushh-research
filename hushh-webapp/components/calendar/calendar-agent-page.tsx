"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { CheckCircle2, Loader2 } from "@/components/icons";
import { toast } from "sonner";

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
import { CalendarConnectHero } from "@/components/calendar/calendar-connect-hero";

import { useAuth } from "@/hooks/use-auth";
import { HushhAuth } from "@/lib/capacitor";
import {
  clearCalendarSetupOAuthReturn,
  markCalendarSetupOAuthReturn,
} from "@/lib/calendar/calendar-oauth-journey";
import {
  GoogleCalendarService,
  type GoogleCalendarStatus,
} from "@/lib/services/google-calendar-service";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { navigateToAgentChat } from "@/lib/navigation/agent-navigation";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { trackEvent } from "@/lib/observability/client";
import { ROUTES } from "@/lib/navigation/routes";
import {
  createGoogleOAuthPopupAttempt,
  consumeStoredGoogleOAuthPopupSettlement,
  isGoogleOAuthPopupSettlement,
  navigateGoogleOAuthPopup,
  openGoogleOAuthPopup,
  persistGoogleOAuthSameWindowAttempt,
  readGoogleOAuthPopupSettlement,
  type GoogleOAuthPopupSettlement,
} from "@/lib/google/google-oauth-popup";
import { waitForOAuthPopup } from "@/lib/profile/drive-oauth-popup";

const CALENDAR_OAUTH_POPUP_TIMEOUT_MS = 120_000;

function CalendarConnectIcon({
  className = "size-10 mb-2.5",
  style = { color: "#FF3B30" },
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={className}
      style={style}
    >
      <rect
        x="8.5"
        y="11.5"
        width="31"
        height="29"
        rx="4.5"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        d="M9.5 20.5h29M16 7.5v8M32 7.5v8"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {[16, 24, 32].flatMap((x) =>
        [27, 35].map((y) => (
          <rect
            key={`${x}-${y}`}
            x={x - 2}
            y={y - 2}
            width="4"
            height="4"
            rx="1"
            fill="currentColor"
          />
        )),
      )}
    </svg>
  );
}

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
  const renderedOwnerId = user?.uid ?? null;
  const activeOwnerIdRef = useRef<string | null>(renderedOwnerId);
  activeOwnerIdRef.current = renderedOwnerId;
  useEffect(() => {
    activeOwnerIdRef.current = renderedOwnerId;
    return () => {
      if (activeOwnerIdRef.current === renderedOwnerId) {
        activeOwnerIdRef.current = null;
      }
    };
  }, [renderedOwnerId]);
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);
  // Google's opener policy can sever the popup's WindowProxy, so
  // `popup.closed` is not evidence of anything. The shared handler settles on
  // the exact callback, an explicit Cancel sign-in, or bounded expiry.
  const popupCancelRef = useRef<AbortController | null>(null);
  const popupLifetimeRef = useRef<AbortController | null>(null);
  const [popupWaiting, setPopupWaiting] = useState(false);
  useEffect(() => {
    const lifetime = new AbortController();
    popupLifetimeRef.current = lifetime;
    return () => lifetime.abort();
  }, []);

  const refresh = useCallback(async () => {
    if (!user || connectionPending) return null;
    const operationOwnerId = user.uid;
    const next = await GoogleCalendarService.status(
      await user.getIdToken(),
      operationOwnerId,
    );
    if (activeOwnerIdRef.current !== operationOwnerId) return null;
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

  /** The callback verified the connection before settling; keep it authoritative. */
  const applyVerifiedSuccess = (accessLevel: "read" | "manage") => {
    setStatus((current) => ({
      configured: current?.configured ?? true,
      connected: true,
      google_email: current?.google_email,
      status: "connected",
      access_level: accessLevel ?? current?.access_level ?? null,
      scope_csv: current?.scope_csv ?? "",
    }));
    morphyToast.success("Google Calendar connected.");
  };

  /** Expiry or an explicit cancel: re-read status before saying anything. */
  const reconcileUnsettledPopup = async (input: {
    operationOwnerId: string;
    accessLevel: "read" | "manage";
    callbackRecorded: boolean;
    expired: boolean;
  }) => {
    const currentStatus = await refresh().catch(() => null);
    if (activeOwnerIdRef.current !== input.operationOwnerId) return;
    if (
      currentStatus?.connected &&
      (input.accessLevel !== "manage" ||
        currentStatus.access_level === "manage")
    ) {
      if (!input.callbackRecorded) {
        trackEvent("one_calendar_action", { route_id: "one_calendar", action: "connected", result: "success" });
      }
      morphyToast.success("Google Calendar connected.");
      return;
    }
    if (!input.callbackRecorded) {
      trackEvent("one_calendar_action", {
        route_id: "one_calendar",
        action: "connected",
        result: input.expired ? "error" : "expected_error",
      });
    }
    // Cancelling is the person's choice: end quietly. Only expiry explains.
    if (input.expired) {
      morphyToast.error(
        "Calendar connection is taking too long. Check your connection and try again.",
      );
    }
  };

  const connect = async (accessLevel: "read" | "manage" = "read") => {
    if (!user) return;
    const operationOwnerId = user.uid;
    const native = Capacitor.isNativePlatform();
    // Open the consent window inside this click, before any await, so the
    // browser keeps the gesture. A refused popup falls back to a new tab.
    const attempt = native
      ? null
      : createGoogleOAuthPopupAttempt("calendar", {
          ownerId: operationOwnerId,
          accessLevel,
        });
    const popup = attempt ? openGoogleOAuthPopup(attempt) : null;
    setBusy(true);
    try {
      if (journeyVariant === "onboarding") {
        markCalendarSetupOAuthReturn();
      } else {
        clearCalendarSetupOAuthReturn();
      }
      const idToken = await user.getIdToken();
      if (activeOwnerIdRef.current !== operationOwnerId) {
        popup?.close();
        return;
      }
      if (native) {
        const start = await GoogleCalendarService.startNativeConnect({
          idToken,
          accessLevel,
        });
        if (activeOwnerIdRef.current !== operationOwnerId) return;
        const nativeResult = await HushhAuth.connectCalendar({
          serverClientId: start.server_client_id,
          accessLevel: start.access_level,
        });
        if (activeOwnerIdRef.current !== operationOwnerId) return;
        const completed = await GoogleCalendarService.completeNativeConnect({
          idToken,
          userId: operationOwnerId,
          accessLevel,
          serverAuthCode: nativeResult.serverAuthCode,
          state: start.state,
        });
        if (activeOwnerIdRef.current !== operationOwnerId) return;
        if (
          !completed.connected ||
          (accessLevel === "manage" && completed.access_level !== "manage")
        ) {
          throw new Error(
            accessLevel === "manage"
              ? "Calendar authorization did not grant meeting management access."
              : "Calendar authorization did not create an active connection.",
          );
        }
        setStatus(completed);
        setBusy(false);
        trackEvent("one_calendar_action", { route_id: "one_calendar", action: "connected", result: "success" });
        morphyToast.success("Google Calendar connected.");
        return;
      }

      const start = await GoogleCalendarService.startConnect({
        idToken,
        userId: operationOwnerId,
        accessLevel: accessLevel,
      });
      if (activeOwnerIdRef.current !== operationOwnerId) {
        popup?.close();
        return;
      }
      if (!popup || !attempt) {
        // No popup or tab: this standalone page keeps its existing
        // same-window callback contract instead of stranding the person.
        const sameWindow =
          attempt ??
          createGoogleOAuthPopupAttempt("calendar", {
            ownerId: operationOwnerId,
            accessLevel,
          });
        if (!persistGoogleOAuthSameWindowAttempt(sameWindow)) {
          throw new Error(
            "Calendar sign-in could not be started safely. Please try again.",
          );
        }
        window.location.assign(start.authorize_url);
        return;
      }
      const lifetime = popupLifetimeRef.current?.signal ?? new AbortController().signal;
      const cancel = new AbortController();
      popupCancelRef.current = cancel;
      setPopupWaiting(true);
      // Written by the handler's callbacks, read after it resolves.
      let settlement = null as GoogleOAuthPopupSettlement | null;
      let finished = "aborted" as "settled" | "closed" | "expired" | "aborted";
      navigateGoogleOAuthPopup(popup, start.authorize_url);
      try {
        await waitForOAuthPopup({
          popup,
          signal: lifetime,
          cancelSignal: cancel.signal,
          expiresAt: Date.now() + CALENDAR_OAUTH_POPUP_TIMEOUT_MS,
          matches: (value) => {
            if (
              !isGoogleOAuthPopupSettlement(value) ||
              value.service !== "calendar" ||
              value.attemptId !== attempt.attemptId
            )
              return false;
            settlement = value;
            return true;
          },
          storageValue: readGoogleOAuthPopupSettlement,
          onFinish: (reason) => {
            finished = reason;
          },
        });
      } finally {
        if (popupCancelRef.current === cancel) popupCancelRef.current = null;
      }
      if (lifetime.aborted) return;
      setPopupWaiting(false);
      const callbackSettlement = consumeStoredGoogleOAuthPopupSettlement(
        attempt.attemptId,
      );
      if (activeOwnerIdRef.current !== operationOwnerId) return;
      const settled = settlement;
      if (finished === "settled" && settled) {
        if (settled.outcome === "succeeded") applyVerifiedSuccess(accessLevel);
        else if (settled.outcome === "failed")
          morphyToast.error(settled.message || "Google Calendar could not be connected.");
      } else {
        await reconcileUnsettledPopup({
          operationOwnerId,
          accessLevel,
          callbackRecorded: Boolean(callbackSettlement),
          expired: finished === "expired",
        });
      }
      if (activeOwnerIdRef.current === operationOwnerId) setBusy(false);
    } catch (error) {
      if (activeOwnerIdRef.current !== operationOwnerId) return;
      const result =
        error && typeof error === "object" && "code" in error &&
        error.code === "USER_CANCELLED"
          ? "expected_error"
          : "error";
      trackEvent("one_calendar_action", { route_id: "one_calendar", action: "connected", result });
      popup?.close();
      setPopupWaiting(false);
      toast.error(
        error instanceof Error ? error.message : "Unable to connect Calendar.",
      );
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!user) return;
    const operationOwnerId = user.uid;
    setBusy(true);
    const operation = user
      .getIdToken()
      .then((idToken) => {
        if (activeOwnerIdRef.current !== operationOwnerId) {
          throw new Error("Calendar account changed.");
        }
        return GoogleCalendarService.disconnect(idToken, operationOwnerId);
      });
    void morphyToast.promise(operation, {
      loading: "Disconnecting Google Calendar…",
      success: "Google Calendar disconnected.",
      error: "Google Calendar couldn’t be disconnected. Try again.",
      variant: "destructive",
    });
    try {
      const next = await operation;
      if (activeOwnerIdRef.current !== operationOwnerId) return;
      trackEvent("one_calendar_action", { route_id: "one_calendar", action: "disconnected", result: "success" });
      setStatus(next);
      setDisconnectConfirmOpen(false);
    } catch (error) {
      if (activeOwnerIdRef.current !== operationOwnerId) return;
      trackEvent("one_calendar_action", { route_id: "one_calendar", action: "disconnected", result: "error" });
      throw error;
    } finally {
      if (activeOwnerIdRef.current === operationOwnerId) setBusy(false);
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
    ? "View events and availability with One."
    : "View availability and manage meetings with One.";
  const needsReauth = status?.status === "needs_reauth";
  const checkingConnection =
    connectionPending || loading || (!status && !user);
  // Every not-connected resting state (first connect and a lapsed Google
  // authorization) shares one hero and one action.
  const showConnectHero = !connected && !checkingConnection;

  const popupWaitingNotice = popupWaiting ? (
    <div className="flex flex-col items-center gap-2 pt-3 text-center">
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
        Finish signing in with Google in the window that opened.
      </p>
      <button
        type="button"
        className="min-h-11 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
        onClick={() => popupCancelRef.current?.abort()}
      >
        Cancel sign-in
      </button>
    </div>
  ) : null;

  const openChat = (prompt?: string) => {
    trackEvent("one_calendar_action", { route_id: "one_calendar", action: "chat_opened", result: "success" });
    if (!prompt) {
      navigateToAgentChat();
      return;
    }
    const createdAtMs = Date.now();
    useOneConversationSession.getState().createHandoff({
      id: `calendar-prompt-${createdAtMs}`,
      reason: "user_requested",
      transcript: prompt,
      createdAtMs,
    });
    navigateToAgentChat();
  };

  return (
    <AppPageShell
      width="reading"
      className={CALENDAR_SETUP_SHELL_CLASSNAME}
      nativeTest={{
        routeId: ROUTES.CALENDAR,
        marker: "native-route-calendar",
        authState: user ? "authenticated" : loading ? "pending" : "anonymous",
        dataState:
          connectionPending || loading
            ? "loading"
            : status === null
              ? "unavailable-valid"
              : connected
                ? "loaded"
                : "empty-valid",
      }}
    >
      <AppPageContentRegion className={CALENDAR_SETUP_REGION_CLASSNAME}>
        {showConnectHero ? (
          <CalendarConnectHero
            journeyVariant={journeyVariant}
            busy={busy}
            needsReauth={needsReauth}
            onConnect={() => void connect("read")}
          >
            {popupWaitingNotice}
          </CalendarConnectHero>
        ) : (
          <div className="flex flex-col items-center text-center space-y-1 pb-4 pt-8 max-w-sm mx-auto">
            <div className="mb-6 flex size-24 items-center justify-center rounded-[24px] bg-[#FFF0F1] dark:bg-red-950/40">
              <CalendarConnectIcon className="size-11" style={{ color: "#FF3B30" }} />
            </div>

            <h2 className="text-2xl sm:text-[26px] font-bold tracking-tight text-foreground">
              {connected ? "Google Calendar" : "Connect Google Calendar"}
            </h2>

            <p className="text-base text-muted-foreground/80 mt-1 max-w-xs leading-normal">
              {detail}
            </p>

            <div className="space-y-4 pt-6 w-full flex flex-col items-center">
              {checkingConnection ? (
                <span className="inline-flex items-center gap-2 pt-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {connectionPending
                    ? "Finishing Calendar connection…"
                    : "Loading Calendar…"}
                </span>
              ) : (
                <div className="pt-2 space-y-4 flex flex-col items-center w-full">
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
                      disabled={busy}
                      showIcon={false}
                      onClick={() => openChat("Summarize my calendar events and help me plan meetings")}
                      className="w-full rounded-full"
                    >
                      Try Calendar Agent with One
                    </AskOneButton>
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
              )}
              {popupWaitingNotice}
            </div>
          </div>
        )}

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
