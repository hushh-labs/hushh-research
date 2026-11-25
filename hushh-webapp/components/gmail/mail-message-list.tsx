"use client";

import { useId } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { formatMailMoment, formatMailTime } from "@/lib/mail/mail-overview-copy";
import type { MailOverviewRow } from "@/lib/mail/mail-overview-client";
import { cn } from "@/lib/utils";
import styles from "./mail-overview.module.css";

/** One row, rendered as text. A field the message did not carry is named as missing. */
function MailMessageRow({
  row,
  now,
  onOpen,
}: {
  row: MailOverviewRow;
  now: Date;
  onOpen: (row: MailOverviewRow) => void;
}) {
  const previewId = useId();
  const time = formatMailTime(row.receivedAt, now);
  const moment = formatMailMoment(row.receivedAt);
  const sender = row.sender ?? "Unknown sender";
  const subject = row.subject ?? "No subject";
  const label = [
    sender,
    subject,
    time ? `received ${time}` : null,
    row.unread ? "unread" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        data-testid="mail-row"
        data-source-id={row.sourceId}
        aria-label={label}
        aria-describedby={row.preview ? previewId : undefined}
        onClick={() => onOpen(row)}
      >
        <span className={styles.rowTop}>
          {row.unread ? <span aria-hidden="true" className={styles.unreadDot} /> : null}
          <span className={cn(styles.sender, row.sender ? null : styles.missing)}>{sender}</span>
          {time && row.receivedAt ? (
            <time className={styles.time} dateTime={row.receivedAt} title={moment ?? undefined}>
              {time}
            </time>
          ) : null}
        </span>
        <span className={cn(styles.subject, row.subject ? null : styles.missing)}>{subject}</span>
        {row.preview ? (
          <span id={previewId} className={styles.preview}>
            {row.preview}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export function MailMessageList({
  rows,
  label,
  onOpen,
}: {
  rows: readonly MailOverviewRow[];
  label: string;
  onOpen: (row: MailOverviewRow) => void;
}) {
  const now = new Date();
  return (
    <ul className={styles.list} aria-label={label}>
      {rows.map((row) => (
        <MailMessageRow key={row.sourceId} row={row} now={now} onOpen={onOpen} />
      ))}
    </ul>
  );
}

/** Shown while the first read is in flight. Rows are never invented to fill it. */
export function MailMessageListSkeleton({ message }: { message: string }) {
  return (
    <div className={styles.state}>
      <p role="status" className={cn(styles.status, "text-muted-foreground")}>
        {message}
      </p>
      <div aria-hidden="true" className="space-y-3">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
