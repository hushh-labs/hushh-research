"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { GoogleEmailSendService } from "@/lib/services/google-email-send-service";
import {
  createGoogleOAuthPopupAttempt,
  isGoogleOAuthPopupSettlement,
  navigateGoogleOAuthPopup,
  openGoogleOAuthPopup,
  readGoogleOAuthPopupSettlement,
} from "@/lib/google/google-oauth-popup";

const EMAIL_SEND_RETURN_KEY = "hushh.google-email-send.return";

export function consumeGoogleEmailSendReturn(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.sessionStorage.getItem(EMAIL_SEND_RETURN_KEY);
  window.sessionStorage.removeItem(EMAIL_SEND_RETURN_KEY);
  return value === "/one/setup/gmail" || value === "/one/gmail" ? value : null;
}

export function GmailSendAccessCard({ onConnectionStateChange }: { onConnectionStateChange?: (enabled: boolean) => void }) {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const expectedAttemptId = useRef<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const refresh = useCallback(async () => {
    if (!user) { setEnabled(false); return; }
    try {
      const status = await GoogleEmailSendService.status(await user.getIdToken(), user.uid);
      setEnabled(status.connected && status.scope_csv.split(" ").includes("https://www.googleapis.com/auth/gmail.send"));
    } catch { setEnabled(false); }
  }, [user]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { onConnectionStateChange?.(enabled === true); }, [enabled, onConnectionStateChange]);
  useEffect(() => {
    const settle = (attemptId: string, outcome: "succeeded" | "cancelled" | "failed", message?: string) => {
      if (!expectedAttemptId.current || attemptId !== expectedAttemptId.current) return;
      expectedAttemptId.current = null;
      popupRef.current = null;
      setBusy(false);
      if (outcome === "succeeded") { void refresh(); toast.success("Gmail sending access enabled."); }
      else if (outcome === "failed") toast.error(message || "Gmail sending setup did not finish.");
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popupRef.current || !isGoogleOAuthPopupSettlement(event.data)) return;
      settle(event.data.attemptId, event.data.outcome, event.data.message);
    };
    const onStorage = (event: StorageEvent) => { const value = readGoogleOAuthPopupSettlement(event); if (value) settle(value.attemptId, value.outcome, value.message); };
    window.addEventListener("message", onMessage); window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener("message", onMessage); window.removeEventListener("storage", onStorage); };
  }, [refresh]);
  const connect = async () => {
    if (!user || busy) return;
    setBusy(true);
    const attempt = createGoogleOAuthPopupAttempt("gmail_send");
    const popup = openGoogleOAuthPopup(attempt);
    if (!popup) { setBusy(false); toast.error("Your browser blocked the secure Google sign-in window. Allow popups and try again."); return; }
    expectedAttemptId.current = attempt.attemptId;
    popupRef.current = popup;
    try {
      const start = await GoogleEmailSendService.startConnect({ idToken: await user.getIdToken(), userId: user.uid, loginHint: user.email });
      window.sessionStorage.setItem(EMAIL_SEND_RETURN_KEY, window.location.pathname);
      navigateGoogleOAuthPopup(popup, start.authorize_url);
    } catch (error) {
      popup.close();
      expectedAttemptId.current = null;
      popupRef.current = null;
      toast.error(error instanceof Error ? error.message : "Unable to request Gmail sending access.");
      setBusy(false);
    }
  };
  return (
    <section className="mb-4 rounded-2xl border border-border/70 bg-card p-4" aria-live="polite">
      <h2 className="text-sm font-semibold">Send email from your Gmail</h2>
      <p className="mt-1 text-sm text-muted-foreground">{enabled ? "One can prepare email drafts for your final review and send only after you confirm." : "Enable Gmail sending so One can prepare a draft for your final review. One never sends automatically."}</p>
      <div className="mt-3 flex items-center gap-3">
        {enabled ? <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Sending access enabled</span> : <Button type="button" size="sm" onClick={() => void connect()} disabled={busy || !user}>{busy ? "Opening Google…" : "Enable sending"}</Button>}
      </div>
    </section>
  );
}
