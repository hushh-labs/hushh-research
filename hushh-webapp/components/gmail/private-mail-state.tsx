"use client";

import styles from "./mail-brief.module.css";

/**
 * What a tab says when no mailbox can be read. Each cause has its own words and its own
 * next step: a mailbox that lapsed is reconnected, a list that could not be checked is
 * retried, and an owner with none is invited to add one. Nothing is shown as an empty inbox.
 */
export function PrivateMailState({
  cause,
  email,
  busy = false,
  onReconnect,
  onAdd,
  onRetry,
}: {
  cause: "checking" | "failed" | "expired" | "choose" | "none";
  email?: string | null;
  busy?: boolean;
  onReconnect: () => void;
  onAdd: () => void;
  onRetry: () => void;
}) {
  const copy = {
    checking: { text: "Checking your mailboxes…", action: null },
    failed: { text: "Couldn’t check your mailboxes. Check the connection to your private agent.", action: { label: "Try again", run: onRetry } },
    expired: { text: `${email ? `Mail access for ${email}` : "Mail access"} has expired. Reconnect to see its mail.`, action: { label: "Reconnect", run: onReconnect } },
    choose: { text: "Choose a mailbox from the menu above to see its mail.", action: null },
    none: { text: "Connect a Google account to see your mail here.", action: { label: "Add account", run: onAdd } },
  }[cause];
  return (
    <div className={styles.state} role={cause === "checking" ? "status" : "alert"} data-testid="private-mail-state" data-cause={cause}>
      <p>{copy.text}</p>
      {copy.action ? (
        <button type="button" className={styles.link} disabled={busy} onClick={copy.action.run}>
          {copy.action.label}
        </button>
      ) : null}
    </div>
  );
}
