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
  formatMailMoment,
  mailReadFailureCopy,
} from "@/lib/mail/mail-overview-copy";
import styles from "./mail-brief.module.css";
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
  onClose,
  onReconnect,
  onUnlock,
}: {
  target: WhyTarget | null;
  vaultOwnerToken: string | null;
  expectedAccount: string | null;
  onClose: () => void;
  onReconnect: () => void;
  onUnlock: () => void;
}) {
  const [viewing, setViewing] = useState<BriefEvidence | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // A new card starts at its list, or at its one message when asked to.
  useEffect(() => {
    setViewing(target?.openFirst ? (target.evidence[0] ?? null) : null);
  }, [target]);

  const sourceId = viewing?.sourceId ?? null;
  useEffect(() => {
    if (!sourceId) return;
    if (!vaultOwnerToken) {
      setLoaded({ status: "error", error: new MailOverviewError("auth_missing") });
      return;
    }
    const controller = new AbortController();
    setLoaded({ status: "loading" });
    openMailMessage({ vaultOwnerToken, expectedAccount, sourceId, signal: controller.signal })
      .then(({ message }) => {
        if (!controller.signal.aborted) setLoaded({ status: "ready", message });
      })
      .catch((raw: unknown) => {
        if (controller.signal.aborted) return;
        const error = raw instanceof MailOverviewError ? raw : new MailOverviewError("unknown");
        if (error.reason !== "aborted") setLoaded({ status: "error", error });
      });
    return () => controller.abort();
  }, [sourceId, vaultOwnerToken, expectedAccount, attempt]);

  const close = useCallback(() => {
    setViewing(null);
    onClose();
  }, [onClose]);

  const failure = loaded.status === "error" ? mailReadFailureCopy(loaded.error) : null;
  const message = loaded.status === "ready" ? loaded.message : null;
  const eyebrow = viewing
    ? `${viewing.from} · ${formatEvidenceDay(viewing.on)}`
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
      surfaceClassName={`${mailStyles.typography} ${mailStyles.portal}`}
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
                  onClick={() => setViewing(item)}
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
              <p className={styles.whyFrom}>
                {[message.sender ?? "Unknown sender", formatMailMoment(message.receivedAt)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <p className={styles.whyBody} data-testid="brief-message-body">
                <Marked text={message.body} quote={viewing.quote} />
                {message.bodyTruncated ? " …" : ""}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </AdaptiveDetailSurface>
  );
}
