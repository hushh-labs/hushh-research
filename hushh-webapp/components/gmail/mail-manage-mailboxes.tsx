"use client";

import { useState } from "react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Loader2 } from "@/components/icons";
import styles from "./mail-manage-mailboxes.module.css";
import mailStyles from "./mail-workspace.module.css";

export type ManagedMailbox = { id: string; email: string };

/**
 * Where a mailbox is disconnected. The mailbox menu cannot hold this: with several
 * mailboxes a Disconnect row there would not say which one it removes. Here every
 * mailbox is listed by its address and removed one at a time, and the confirmation
 * names the address again before anything is deleted.
 */
export function MailManageMailboxes({
  mailboxes,
  busy,
  onDisconnect,
}: {
  mailboxes: readonly ManagedMailbox[];
  busy: boolean;
  /** Resolves true once that one mailbox is disconnected. */
  onDisconnect: (id: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const pending = mailboxes.find((box) => box.id === pendingId) ?? null;

  const close = () => {
    if (working) return;
    setOpen(false);
    setPendingId(null);
  };
  const confirm = async () => {
    if (!pending || working) return;
    setWorking(true);
    try {
      const done = await onDisconnect(pending.id);
      if (done) {
        setPendingId(null);
        // The last mailbox is gone: there is nothing left to manage.
        if (mailboxes.length <= 1) setOpen(false);
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <div className={styles.footer}>
        <button type="button" className={styles.trigger} onClick={() => setOpen(true)} data-testid="mail-manage-mailboxes">
          Manage mailboxes
        </button>
      </div>
      <AdaptiveDetailSurface
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title="Mailboxes"
        mobilePresentation="sheet"
        desktopMaxWidthClassName="sm:!max-w-[480px]"
        surfaceClassName={`${mailStyles.typography} ${mailStyles.portal}`}
        bodyClassName={styles.body}
      >
        {pending ? (
          <div className={styles.confirm} data-testid="mail-disconnect-confirm">
            <p className={styles.confirmTitle}>Disconnect {pending.email}?</p>
            <p className={styles.confirmBody}>
              One stops reading this mailbox and deletes its receipts and summaries from Hussh. Your other mailboxes and
              information saved to private memory stay.
            </p>
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} disabled={working} onClick={() => setPendingId(null)}>
                Keep connected
              </button>
              <button type="button" className={styles.destructive} disabled={working} onClick={() => void confirm()} data-testid="mail-disconnect-confirm-action">
                {working ? <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" /> : null}
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <ul className={styles.list}>
            {mailboxes.map((box) => (
              <li key={box.id} className={styles.row}>
                <span className={styles.address}>{box.email}</span>
                <button
                  type="button"
                  className={styles.disconnect}
                  disabled={busy}
                  aria-label={`Disconnect ${box.email}`}
                  onClick={() => setPendingId(box.id)}
                  data-testid="mail-disconnect-mailbox"
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
      </AdaptiveDetailSurface>
    </>
  );
}
