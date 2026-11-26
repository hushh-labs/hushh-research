"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { applyNoticeCheck } from "@/lib/mail/receipt-tracking";
import { type NoticeSource, noticeCheckDue, selectNoticeInput } from "@/lib/mail/receipt-notice";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { usePrivateMailSession } from "@/lib/mail/private-mail-session";
import { useReceiptTracking } from "./receipt-tracking-context";

export type NoticeStatus = "idle" | "checking" | "failed";

export interface ReceiptNoticeValue {
  status: NoticeStatus;
  /** Why the last check could not finish; the last good findings keep showing. */
  error: string | null;
  /** Ask again now, whatever the schedule says. */
  retry: () => void;
  /** Open the one email behind a finding. */
  openSource: (openKey: string) => Promise<NoticeSource>;
}

const Context = createContext<ReceiptNoticeValue | null>(null);

export function useReceiptNotice(): ReceiptNoticeValue | null {
  return useContext(Context);
}

/** Wait for the saved receipts to stop changing before spending a model call on them. */
const SETTLE_MS = 1_500;

/**
 * Keeps One's mailbox check current without a scan or a model call on every page open.
 * Saved findings load with the receipts; a check runs only when the saved receipts changed or the last
 * good one is a day old. A failed check leaves the saved findings alone and says so.
 */
export function ReceiptNoticeProvider({
  userId, vaultOwnerToken, accountKey, getIdToken, rows, locators, enabled, children,
}: {
  userId: string | null;
  vaultOwnerToken: string | null;
  accountKey: string | null;
  getIdToken: (() => Promise<string>) | null;
  rows: readonly RecentReceiptRow[];
  /** A saved receipt's stable reference to the sealed key that reopens its email. */
  locators: Readonly<Record<string, string>>;
  /** Connected, vault open, and the saved receipts finished loading. */
  enabled: boolean;
  children: ReactNode;
}) {
  const privateMailbox = usePrivateMailSession()?.selected ?? undefined;
  const tracking = useReceiptTracking();
  const [status, setStatus] = useState<NoticeStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const failedAt = useRef<{ digest: string; at: number } | null>(null);
  const running = useRef<AbortController | null>(null);
  /** Set by "Try again": the next pass runs whatever the schedule says, once. */
  const force = useRef(false);
  const trackingReady = tracking?.status === "ready" && Boolean(tracking.doc);
  const doc = tracking?.doc ?? null;
  const apply = tracking?.apply;
  const ready = enabled && trackingReady && Boolean(userId && vaultOwnerToken && accountKey && getIdToken);
  const input = useMemo(() => selectNoticeInput(rows, new Date(), locators), [rows, locators]);
  const notice = doc?.notice ?? null;

  // A different mailbox or owner never inherits another's running check or its failure.
  useEffect(() => () => { running.current?.abort(); running.current = null; failedAt.current = null; }, [userId, accountKey]);

  useEffect(() => {
    if (!ready || !notice || !doc || !apply || input.keys.length === 0) { setStatus("idle"); return; }
    const forced = force.current;
    force.current = false;
    const failure = failedAt.current?.digest === input.digest ? failedAt.current.at : null;
    if (!forced && !noticeCheckDue(notice, input.digest, new Date(), failure)) { setStatus("idle"); return; }
    const timer = window.setTimeout(() => {
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      setStatus("checking");
      setError(null);
      void (async () => {
        try {
          const idToken = await getIdToken!();
          const check = await GmailReceiptsService.checkReceiptNotice({ privateMailbox,
            idToken, vaultOwnerToken: vaultOwnerToken!, userId: userId!, accountKey: accountKey!, receiptKeys: input.keys,
            prior: notice.findings.map((finding) => ({ id: finding.id, kind: finding.kind, provider: finding.provider?.name ?? "", headline: finding.headline })),
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          // Saved receipts and choices stay as they are if the check cannot be saved; it will simply run again.
          const saved = await apply((current, ctx) => applyNoticeCheck(current, check, input.digest, ctx));
          if (controller.signal.aborted) return;
          failedAt.current = saved ? null : { digest: input.digest, at: Date.now() };
          setStatus(saved ? "idle" : "failed");
          setError(saved ? null : "One checked, but couldn’t save the result.");
        } catch (failure) {
          if (controller.signal.aborted) return;
          failedAt.current = { digest: input.digest, at: Date.now() };
          const message = failure instanceof Error && failure.message ? failure.message : "One couldn’t check just now.";
          setStatus("failed");
          setError(message);
        } finally {
          if (running.current === controller) running.current = null;
        }
      })();
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  // The saved findings are read when the check starts; a finished check changes them and must not restart it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, input.digest, notice?.digest, notice?.checkedAt, nonce]);

  useEffect(() => () => { running.current?.abort(); }, []);

  const retry = useCallback(() => { failedAt.current = null; force.current = true; setNonce((value) => value + 1); }, []);
  const openSource = useCallback<ReceiptNoticeValue["openSource"]>(async (openKey) => {
    if (!userId || !vaultOwnerToken || !accountKey || !getIdToken) throw new Error("Open your vault to read this email.");
    return GmailReceiptsService.openNoticeSource({ privateMailbox, idToken: await getIdToken(), vaultOwnerToken, userId, accountKey, openKey });
  }, [accountKey, getIdToken, userId, vaultOwnerToken]);

  const value = useMemo<ReceiptNoticeValue>(() => ({ status, error, retry, openSource }), [status, error, retry, openSource]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
