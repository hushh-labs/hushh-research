"use client";

import { useVault } from '@/lib/vault/vault-context';
import { snapshotVaultSessionEpoch } from '@/lib/vault/session-epoch';
import { useGoogleConnectorTransitionReview } from '@/components/connections/google-connector-transition-review';
import { ownerContentIsPrivate } from '@/lib/services/private-agent-specialist-chat';
import { connectGoogleConnector, connectRefusalMessage } from '@/lib/one/google-native-connect';
import { requestGoogleConnectorPhoneHandoff } from '@/lib/one/google-connector-intent';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { CheckCircle2, Loader2 } from "@/components/icons";
import { toast } from "sonner";

import { CalendarConnectedWorkspace } from "@/components/calendar/calendar-connected-workspace";
import { connectGmailInPlace } from "@/lib/connections/google-connect-in-place";
import { AskOneButton } from "@/components/agent/ask-one-button";
import { Button } from "@/components/ui/button";
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
import { CalendarCompactAction } from "@/components/calendar/calendar-compact-action";
import presentationStyles from "@/components/calendar/calendar-presentation.module.css";

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
import { trackEvent } from "@/lib/observability/client";
import { openCalendarChat } from "@/lib/calendar/calendar-chat-handoff";
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
  const { vaultKey, vaultOwnerToken } = useVault();
  const { confirmTransition, transitionDialog } = useGoogleConnectorTransitionReview(user?.uid, snapshotVaultSessionEpoch());
  const renderedOwnerId = user?.uid ?? null;
  const latestUserRef = useRef(user);
  useEffect(() => {
    latestUserRef.current = user;
  }, [user]);
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
  const identity = useMemo(() => Symbol(`calendar-page-${Boolean(renderedOwnerId)}`), [renderedOwnerId]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const statusRequestRef = useRef(0);
  const [statusSnapshot, setStatusSnapshot] = useState<{
    identity: symbol; value: GoogleCalendarStatus | null; error: string | null;
  }>({ identity, value: null, error: null });
  const status = statusSnapshot.identity === identity ? statusSnapshot.value : null;
  const statusError = statusSnapshot.identity === identity ? statusSnapshot.error : null;
  // A verified connect/disconnect supersedes any earlier status request.
  const setStatus = (value: GoogleCalendarStatus | ((current: GoogleCalendarStatus | null) => GoogleCalendarStatus)) => {
    statusRequestRef.current += 1;
    setStatusSnapshot((current) => ({
      identity,
      error: null,
      value: typeof value === "function"
        ? value(current.identity === identity ? current.value : null) : value,
    }));
  };
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (value: boolean) => { busyRef.current = value; setBusyState(value); };
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);
  const [disconnectAccountId, setDisconnectAccountId] = useState("default");
  const disconnectTriggerRef = useRef<HTMLButtonElement | null>(null);
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

  useEffect(() => {
    setBusy(false);
    setPopupWaiting(false);
    setDisconnectConfirmOpen(false);
    return () => {
      statusRequestRef.current += 1;
      popupCancelRef.current?.abort();
    };
  }, [identity]);

  const refresh = useCallback(async () => {
    const currentUser = latestUserRef.current;
    if (!currentUser || connectionPending) return null;
    if (currentUser.uid !== renderedOwnerId) return null;
    const operationOwnerId = currentUser.uid;
    const request = ++statusRequestRef.current;
    const isCurrent = () => identityRef.current === identity &&
      statusRequestRef.current === request && activeOwnerIdRef.current === operationOwnerId;
    setStatusSnapshot((current) => ({
      identity,
      value: current.identity === identity ? current.value : null,
      error: null,
    }));
    try {
      const idToken = await currentUser.getIdToken();
      if (!isCurrent()) return null;
      const next = await GoogleCalendarService.status(idToken, operationOwnerId);
      if (!isCurrent()) return null;
      setStatusSnapshot({ identity, value: next, error: null });
      return next;
    } catch (error) {
      if (!isCurrent()) return null;
      setStatusSnapshot((current) => ({
        identity,
        value: current.identity === identity ? current.value : null,
        error: "Calendar connection couldn’t load. Try again.",
      }));
      throw error;
    }
  }, [connectionPending, renderedOwnerId, identity]);

  useEffect(() => {
    void refresh().catch((error) => {
      if (identityRef.current !== identity) return;
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to load Calendar connection.",
      );
    });
  }, [refresh, identity]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("calendar") === "error") {
      morphyToast.error("Google Calendar was not connected. Please try again.");
    }
  }, []);

  const connected = Boolean(
    (status?.connected === true && status.status !== "needs_reauth") ||
    status?.accounts?.some(account => account.connected),
  );

  useEffect(() => {
    onConnectionStateChange?.(connected);
  }, [connected, onConnectionStateChange]);

  /** The callback verified the connection before settling; keep it authoritative. */
  const applyVerifiedSuccess = (accessLevel: "read" | "manage", additional = false, targetAccountId?: string) => {
    const priorAccountIds = new Set(status?.accounts?.map(account => account.account_id) || []);
    const operationOwnerId = activeOwnerIdRef.current;
    setStatus((current) => ({
      configured: current?.configured ?? true,
      connected: additional ? current?.connected ?? false : true,
      google_email: current?.google_email,
      status: additional ? current?.status ?? "disconnected" : "connected",
      access_level: additional ? current?.access_level ?? null : accessLevel,
      scope_csv: current?.scope_csv ?? "",
      // The web callback succeeded only after the requested list scope was
      // verified. An immediate status read can still return the old grant.
      calendar_list_access: additional ? current?.calendar_list_access ?? false : true,
      accounts: current?.accounts,
      account_limit: current?.account_limit,
    }));
    const settlementRequest = statusRequestRef.current;
    // The callback is authoritative, but status can briefly lag. Only a status
    // read showing this exact newly connected account may replace it.
    const lifetime = popupLifetimeRef.current;
    const reconcile = async (remaining: number) => {
      const currentUser = latestUserRef.current;
      const isCurrent = () => !lifetime?.signal.aborted && identityRef.current === identity &&
        activeOwnerIdRef.current === operationOwnerId && statusRequestRef.current === settlementRequest &&
        currentUser?.uid === operationOwnerId;
      if (!currentUser || !isCurrent()) return;
      try {
        const idToken = await currentUser.getIdToken();
        if (!isCurrent()) return;
        const next = await GoogleCalendarService.status(idToken, currentUser.uid);
        if (!isCurrent()) return;
        const verified = additional
          ? next.accounts?.some(account => account.connected &&
            (targetAccountId ? account.account_id === targetAccountId : !priorAccountIds.has(account.account_id)))
          : next.connected && next.accounts?.some(account => account.account_id === "default" && account.connected);
        if (verified) { setStatus(next); return; }
      } catch { /* Retain the verified callback and retry a bounded status read. */ }
      if (remaining > 0 && isCurrent()) window.setTimeout(() => { void reconcile(remaining - 1); }, 1500);
    };
    if (additional) void reconcile(2);
    else window.setTimeout(() => { void reconcile(2); }, 1500);
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
    if (identityRef.current !== identity || activeOwnerIdRef.current !== input.operationOwnerId) return;
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

  const connect = async (accessLevel: "read" | "manage" = "read", includeCalendarList = false, additional = false, accountId?: string) => {
    if (!user || busyRef.current) return;
    if (status?.connected && status.access_level === "manage") accessLevel = "manage";
    includeCalendarList = includeCalendarList || status?.calendar_list_access === true;
    const operationOwnerId = user.uid;
    statusRequestRef.current += 1;
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
      const privateAgent = await ownerContentIsPrivate();
      if (activeOwnerIdRef.current !== operationOwnerId) { popup?.close(); return; }
      if (privateAgent) {
        popup?.close();
        if (!vaultKey || !vaultOwnerToken) { toast.error('Unlock your vault to connect Google.'); return; }
        const outcome = await connectGoogleConnector('calendar', {
          vaultOwnerCapability: vaultOwnerToken,
          confirmLegacyTransition: terms => confirmTransition(terms, 'calendar'),
          isCurrent: () => activeOwnerIdRef.current === operationOwnerId,
        });
        if (activeOwnerIdRef.current !== operationOwnerId) return;
        if (!outcome.ok) {
          if (outcome.code === 'PHONE_HANDOFF_REQUIRED') requestGoogleConnectorPhoneHandoff('calendar');
          else toast.error(connectRefusalMessage(outcome.code, 'Calendar'));
          return;
        }
        const current = await GoogleCalendarService.status(await user.getIdToken(), operationOwnerId);
        if (activeOwnerIdRef.current === operationOwnerId) setStatus(current);
        return;
      }
      if (journeyVariant === "onboarding") {
        markCalendarSetupOAuthReturn();
      } else {
        clearCalendarSetupOAuthReturn();
      }
      const idToken = await user.getIdToken();
      if (identityRef.current !== identity || activeOwnerIdRef.current !== operationOwnerId) {
        popup?.close();
        return;
      }
      if (native) {
        const start = await GoogleCalendarService.startNativeConnect({
          idToken,
          accessLevel,
          ...(includeCalendarList ? { includeCalendarList: true } : {}),
          ...(additional ? { additional: true } : {}),
          ...(accountId ? { accountId } : {}),
        });
        if (identityRef.current !== identity || activeOwnerIdRef.current !== operationOwnerId) return;
        const nativeResult = await HushhAuth.connectCalendar({
          serverClientId: start.server_client_id,
          accessLevel: start.access_level,
          ...(start.include_calendar_list ? { includeCalendarList: true } : {}),
        });
        if (identityRef.current !== identity || activeOwnerIdRef.current !== operationOwnerId) return;
        const completed = await GoogleCalendarService.completeNativeConnect({
          idToken,
          userId: operationOwnerId,
          accessLevel: start.access_level,
          serverAuthCode: nativeResult.serverAuthCode,
          state: start.state,
        });
        if (identityRef.current !== identity || activeOwnerIdRef.current !== operationOwnerId) return;
        const verifiedAccount = additional
          ? completed.accounts?.find(account => accountId
            ? account.account_id === accountId
            : !status?.accounts?.some(previous => previous.account_id === account.account_id))
          : completed;
        if (
          !verifiedAccount?.connected || verifiedAccount.status === "needs_reauth" ||
          (accessLevel === "manage" && verifiedAccount.access_level !== "manage") ||
          (includeCalendarList && verifiedAccount.calendar_list_access !== true)
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
        ...(additional ? { additional: true } : {}),
        ...(accountId ? { accountId } : {}),
        ...(accountId ? { loginHint: status?.accounts?.find(account => account.account_id === accountId)?.google_email || undefined } : {}),
      });
      if (identityRef.current !== identity || activeOwnerIdRef.current !== operationOwnerId) {
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
      if (identityRef.current !== identity || activeOwnerIdRef.current !== operationOwnerId) return;
      const settled = settlement;
      if (finished === "settled" && settled) {
        if (settled.outcome === "succeeded") applyVerifiedSuccess(accessLevel, additional, accountId);
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
      if (identityRef.current === identity && activeOwnerIdRef.current === operationOwnerId) setBusy(false);
    } catch (error) {
      if (identityRef.current !== identity || activeOwnerIdRef.current !== operationOwnerId) return;
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
    } finally {
      if (identityRef.current === identity && activeOwnerIdRef.current === operationOwnerId) setBusy(false);
    }
  };

  const disconnect = async (accountId = "default") => {
    if (!user || busyRef.current) return;
    const operationOwnerId = user.uid;
    statusRequestRef.current += 1;
    setBusy(true);
    const operation = user
      .getIdToken()
      .then((idToken) => {
        if (identityRef.current !== identity || activeOwnerIdRef.current !== operationOwnerId) {
          throw new Error("Calendar account changed.");
        }
        return accountId === "default"
          ? GoogleCalendarService.disconnect(idToken, operationOwnerId)
          : GoogleCalendarService.disconnect(idToken, operationOwnerId, accountId);
      });
    void morphyToast.promise(operation, {
      loading: "Disconnecting Google Calendar…",
      success: "Google Calendar disconnected.",
      error: "Google Calendar couldn’t be disconnected. Try again.",
      variant: "destructive",
    });
    try {
      const next = await operation;
      if (identityRef.current !== identity || activeOwnerIdRef.current !== operationOwnerId) return;
      trackEvent("one_calendar_action", { route_id: "one_calendar", action: "disconnected", result: "success" });
      setStatus(next);
      setDisconnectConfirmOpen(false);
    } catch (error) {
      if (identityRef.current !== identity || activeOwnerIdRef.current !== operationOwnerId) return;
      trackEvent("one_calendar_action", { route_id: "one_calendar", action: "disconnected", result: "error" });
      throw error;
    } finally {
      if (identityRef.current === identity && activeOwnerIdRef.current === operationOwnerId) setBusy(false);
    }
  };

  const needsSchedulingReconnect =
    connected && status?.access_level !== "manage";
  const detail = connectionPending
    ? "Saving secure Google Calendar connection…"
    : !status
      ? "Checking Calendar connection…"
      : connected
        ? status.google_email?.trim()
          ? `Connected as ${status.google_email.trim()}`
          : "Account details unavailable"
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
  const checkingConnection = connectionPending || loading || (Boolean(user) && !status && !statusError);
  // Unknown connection evidence is a loading state, never a disconnected state.
  const showConnectHero = !connected;

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

  const disconnectDialog = (
      <AlertDialog
        open={disconnectConfirmOpen}
        onOpenChange={setDisconnectConfirmOpen}
      >
        <AlertDialogContent size="sm" className={presentationStyles.portal} onCloseAutoFocus={event => { const target = disconnectTriggerRef.current?.isConnected ? disconnectTriggerRef.current : document.querySelector<HTMLButtonElement>('[data-voice-control-id="open_calendar_connector"]'); if (target) { event.preventDefault(); target.focus(); } }}>
          <AlertDialogHeader className="text-center">
            <AlertDialogTitle>Disconnect Google Calendar?</AlertDialogTitle>
            <AlertDialogDescription>
              This disconnects the selected Calendar account. Your Mail connection and other Calendar accounts stay available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row justify-center gap-2">
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void disconnect(disconnectAccountId).catch(() => undefined);
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
  );

  const connectMail = async () => {
    if (!user || busyRef.current) return;
    const attemptIdentity = identity;
    const cancel = new AbortController();
    popupCancelRef.current = cancel;
    const started = connectGmailInPlace({
      owner: user, purpose: "send", signal: popupLifetimeRef.current?.signal,
      cancelSignal: cancel.signal,
      isCurrent: () => identityRef.current === attemptIdentity && activeOwnerIdRef.current === user.uid,
    });
    setBusy(true); setPopupWaiting(started.surface === "window");
    try {
      const outcome = await started.result;
      if (identityRef.current !== attemptIdentity) return;
      if (outcome !== "connected") throw new Error("Mail sending was not enabled. Your draft is still here.");
      morphyToast.success("Mail sending enabled. Review your message again.");
    } finally {
      if (identityRef.current === attemptIdentity) { setBusy(false); setPopupWaiting(false); }
    }
  };

  if ((connected || Boolean(status?.accounts?.length)) && journeyVariant === "workspace" && user && status) {
    return <>
      <CalendarConnectedWorkspace userId={user.uid} status={status} busy={busy}
        onConnect={(access, includeCalendarList) => { void connect(access, includeCalendarList); }}
        onAddAccount={() => { void connect("manage", true, true); }}
        onReconnectAccount={(accountId) => { void connect("manage", true, true, accountId); }}
        onDisconnectAccount={(accountId) => { setDisconnectAccountId(accountId); setDisconnectConfirmOpen(true); }}
        onChat={(prompt, slot, invitation, attendance) => openCalendarChat(slot || invitation || attendance ? undefined : prompt?.trim() || "Summarize my calendar events and help me plan meetings", slot, invitation, attendance)}
        onDisconnect={() => { const trigger = document.activeElement; disconnectTriggerRef.current = trigger instanceof HTMLButtonElement ? trigger : null; setDisconnectConfirmOpen(true); }}
        onMailConnect={connectMail} connectionNotice={popupWaitingNotice} getIdToken={() => user.getIdToken()} connectionRevision={statusRequestRef.current} />
      {disconnectDialog}
      {transitionDialog}
    </>;
  }

  return (
    <AppPageShell
      width="reading"
      headerContentSpacing={journeyVariant === "workspace" ? "compact" : "standard"}
      className={CALENDAR_SETUP_SHELL_CLASSNAME}
      nativeTest={{
        routeId: ROUTES.CALENDAR,
        marker: "native-route-calendar",
        authState: user ? "authenticated" : loading ? "pending" : "anonymous",
        dataState:
          checkingConnection
            ? "loading"
            : status === null
              ? "unavailable-valid"
              : connected
                ? "loaded"
                : "empty-valid",
      }}
    >
      <AppPageContentRegion className={`${CALENDAR_SETUP_REGION_CLASSNAME} ${presentationStyles.setup}`} data-calendar-presentation>
        {transitionDialog}
        {checkingConnection && !connected ? (
          <div role="status" aria-live="polite" className={`${presentationStyles.status} flex items-center justify-center gap-2 text-muted-foreground`}>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {connectionPending ? "Finishing Calendar connection…" : "Checking Calendar connection…"}
          </div>
        ) : !status && statusError ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <p role="status" className={`${presentationStyles.support} text-muted-foreground`}>{statusError}</p>
            <CalendarCompactAction
              type="button"
              onClick={() => void refresh().catch(() => toast.error("Calendar connection couldn’t load. Try again."))}
            >
              Try again
            </CalendarCompactAction>
          </div>
        ) : showConnectHero ? (
          <CalendarConnectHero
            journeyVariant={journeyVariant}
            busy={busy || checkingConnection || !user}
            needsReauth={needsReauth}
            onConnect={() => void connect("read")}
          >
            {popupWaitingNotice}
          </CalendarConnectHero>
        ) : (
          <div className="flex flex-col items-center text-center max-w-sm mx-auto">
            <div className="mb-6 flex size-24 items-center justify-center rounded-[24px] bg-[#FFF0F1] dark:bg-red-950/40">
              <CalendarConnectIcon className="size-11" style={{ color: "#FF3B30" }} />
            </div>

            <div className="space-y-[var(--page-header-copy-gap)]">
              <h2 className={`${presentationStyles.flowTitle} tracking-tight text-foreground`}>
                {connected ? "Google Calendar" : "Connect Google Calendar"}
              </h2>

              <p className={`${presentationStyles.flowDescription} text-muted-foreground/80 max-w-xs`}>
                {detail}
              </p>
            </div>

            <div className="space-y-4 pt-[var(--page-header-section-gap)] w-full flex flex-col items-center">
              {checkingConnection ? (
                <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {connectionPending
                    ? "Finishing Calendar connection…"
                    : "Loading Calendar…"}
                </span>
              ) : (
                <div className="space-y-4 flex flex-col items-center w-full">
                  {/* Connection Status & Permission */}
                  <div className="flex flex-col items-center gap-1.5 text-center px-2">
                    <div
                      className={`inline-flex items-center gap-1.5 ${presentationStyles.status} ${
                        connected
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-muted-foreground"
                      }`}
                    >
                      {connected ? (
                        <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                      ) : null}
                      <span>{connectionLabel}</span>
                    </div>
                    {connected ? (
                      <p className={`${presentationStyles.support} text-muted-foreground max-w-sm`}>
                        {permissionLabel}
                      </p>
                    ) : null}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col items-center gap-2.5 w-full pt-1">
                    {connected && status?.calendar_list_access === false && !Capacitor.isNativePlatform() ? (
                      <button
                        type="button"
                        className={`${presentationStyles.utility} text-[color:var(--app-tint)] underline-offset-4 hover:underline`}
                        disabled={busy}
                        onClick={() => void connect("read")}
                      >
                        Allow One to find subscribed calendars
                      </button>
                    ) : null}
                    {connected ? (
                      <>
                        <AskOneButton
                          disabled={busy}
                          showIcon={false}
                          onClick={() => openCalendarChat("Summarize my calendar events and help me plan meetings")}
                          className="w-full rounded-full"
                        >
                          Try Calendar Agent with One
                        </AskOneButton>
                        <button
                          type="button"
                          className={`${presentationStyles.utility} text-[color:var(--app-destructive)] underline-offset-4 hover:underline focus-visible:underline`}
                          disabled={busy}
                          onClick={() => setDisconnectConfirmOpen(true)}
                        >
                          Disconnect Calendar
                        </button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="prominent"
                        className="w-full rounded-full bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]"
                        disabled={busy}
                        onClick={() => void connect("read")}
                        data-voice-control-id="open_calendar_connector"
                        data-voice-action-id={
                          journeyVariant === "onboarding"
                            ? "setup.connect_calendar"
                            : undefined
                        }
                        data-voice-label="Connect Calendar"
                        data-voice-purpose="starts Google Calendar authorization from this Calendar agent."
                      >
                        {needsReauth ? "Reconnect Calendar" : "Connect Calendar"}
                      </Button>
                    )}
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

      {disconnectDialog}
    </AppPageShell>
  );
}
