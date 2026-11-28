"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { ChevronLeft } from "@/components/icons";
import type { BriefEvidence } from "@/lib/mail/mail-brief-client";
import {
  MailOverviewError,
  openMailMessage,
  type OpenedOverviewMessage,
} from "@/lib/mail/mail-overview-client";
import {
  formatEvidenceDay,
  mailReadFailureCopy,
} from "@/lib/mail/mail-overview-copy";
import styles from "./mail-brief.module.css";
import connectType from "@/lib/morphy-ux/ui/connect-type-scale.module.css";
import mailStyles from "./mail-workspace.module.css";

/** What a card is being asked about: its own words, and the messages behind them. */
export type WhyTarget = {
  title: string;
  /** One line saying why the card exists. Absent when a single message is opened directly. */
  reason?: string;
  evidence: BriefEvidence[];
  /** Open the one message at once, with no list in between (a confirmed sent email). */
  openFirst?: boolean;
};

type Loaded =
  | { status: "loading" }
  | { status: "ready"; message: OpenedOverviewMessage }
  | { status: "error"; error: MailOverviewError };

/** The quote marked inside the message text, whatever whitespace separates its words. */
function Marked({ text, quote }: { text: string; quote: string }) {
  const parts = useMemo(() => {
    const words = quote.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const match = new RegExp(escaped.join("\\s+"), "i").exec(text);
    return match ? { start: match.index, end: match.index + match[0].length } : null;
  }, [text, quote]);
  if (!parts) return <>{text}</>;
  return (
    <Fragment>
      {text.slice(0, parts.start)}
      <mark className={styles.mark} data-testid="brief-quote-mark">
        {text.slice(parts.start, parts.end)}
      </mark>
      {text.slice(parts.end)}
    </Fragment>
  );
}

/**
 * The exact messages behind a card. Each is read fresh from the connected mailbox
 * through its owner- and account-bound id, so it can only be that message in that
 * mailbox. Reading never marks mail read, labels it or completes anything.
 */
export function MailWhySheet({
  target,
  vaultOwnerToken,
  expectedAccount,
  readMessage,
  onClose,
  onReconnect,
  onUnlock,
}: {
  target: WhyTarget | null;
  vaultOwnerToken: string | null;
  expectedAccount: string | null;
  /**
   * Reads one message for a mailbox the shared hub cannot serve: a private agent
   * answers from its own runtime. Absent, the shared Mail reader is used.
   */
  readMessage?: (sourceId: string, signal: AbortSignal, original?: boolean) => Promise<OpenedOverviewMessage>;
  onClose: () => void;
  onReconnect: () => void;
  onUnlock: () => void;
}) {
  const [viewing, setViewing] = useState<BriefEvidence | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [originalSource, setOriginalSource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // A new card starts at its list, or at its one message when asked to.
  useEffect(() => {
    setOriginalSource(null);
    setViewing(target?.openFirst ? (target.evidence[0] ?? null) : null);
  }, [target]);

  const sourceId = viewing?.sourceId ?? null;
  const original = originalSource === sourceId;
  useEffect(() => {
    if (!sourceId) return;
    if (!readMessage && !vaultOwnerToken) {
      setLoaded({ status: "error", error: new MailOverviewError("auth_missing") });
      return;
    }
    const controller = new AbortController();
    setLoaded({ status: "loading" });
    (readMessage
      ? readMessage(sourceId, controller.signal, original)
      : openMailMessage({ vaultOwnerToken: vaultOwnerToken as string, expectedAccount, sourceId, signal: controller.signal }).then(({ message }) => message)
    )
      .then((message) => {
        if (!controller.signal.aborted) setLoaded({ status: "ready", message });
      })
      .catch((raw: unknown) => {
        if (controller.signal.aborted) return;
        const error = raw instanceof MailOverviewError ? raw : new MailOverviewError("unknown");
        if (error.reason !== "aborted") setLoaded({ status: "error", error });
      });
    return () => controller.abort();
  }, [sourceId, vaultOwnerToken, expectedAccount, readMessage, original, attempt]);

  const close = useCallback(() => {
    setViewing(null);
    onClose();
  }, [onClose]);

  const failure = loaded.status === "error" ? mailReadFailureCopy(loaded.error) : null;
  const message = loaded.status === "ready" && loaded.message.sourceId === sourceId ? loaded.message : null;
  // A message opened from a list has no day of its own; none is invented.
  const eyebrow = viewing
    ? [viewing.from, viewing.on ? formatEvidenceDay(viewing.on) : ""].filter(Boolean).join(" · ")
    : "Why this?";

  return (
    <AdaptiveDetailSurface
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      eyebrow={target ? eyebrow : undefined}
      headerTextOverflow="wrap"
      title={target ? (viewing && message?.subject ? message.subject : target.title) : "Why this?"}
      surfaceClassName={`${connectType.surface} ${mailStyles.typography} ${mailStyles.portal}`}
      mobilePresentation="sheet"
      desktopMaxWidthClassName="sm:!max-w-[520px]"
    >
      {target && !viewing ? (
        <div data-testid="brief-why">
          {target.reason ? <p className={styles.whyReason}>{target.reason}</p> : null}
          <ul className={styles.whyList}>
            {target.evidence.map((item) => (
              <li key={`${item.sourceId}:${item.quote}`} className={styles.whyItem}>
                <p className={styles.whyFrom}>
                  {item.direction === "sent" ? "You wrote" : item.from} · {formatEvidenceDay(item.on)}
                </p>
                <p className={styles.whyQuote}>“{item.quote}”</p>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => { setOriginalSource(null); setViewing(item); }}
                  data-testid="brief-view-email"
                >
                  View email
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {target && viewing ? (
        <div className="space-y-3" data-testid="brief-message">
          {!target.openFirst ? (
            <button type="button" className={styles.link} onClick={() => setViewing(null)}>
              <ChevronLeft aria-hidden="true" className="size-4" />
              Back
            </button>
          ) : null}
          {loaded.status === "loading" ? (
            <p className={styles.whyFrom} role="status">
              Opening the email…
            </p>
          ) : null}
          {failure ? (
            <div role="alert" className="space-y-2">
              <p className={styles.whyBody}>{failure.message}</p>
              {failure.action ? (
                <button
                  type="button"
                  className={styles.link}
                  onClick={
                    failure.action === "retry"
                      ? () => setAttempt((value) => value + 1)
                      : failure.action === "reconnect"
                        ? onReconnect
                        : onUnlock
                  }
                >
                  {failure.action === "retry" ? "Try again" : failure.action === "reconnect" ? "Reconnect" : "Unlock"}
                </button>
              ) : null}
            </div>
          ) : null}
          {message ? (
            <>
              <p className={styles.whyBody} data-testid="brief-message-body">
                {message.summary && !original ? message.summary : <Marked text={message.body} quote={viewing.quote} />}
              </p>
              {message.bodyTruncated ? <p className={styles.whyFrom}>{message.summary && !original ? "Partial summary · based on the available text." : "Showing the available portion of this email."}</p> : null}
            </>
          ) : null}
          {readMessage && !original ? (
            <button className={styles.link} onClick={() => setOriginalSource(sourceId)}>View original email</button>
          ) : null}
        </div>
      ) : null}
    </AdaptiveDetailSurface>
  );
}
