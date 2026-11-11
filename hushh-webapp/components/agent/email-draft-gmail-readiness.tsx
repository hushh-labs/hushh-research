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

/** What stands between a draft and a working Send: a connection, a renewed one, or the send grant. */
export type GmailSendGap = "connect" | "reconnect" | "allow";

type LiveGmailStatus = Pick<
  GmailConnectionStatus,
  "connected" | "needs_reauth" | "send_permission_granted"
>;

const NOTICE: Record<GmailSendGap, { message: string; action: string }> = {
  connect: { message: "Connect Gmail to send this.", action: "Connect Gmail" },
  reconnect: { message: "Reconnect Gmail to send this.", action: "Reconnect Gmail" },
  allow: { message: "Allow One to send from Gmail.", action: "Allow sending" },
};

/** The gap each server answer reports; `ready` and `unknown` report none. */
const HINT_GAP: Partial<Record<GmailSendReadiness, GmailSendGap>> = {
  connect_required: "connect",
  reconnect_required: "reconnect",
  send_permission_required: "allow",
  send_disabled: "allow",
};

function liveGap(live: LiveGmailStatus): GmailSendGap | null {
  if (live.needs_reauth) return "reconnect";
  if (!live.connected) return "connect";
  return live.send_permission_granted === true ? null : "allow";
}

/**
 * A gap the live connector status shows always wins. Its all-clear counts
 * only once read after the card opened: the status cached then can be
 * minutes old, the server's answer seconds. It cannot see a switched-off
 * send, so that answer keeps its gap until the host drops it after a
 * confirmed connect. Unknown shows nothing: the server still checks every Send.
 */
export function gmailSendGap(
  hint: GmailSendReadiness | null,
  live: LiveGmailStatus | null,
  cachedAtOpen: boolean,
): GmailSendGap | null {
  const reported = hint ? (HINT_GAP[hint] ?? null) : null;
  if (!live) return reported;
  const shown = liveGap(live);
  if (shown) return shown;
  if (cachedAtOpen) return reported;
  return hint === "send_disabled" ? "allow" : null;
}

/**
 * The owner's Gmail send gap for a draft card. The host owns the in-place
 * connect, so it clears `hint` once a connect is confirmed; a cancelled or
 * failed one keeps it. The status is re-read once on open when Send looks
 * blocked, and when Google's window closes: a connect made elsewhere leaves
 * this store as it was.
 */
export function useGmailSendGap(
  hint: GmailSendReadiness | null,
  enabling: boolean,
): GmailSendGap | null {
  const { user, userId } = useAuth();
  const idToken = useCallback(() => user?.getIdToken() ?? Promise.resolve(""), [user]);
  const gmail = useGmailConnectorStatus({ userId, idTokenProvider: user ? idToken : null });
  const refreshStatus = gmail.refreshStatus;
  // The store swaps its status object only when a new status lands, so a
  // failed re-read leaves the open-time cache, and the server's gap, in place.
  const [openedWith] = useState(gmail.status);
  const gap = gmailSendGap(hint, gmail.status, gmail.status === openedWith);
  const verifyOnOpen = useRef(gap !== null);
  const wasEnabling = useRef(enabling);
  useEffect(() => {
    if (!verifyOnOpen.current) return;
    verifyOnOpen.current = false;
    void refreshStatus({ force: true, reconcile: false }).catch(() => undefined);
  }, [refreshStatus]);
  useEffect(() => {
    if (wasEnabling.current && !enabling) {
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
