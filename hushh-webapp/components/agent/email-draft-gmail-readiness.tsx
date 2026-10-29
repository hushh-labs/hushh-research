"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Mail } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import type { GmailSendReadiness } from "@/lib/agent/email-draft-tool-result";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import type { GmailConnectionStatus } from "@/lib/services/gmail-receipts-service";
import { cn } from "@/lib/utils";

/** What stands between a draft and a working Send: a connection, or the send grant. */
export type GmailSendGap = "connect" | "allow";

type LiveGmailStatus = Pick<
  GmailConnectionStatus,
  "connected" | "needs_reauth" | "send_permission_granted"
>;

const NOTICE: Record<GmailSendGap, { message: string; action: string }> = {
  connect: { message: "Connect Gmail to send this.", action: "Connect Gmail" },
  allow: { message: "Allow One to send from Gmail.", action: "Allow sending" },
};

/**
 * The live connector status decides once it is known. It cannot see a
 * switched-off send, so the server's draft-time answer keeps that gap until
 * the owner finishes a connect from the card. Unknown shows nothing: the
 * server still checks every Send.
 */
export function gmailSendGap(
  hint: GmailSendReadiness | null,
  live: LiveGmailStatus | null,
  connectFinished: boolean,
): GmailSendGap | null {
  const advisory = connectFinished ? null : hint;
  if (live) {
    if (!live.connected || live.needs_reauth) return "connect";
    if (live.send_permission_granted !== true) return "allow";
    return advisory === "send_disabled" ? "allow" : null;
  }
  if (advisory === "connect_required") return "connect";
  return advisory === "send_permission_required" || advisory === "send_disabled"
    ? "allow"
    : null;
}

/**
 * The owner's Gmail send gap for a draft card. The in-place connect reports
 * no outcome here, so the status is re-read when its window closes, and once
 * on open when Send looks blocked: a connect made elsewhere leaves this store
 * as it was.
 */
export function useGmailSendGap(
  hint: GmailSendReadiness | null,
  enabling: boolean,
): GmailSendGap | null {
  const { user, userId } = useAuth();
  const idToken = useCallback(() => user?.getIdToken() ?? Promise.resolve(""), [user]);
  const gmail = useGmailConnectorStatus({ userId, idTokenProvider: user ? idToken : null });
  const refreshStatus = gmail.refreshStatus;
  const [connectFinished, setConnectFinished] = useState(false);
  const gap = gmailSendGap(hint, gmail.status, connectFinished);
  const verifyOnOpen = useRef(gap !== null);
  const wasEnabling = useRef(enabling);
  useEffect(() => {
    if (!verifyOnOpen.current) return;
    verifyOnOpen.current = false;
    void refreshStatus({ force: true, reconcile: false }).catch(() => undefined);
  }, [refreshStatus]);
  useEffect(() => {
    if (wasEnabling.current && !enabling) {
      setConnectFinished(true);
      void refreshStatus({ force: true, reconcile: false }).catch(() => undefined);
    }
    wasEnabling.current = enabling;
  }, [enabling, refreshStatus]);
  return gap;
}

export function EmailDraftGmailNotice({
  gap,
  enabling,
  onConnect,
  messageId,
}: {
  gap: GmailSendGap;
  /** True while Google's window is open; the action waits instead of starting another. */
  enabling: boolean;
  /** Call from the click: the consent window must open synchronously. */
  onConnect: () => void;
  /** Lets the card's Send button point at this explanation. */
  messageId: string;
}) {
  const warning = roleClasses("warning");
  return (
    <div
      role="status"
      data-testid="one-email-draft-gmail-readiness"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3.5 py-2",
        warning.tile,
        warning.border,
      )}
    >
      <Mail className={cn("h-4 w-4 shrink-0", warning.glyph)} aria-hidden="true" />
      <span id={messageId} className="min-w-0 flex-1 text-sm font-medium text-foreground">
        {NOTICE[gap].message}
      </span>
      <Button
        type="button"
        variant="outline"
        size="compact"
        disabled={enabling}
        onClick={onConnect}
        data-testid="one-email-draft-gmail-connect"
      >
        {enabling ? "Waiting for Google…" : NOTICE[gap].action}
      </Button>
    </div>
  );
}
