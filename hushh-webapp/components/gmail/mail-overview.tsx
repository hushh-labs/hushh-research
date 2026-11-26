"use client";

import { ChevronLeft, Mail } from "@/components/icons";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./mail-overview.module.css";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  mailReadFailureCopy,
  mailReplyFailureCopy,
  type MailFailureCopy,
  formatUpdatedTime,
} from "@/lib/mail/mail-overview-copy";
import {
  MAIL_OVERVIEW_INITIAL_ROWS,
  MAIL_SEARCH_QUERY_MAX,
  MailOverviewError,
  type MailReplySource,
} from "@/lib/mail/mail-overview-client";
import { useMailOverview } from "@/lib/mail/use-mail-overview";
import { cn } from "@/lib/utils";
import { MailActionButton } from "./mail-action-button";
import { MailMessageList, MailMessageListSkeleton } from "./mail-message-list";
import { MailMessageView } from "./mail-message-view";
import mailStyles from "./mail-workspace.module.css";

/** The existing Mail identity, reused in the connected-account card. */
function MailOverviewIcon() {
  return (
    <span
      aria-hidden="true"
      data-testid="mail-connected-account-icon"
      className={mailStyles.accountIcon}
    >
      <Mail className="size-5" />
    </span>
  );
}

export function MailConnectedAccount({
  busy = false,
  onReconnect,
  onDisconnect,
}: {
  busy?: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const openingConfirmation = useRef(false);
  return (
    <div className={mailStyles.account}>
      <div className="flex min-w-0 items-center gap-3.5">
        <MailOverviewIcon />
        <div>
          <h2 className={mailStyles.sectionTitle}>Mail</h2>
          <p className={`${mailStyles.support} flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400`}>
            <span aria-hidden="true" className="size-2.5 rounded-full bg-emerald-500" />
            Connected
          </p>
        </div>
      </div>
      <DropdownMenu onOpenChange={(open) => {
        if (open) openingConfirmation.current = false;
      }}>
        <DropdownMenuTrigger asChild>
          <MailActionButton
            type="button"
            disabled={busy}
            className="min-h-11 shrink-0 bg-transparent px-2 text-sm font-medium text-[color:var(--app-accent)] outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] disabled:opacity-50"
          >
            Manage
          </MailActionButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className={`${mailStyles.typography} ${mailStyles.portal} w-48`}
          onCloseAutoFocus={(event) => {
            // Let the confirmation dialog own focus after Disconnect.
            if (openingConfirmation.current) event.preventDefault();
          }}
        >
          <DropdownMenuItem className="min-h-11 px-3" disabled={busy} onSelect={onReconnect}>
            Reconnect
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="min-h-11 px-3"
            variant="destructive"
            disabled={busy}
            onSelect={() => {
              openingConfirmation.current = true;
              onDisconnect();
            }}
          >
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function FailureBlock({
  failure,
  onRetry,
  onReconnect,
  onUnlock,
}: {
  failure: MailFailureCopy;
  onRetry: () => void;
  onReconnect: () => void;
  onUnlock: () => void;
}) {
  return (
    <div className={styles.state} role="alert">
      <p className={styles.status}>{failure.message}</p>
      {failure.action ? (
        <div className={styles.stateActions}>
          <MailActionButton
            type="button"
            onClick={
              failure.action === "retry"
                ? onRetry
                : failure.action === "reconnect"
                  ? onReconnect
                  : onUnlock
            }
          >
            {failure.action === "retry"
              ? "Try again"
              : failure.action === "reconnect"
                ? "Reconnect"
                : "Unlock"}
          </MailActionButton>
        </div>
      ) : null}
    </div>
  );
}

export type MailOverviewProps = {
  userId: string | null;
  /** Scopes what is remembered. The account's Google subject, or its address when there is none. */
  accountKey: string | null;
  /** The Google subject the server must answer from, when the connection status has one. */
  expectedAccount: string | null;
  vaultOwnerToken: string | null;
  /** Only the visible Overview reads mail. */
  active: boolean;
  /** Opens the existing reviewed draft card for a new message. */
  onCompose: () => void;
  /** Opens the same card for a reply to the exact email on screen. */
  onReply: (reply: MailReplySource, sourceId: string) => void;
  onReconnect: () => void;
  onRequestVaultUnlock: () => void;
};

/**
 * Recent mail, a provider-backed search, and the exact message a row names.
 * Reads Mail's own connection through the Overview routes; it needs no receipt
 * scan, no Calendar and no follow-up monitor, and it never mutates the mailbox.
 */
export function MailOverview({
  userId,
  accountKey,
  expectedAccount,
  vaultOwnerToken,
  active,
  onCompose,
  onReply,
  onReconnect,
  onRequestVaultUnlock,
}: MailOverviewProps) {
  const mail = useMailOverview({
    userId,
    accountKey,
    expectedAccount,
    vaultOwnerToken,
    connected: true,
    active,
  });
  const [query, setQuery] = useState("");
  const [queryTooLong, setQueryTooLong] = useState(false);
  const [reply, setReply] = useState<{ busy: boolean; failure: MailFailureCopy | null }>({
    busy: false,
    failure: null,
  });
  const root = useRef<HTMLElement>(null);
  const openedRef = useRef<string | null>(null);
  const openedSourceId = mail.opened?.sourceId ?? null;
  useEffect(() => {
    openedRef.current = openedSourceId;
  }, [openedSourceId]);

  // A search restored from where the person left off fills the field too.
  const submittedQuery = mail.search?.query ?? null;
  useEffect(() => {
    if (submittedQuery !== null) setQuery(submittedQuery);
  }, [submittedQuery]);
  useEffect(() => {
    setReply({ busy: false, failure: null });
  }, [openedSourceId]);

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const text = query.trim();
      if (!text) return;
      if (new TextEncoder().encode(text).length > MAIL_SEARCH_QUERY_MAX) {
        setQueryTooLong(true);
        return;
      }
      setQueryTooLong(false);
      void mail.submitSearch(text);
    },
    [mail, query],
  );

  const leaveSearch = useCallback(() => {
    setQuery("");
    setQueryTooLong(false);
    mail.clearSearch();
  }, [mail]);

  const closeMessage = useCallback(() => {
    const sourceId = openedRef.current;
    mail.closeOpened();
    // Back returns to the row that was chosen, in the same list and place.
    window.requestAnimationFrame(() => {
      if (!sourceId) return;
      root.current
        ?.querySelector<HTMLElement>(`[data-source-id="${sourceId}"]`)
        ?.focus();
    });
  }, [mail]);

  const startReply = useCallback(async () => {
    const sourceId = openedRef.current;
    if (!sourceId || reply.busy) return;
    setReply({ busy: true, failure: null });
    try {
      const source = await mail.replySource(sourceId);
      // The screen moved on while the reference was being prepared: drop it.
      if (openedRef.current !== sourceId) return;
      setReply({ busy: false, failure: null });
      onReply(source, sourceId);
    } catch (error) {
      if (openedRef.current !== sourceId) return;
      const failure =
        error instanceof MailOverviewError ? error : new MailOverviewError("unknown");
      setReply({ busy: false, failure: mailReplyFailureCopy(failure) });
    }
  }, [mail, onReply, reply.busy]);

  const searching = mail.search !== null;
  const section = mail.search ?? mail.recent;
  const page = section.page;
  const rows = !page
    ? []
    : searching || mail.recent.expanded
      ? page.items
      : page.items.slice(0, MAIL_OVERVIEW_INITIAL_ROWS);
  const failure = section.error
    ? mailReadFailureCopy(section.error, { kept: Boolean(page) })
    : null;
  const unlockNeeded = !mail.ready && !vaultOwnerToken;
  const updatedAt = formatUpdatedTime(mail.recent.fetchedAt);

  if (mail.opened) {
    return (
      <section ref={root} aria-label="Mail overview" className={styles.overview}>
        <MailMessageView
          opened={mail.opened}
          backLabel={searching ? "Search results" : "Recent mail"}
          onBack={closeMessage}
          onRetry={mail.retryOpen}
          onReconnect={onReconnect}
          onUnlock={onRequestVaultUnlock}
          onReply={() => void startReply()}
          replyBusy={reply.busy}
          replyFailure={reply.failure}
        />
      </section>
    );
  }

  return (
    <section ref={root} aria-label="Mail overview" className={styles.overview}>
      <form role="search" aria-label="Search mail" className={styles.searchRow} onSubmit={submit}>
        <Input
          type="search"
          aria-label="Search mail"
          placeholder="Search mail"
          autoComplete="off"
          enterKeyHint="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setQueryTooLong(false);
          }}
        />
        <MailActionButton
          type="submit"
          disabled={!query.trim() || mail.search?.loading === true}
        >
          Search
        </MailActionButton>
      </form>
      {queryTooLong ? (
        <p role="alert" className={styles.status}>
          That search is too long. Shorten it and try again.
        </p>
      ) : null}

      <div className={styles.headerRow}>
        {searching ? (
          <button type="button" className={styles.backLink} onClick={leaveSearch}>
            <ChevronLeft aria-hidden="true" className="size-4" />
            Recent mail
          </button>
        ) : (
          <h2 className={mailStyles.sectionTitle}>Recent mail</h2>
        )}
        <MailActionButton type="button" onClick={onCompose}>
          Compose
        </MailActionButton>
      </div>
      <p className={cn(mailStyles.support, styles.scope)}>
        {searching
          ? `Results for “${mail.search?.query}” · ${page?.scope.label ?? "All mail (Spam and Trash excluded)"}`
          : `${page?.scope.label ?? "Inbox"} · newest first`}
      </p>
      {/* How old the list is, and a way to read newer mail. The list never
          reorders by itself: a row moving under a tap is worse than a stale one. */}
      {!searching && !unlockNeeded && page && updatedAt ? (
        <div className={styles.freshness}>
          <span className={mailStyles.support}>Updated {updatedAt}</span>
          <button
            type="button"
            className={styles.textAction}
            onClick={() => void mail.refresh()}
            disabled={mail.recent.refreshing}
            aria-busy={mail.recent.refreshing}
          >
            {mail.recent.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      ) : null}

      {unlockNeeded ? (
        <FailureBlock
          failure={{ message: "Unlock your vault to see your mail.", action: "unlock" }}
          onRetry={mail.refresh}
          onReconnect={onReconnect}
          onUnlock={onRequestVaultUnlock}
        />
      ) : null}

      {!unlockNeeded && (section.loading || (!page && !failure)) ? (
        <MailMessageListSkeleton
          message={searching ? "Searching your mail…" : "Loading your mail…"}
        />
      ) : null}

      {failure && page ? (
        <p role="status" className={styles.status}>
          {failure.message}{" "}
          <button type="button" className={styles.textAction} onClick={mail.refresh}>
            Try again
          </button>
        </p>
      ) : null}
      {failure && !page ? (
        <FailureBlock
          failure={failure}
          onRetry={mail.refresh}
          onReconnect={onReconnect}
          onUnlock={onRequestVaultUnlock}
        />
      ) : null}

      {page && rows.length > 0 ? (
        <MailMessageList
          rows={rows}
          label={searching ? "Search results" : "Recent mail"}
          onOpen={(row) => void mail.openRow(row)}
        />
      ) : null}

      {/* Verified empty: the read succeeded and the scope really has no mail. */}
      {page && rows.length === 0 && !failure ? (
        <p role="status" className={styles.note}>
          {searching ? "No matching emails." : "No mail in your Inbox."}
        </p>
      ) : null}

      {!searching && page && !mail.recent.expanded && page.coverage.moreAvailable ? (
        <div>
          <button
            type="button"
            className={styles.textAction}
            onClick={() => void mail.viewMore()}
            disabled={mail.recent.refreshing}
          >
            View more
          </button>
        </div>
      ) : null}
      {!searching && mail.recent.expanded && mail.recent.refreshing ? (
        <p role="status" className={styles.note}>
          Loading more mail…
        </p>
      ) : null}
      {!searching &&
      mail.recent.expanded &&
      !mail.recent.refreshing &&
      page?.coverage.moreAvailable ? (
        <p className={styles.note}>
          Showing the newest {page.items.length} in your Inbox. Search to find older mail.
        </p>
      ) : null}
      {searching && page?.coverage.moreAvailable ? (
        <p className={styles.note}>
          Showing the first {page.items.length} matches. Refine your search to narrow them.
        </p>
      ) : null}
    </section>
  );
}
