"use client";

import { useRef } from "react";

import { TopBarRouteAccessory } from "@/components/app-ui/top-bar-route-accessory";
import { CheckCircle2, ChevronDown, Mail, Plus } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import styles from "./mail-brief.module.css";
import mailStyles from "./mail-workspace.module.css";

/** One mailbox the owner can switch to. A lapsed permission is listed, never silently skipped. */
export type MailHeaderAccount = { id: string; email: string; needsReconnect?: boolean };

export type MailHeaderProps = {
  email: string | null;
  /** How many items need the owner now; the badge is hidden at zero or unknown. */
  attentionCount: number;
  busy?: boolean;
  /** The single-mailbox menu's Reconnect and Disconnect. A menu of several mailboxes has neither. */
  onReconnect?: () => void;
  onDisconnect?: () => void;
  /** Present when the owner can hold several mailboxes: the menu then lists them. */
  accounts?: readonly MailHeaderAccount[];
  selectedId?: string | null;
  onChoose?: (id: string) => void;
  /** Add account sits at the bottom of the menu, and only while another mailbox still fits. */
  onAddAccount?: () => void;
  /** Reconnects one listed mailbox whose permission lapsed. */
  onReconnectAccount?: (id: string) => void;
  /** How many mailboxes the owner may connect. Add account disappears at this many. */
  maxAccounts?: number;
  /** What needs the owner in each mailbox One has already read, by mailbox id. */
  counts?: Readonly<Record<string, number>>;
  /**
   * `content` draws the product mark and the owner's initial on the page.
   * `top-bar` puts only the mailbox controls beside the app's own avatar, so the
   * screen has one header and shows "Mail" once.
   */
  placement?: "content" | "top-bar";
};

const countBadge = (count: number | undefined) =>
  typeof count === "number" && count > 0 ? (
    <span className={styles.badge} aria-hidden="true" data-testid="mail-attention-count">
      {count}
    </span>
  ) : null;

/**
 * The selected mailbox with how many things need the owner. For an owner who can
 * hold several mailboxes the menu lists them (the chosen one checked, each with
 * what needs them), then Add account while there is room. Without that list it is
 * the single-mailbox menu: Reconnect and Disconnect.
 */
function MailboxControls({
  email,
  attentionCount,
  busy = false,
  onReconnect,
  onDisconnect,
  accounts,
  selectedId = null,
  onChoose,
  onAddAccount,
  onReconnectAccount,
  maxAccounts = 3,
  counts,
}: MailHeaderProps) {
  const openingConfirmation = useRef(false);
  const multi = accounts !== undefined;
  const label = email ?? (accounts?.length ? "Choose a mailbox" : "Connected mail");
  const canAdd = multi && Boolean(onAddAccount) && accounts.length < maxAccounts;
  const usable = accounts?.filter((account) => !account.needsReconnect) ?? [];
  const lapsed = accounts?.filter((account) => account.needsReconnect) ?? [];

  // Nothing is connected yet: there is no list to open, so the one thing to do is offered directly.
  if (multi && accounts.length === 0) {
    return onAddAccount ? (
      <button type="button" className={styles.addAccount} disabled={busy} onClick={onAddAccount} data-testid="mail-add-account">
        <Plus aria-hidden="true" className="size-4" />
        <span>Add account</span>
      </button>
    ) : null;
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) openingConfirmation.current = false;
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={styles.chip}
          disabled={busy}
          aria-label={`Mailbox ${label}${attentionCount > 0 ? `, ${attentionCount} need you` : ""}. Manage`}
          data-testid="mail-account-chip"
        >
          <span className={styles.chipEmail}>{label}</span>
          {countBadge(attentionCount)}
          <ChevronDown aria-hidden="true" className={`size-4 shrink-0 ${styles.chevron}`} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={10}
        collisionPadding={16}
        className={`${mailStyles.typography} ${mailStyles.portal} ${multi ? styles.accountMenu : "w-48"}`}
        onCloseAutoFocus={(event) => {
          // Let the confirmation dialog own focus after Disconnect.
          if (openingConfirmation.current) event.preventDefault();
        }}
      >
        {multi ? (
          <>
            <DropdownMenuLabel className="sr-only">Mailboxes</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={selectedId ?? ""} onValueChange={(id) => onChoose?.(id)}>
              {usable.map((account) => (
                <DropdownMenuRadioItem
                  key={account.id}
                  value={account.id}
                  disabled={busy}
                  className={`${styles.accountRow} min-h-12 rounded-[14px] px-3.5 pl-3.5 text-[16px] [&>span:first-child]:hidden data-[state=checked]:bg-[color:var(--app-accent-tint)]`}
                  data-testid="mail-account-option"
                >
                  <span className={styles.accountEmail}>{account.email}</span>
                  <span className={styles.accountMeta}>
                    {account.id === selectedId ? (
                      <CheckCircle2 aria-label="Selected" className="size-5 text-[color:var(--app-accent)]" />
                    ) : null}
                    {countBadge(counts?.[account.id])}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {lapsed.map((account) => (
              <DropdownMenuItem
                key={account.id}
                disabled={busy}
                className={`${styles.accountRow} min-h-12 rounded-[14px] px-3.5 text-[16px]`}
                onSelect={() => onReconnectAccount?.(account.id)}
                data-testid="mail-account-reconnect"
              >
                <span className={styles.accountEmail}>{account.email}</span>
                <span className={styles.reconnectLink}>Reconnect</span>
              </DropdownMenuItem>
            ))}
            {canAdd ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={busy}
                  className={`${styles.accountRow} ${styles.addRow} min-h-12 rounded-[14px] px-3.5 text-[16px]`}
                  onSelect={() => onAddAccount?.()}
                  data-testid="mail-add-account"
                >
                  <span className={styles.addIcon} aria-hidden="true">
                    <Plus className="size-4" />
                  </span>
                  <span>Add account</span>
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        ) : (
          <>
            {onReconnect ? (
              <DropdownMenuItem className="min-h-11 px-3" disabled={busy} onSelect={onReconnect}>
                Reconnect
              </DropdownMenuItem>
            ) : null}
            {onReconnect && onDisconnect ? <DropdownMenuSeparator /> : null}
            {onDisconnect ? (
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
            ) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The Mail header. In `content` placement: the product mark on the left, and on
 * the right the selected mailbox and the owner's initial. In `top-bar` placement
 * the mailbox controls join the app bar's own avatar, so Mail is named once.
 */
export function MailHeader(props: MailHeaderProps) {
  if (props.placement === "top-bar") {
    return (
      <TopBarRouteAccessory>
        <div className={`${styles.accessory} ${mailStyles.typography}`} data-testid="mail-header" data-placement="top-bar">
          <MailboxControls {...props} />
        </div>
      </TopBarRouteAccessory>
    );
  }
  const initial = (props.email ?? "").trim().charAt(0).toUpperCase() || "M";
  return (
    <header className={styles.header} data-testid="mail-header" data-placement="content">
      <div className={styles.brand}>
        <span aria-hidden="true" data-testid="mail-connected-account-icon" className={styles.brandIcon}>
          <Mail className="size-6" />
        </span>
        <p className={styles.brandName} aria-hidden="true">
          Mail
        </p>
      </div>
      <div className={styles.who}>
        <MailboxControls {...props} />
        <span aria-hidden="true" className={styles.avatar}>
          {initial}
        </span>
      </div>
    </header>
  );
}
