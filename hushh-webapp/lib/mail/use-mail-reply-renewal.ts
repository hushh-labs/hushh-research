"use client";

/**
 * Keeps an open Mail reply on its original email while the person writes it.
 *
 * A reply reference lasts 15 minutes. While the reply is open this renews it
 * shortly before it would run out, and again the moment the tab becomes visible
 * after being hidden, so the person never hits an expired reference just
 * because they took their time. It reads the original email again and nothing
 * else: it never touches the text being written and never sends.
 */

import { useEffect } from "react";

import { MailOverviewError } from "@/lib/mail/mail-overview-client";
import type { MailReplyBindings } from "@/lib/mail/mail-reply-binding";

/** After a transient failure, look again this soon. */
export const REPLY_RENEW_RETRY_MS = 30_000;

/** Failures that may clear by themselves. Everything else is said when they Send. */
const TRANSIENT = new Set(["retryable", "network", "unknown"]);

export function useMailReplyRenewal(input: {
  bindings: MailReplyBindings;
  /** The reference the open reply was opened with, or null when no reply is open. */
  reference: string | null;
  ownerId: string | null;
  vaultOwnerToken: string | null;
  /** The newest reference is ready; the same recipient and subject as reviewed. */
  onRenewed: () => void;
}): void {
  const { bindings, reference, ownerId, vaultOwnerToken, onRenewed } = input;

  useEffect(() => {
    if (!reference || !ownerId || !vaultOwnerToken) return;
    if (bindings.dueInMs(reference) === null) return; // not a reply from Mail's Overview

    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delayMs: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void renewNow(), Math.max(0, delayMs));
    };

    async function renewNow(): Promise<void> {
      try {
        const renewed = await bindings.renew(reference as string, { ownerId: ownerId as string, vaultOwnerToken: vaultOwnerToken as string });
        if (!live) return;
        // A different recipient or subject is never swapped in under the
        // person. Stop here; Send explains it and Review shows the change.
        if (renewed && !renewed.adopted) return;
        onRenewed();
      } catch (error) {
        if (!live) return;
        if (!(error instanceof MailOverviewError) || !TRANSIENT.has(error.reason)) return;
      }
      const due = bindings.dueInMs(reference as string);
      if (live && due !== null) schedule(due > 0 ? due : REPLY_RENEW_RETRY_MS);
    }

    const onVisible = () => {
      if (document.visibilityState === "visible" && bindings.isDue(reference)) schedule(0);
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule(bindings.dueInMs(reference) ?? REPLY_RENEW_RETRY_MS);

    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // onRenewed is a stable dispatcher in the caller; renewing must not restart on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindings, reference, ownerId, vaultOwnerToken]);
}
