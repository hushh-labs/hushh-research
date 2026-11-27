"use client";

import { useEffect, useRef } from "react";

import { ChevronLeft } from "@/components/icons";
import {
  formatMailMoment,
  mailReadFailureCopy,
  type MailFailureCopy,
} from "@/lib/mail/mail-overview-copy";
import type { MailOpenedState } from "@/lib/mail/use-mail-overview";
import { cn } from "@/lib/utils";
import { MailActionButton } from "./mail-action-button";
import { MailMessageListSkeleton } from "./mail-message-list";
import styles from "./mail-overview.module.css";

/**
 * One opened email, as text. The body arrives as readable text from the same
 * extractor One's own mail reads use, and is shown in a text node: no markup, no
 * remote images, no followed links. A missing subject or sender is named missing.
 */
export function MailMessageView({
  opened,
  backLabel,
  onBack,
  onRetry,
  onReconnect,
  onUnlock,
  onReply,
  replyBusy,
  replyFailure,
}: {
  opened: MailOpenedState;
  backLabel: string;
  onBack: () => void;
  onRetry: () => void;
  onReconnect: () => void;
  onUnlock: () => void;
  onReply: () => void;
  replyBusy: boolean;
  replyFailure: MailFailureCopy | null;
}) {
  const heading = useRef<HTMLDivElement>(null);
  const { status, message, error } = opened;
  // Opening is a change of place: move focus to it so a keyboard or screen reader
  // user lands on the message, and Back can return them to the row they chose.
  useEffect(() => {
    if (status !== "loading") heading.current?.focus();
  }, [status]);

  const failure = error ? mailReadFailureCopy(error) : null;
  const moment = message ? formatMailMoment(message.receivedAt) : null;
  const meta = message
    ? [message.sender ?? "Unknown sender", moment].filter(Boolean).join(" · ")
    : "";

  return (
    <article className={styles.message} aria-label="Opened email" aria-busy={status === "loading"}>
      <button type="button" className={styles.backLink} onClick={onBack}>
        <ChevronLeft aria-hidden="true" className="size-4" />
        {backLabel}
      </button>
      {status === "loading" ? <MailMessageListSkeleton message="Opening email…" /> : null}
      {status === "error" && failure ? (
        <div className={styles.state} role="alert">
          <p className={styles.status}>{failure.message}</p>
          <div className={styles.stateActions}>
            {failure.action === "retry" ? (
              <MailActionButton type="button" onClick={onRetry}>
                Try again
              </MailActionButton>
            ) : null}
            {failure.action === "reconnect" ? (
              <MailActionButton type="button" onClick={onReconnect}>
                Reconnect
              </MailActionButton>
            ) : null}
            {failure.action === "unlock" ? (
              <MailActionButton type="button" onClick={onUnlock}>
                Unlock
              </MailActionButton>
            ) : null}
          </div>
        </div>
      ) : null}
      {status === "ready" && message ? (
        <>
          <div ref={heading} tabIndex={-1} className={styles.messageHeader}>
            <h3 className={cn(styles.messageSubject, message.subject ? null : styles.missing)}>
              {message.subject ?? "No subject"}
            </h3>
            <p className={styles.messageMeta}>{meta}</p>
          </div>
          {message.body ? (
            <p className={styles.messageBody} data-testid="mail-message-body">
              {message.body}
            </p>
          ) : (
            <p className={styles.note}>This email has no readable text.</p>
          )}
          {message.bodyTruncated ? (
            <p className={styles.note}>Shortened here. The original is longer.</p>
          ) : null}
          <div className={styles.messageActions}>
            <MailActionButton type="button" onClick={onReply} disabled={replyBusy} aria-busy={replyBusy}>
              Reply
            </MailActionButton>
          </div>
          {replyFailure ? (
            <p role="alert" className={styles.status}>
              {replyFailure.message}
            </p>
          ) : null}
        </>
      ) : null}
    </article>
  );
}
