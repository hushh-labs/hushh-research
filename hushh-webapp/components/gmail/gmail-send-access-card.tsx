"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import {
  clearGmailOAuthPopupAttempt,
  createGmailOAuthPopupAttempt,
  isGmailOAuthPopupSettlement,
  navigateGmailOAuthPopup,
  openGmailOAuthPopup,
  readGmailOAuthPopupSettlementFallback,
  type GmailOAuthPopupAttempt,
} from "@/lib/profile/gmail-oauth-popup";
import {
  GmailReceiptsService,
  type GmailConnectionStatus,
} from "@/lib/services/gmail-receipts-service";

/** Gmail setup now always uses the single receipt-connector OAuth flow. */
export function consumeGoogleEmailSendReturn(): string | null {
  return null;
}

export function GmailSendAccessCard({
  onConnectionStateChange,
  presentation = "card",
}: {
  onConnectionStateChange?: (connected: boolean) => void;
  presentation?: "card" | "inline";
}) {
  const { user } = useAuth();
  const [status, setStatus] = useState<GmailConnectionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const attemptRef = useRef<GmailOAuthPopupAttempt | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setStatus(null);
      return null;
    }
    try {
      const next = await GmailReceiptsService.getStatus({
        idToken: await user.getIdToken(),
        userId: user.uid,
        force: true,
      });
      setStatus(next);
      return next;
    } catch {
      setStatus(null);
      return null;
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connected = status?.connected === true;
  const sendPermissionGranted = status?.send_permission_granted === true;
  const sendEnabled = status?.send_enabled === true;
  const sendToggleAvailable = status?.send_toggle_available !== false;

  useEffect(() => {
    onConnectionStateChange?.(connected);
  }, [connected, onConnectionStateChange]);

  useEffect(() => {
    const settle = (
      attemptId: string,
      outcome: "succeeded" | "cancelled" | "failed",
      message?: string,
    ) => {
      if (attemptId !== attemptRef.current?.attemptId) return;
      attemptRef.current = null;
      popupRef.current = null;
      setBusy(false);
      if (outcome === "succeeded") {
        void refresh();
        toast.success("Gmail connected. Read and send permission are ready.");
      } else if (outcome === "failed") {
        toast.error(message || "Gmail connection could not be completed.");
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== popupRef.current ||
        !isGmailOAuthPopupSettlement(event.data)
      ) return;
      settle(event.data.attemptId, event.data.outcome, event.data.message);
    };
    const onStorage = (event: StorageEvent) => {
      const settlement = readGmailOAuthPopupSettlementFallback(event);
      if (settlement) settle(settlement.attemptId, settlement.outcome, settlement.message);
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);

  const connect = async () => {
    if (!user || busy) return;
    const attempt = createGmailOAuthPopupAttempt();
    const popup = openGmailOAuthPopup(attempt);
    if (!popup) {
      toast.error("Allow popups to connect Gmail securely, then try again.");
      return;
    }
    attemptRef.current = attempt;
    popupRef.current = popup;
    setBusy(true);
    try {
      const start = await GmailReceiptsService.startConnect({
        idToken: await user.getIdToken(),
        userId: user.uid,
        loginHint: user.email,
        includeGrantedScopes: true,
      });
      navigateGmailOAuthPopup(popup, start.authorize_url);
    } catch (error) {
      clearGmailOAuthPopupAttempt(popup);
      popup.close();
      popupRef.current = null;
      attemptRef.current = null;
      setBusy(false);
      toast.error(error instanceof Error ? error.message : "Unable to connect Gmail.");
    }
  };

  const toggleSend = async () => {
    if (!user || busy) return;
    setBusy(true);
    try {
      const next = await GmailReceiptsService.setSendEnabled({
        idToken: await user.getIdToken(),
        userId: user.uid,
        enabled: !sendEnabled,
      });
      setStatus(next);
      toast.success(next.send_enabled ? "Email sending enabled." : "Email sending turned off.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update email sending.");
    } finally {
      setBusy(false);
    }
  };

  const action = !connected
    ? { label: "Connect Gmail", handler: connect }
    : !sendPermissionGranted
      ? { label: "Reconnect Gmail", handler: connect }
      : !sendToggleAvailable
        ? { label: "Email sending is updating", handler: () => undefined, disabled: true }
      : {
          label: sendEnabled ? "Turn off sending" : "Allow send email",
          handler: toggleSend,
        };

  return (
    <section
      className={
        presentation === "inline"
          ? "border-t border-border/60 pt-4"
          : "mb-4 rounded-2xl border border-border/70 bg-card p-4"
      }
      aria-live="polite"
    >
      {presentation === "card" ? <h2 className="text-sm font-semibold">Email sending</h2> : null}
      <p className="mt-1 text-sm text-muted-foreground">
        {!connected
          ? "Connect Gmail once to classify receipts and prepare emails for your final approval."
          : !sendPermissionGranted
            ? "This older Gmail connection needs one reconnection to add the combined send permission."
            : !sendToggleAvailable
              ? "Email sending is being prepared. It will become available after the service update finishes."
            : sendEnabled
              ? "One can prepare drafts and send only after you confirm each email."
              : "Gmail is connected. Turn on sending here whenever you want to use it."}
      </p>
      <div className="mt-3 flex justify-center gap-3">
        <Button
          type="button"
          size="sm"
          onClick={() => void action.handler()}
          disabled={busy || !user || ("disabled" in action && action.disabled)}
        >
          {busy ? "Updating…" : action.label}
        </Button>
      </div>
    </section>
  );
}
