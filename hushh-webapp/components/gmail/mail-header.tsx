"use client";

import { TopBarRouteAccessory } from "@/components/app-ui/top-bar-route-accessory";
import { CheckCircle2, ChevronDown, Mail, Plus } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  /** Present when the owner can hold several mailboxes: the menu then lists them. Without it the address is only shown. */
  accounts?: readonly MailHeaderAccount[];
  selectedId?: string | null;
  onChoose?: (id: string) => void;
  /** Add account sits at the bottom of the menu, and only while another mailbox still fits. */
  onAddAccount?: () => void;
  /** Choosing a listed mailbox whose permission lapsed signs it in again, with no extra step. */
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
 * what needs them), then Add account while there is room. Disconnect is not here:
 * with several mailboxes a menu row cannot say which one it would remove, so each
 * mailbox is disconnected by name from Manage mailboxes.
 */
function MailboxControls({
  email,
  attentionCount,
  busy = false,
  accounts,
  selectedId = null,
  onChoose,
  onAddAccount,
  onReconnectAccount,
  maxAccounts = 3,
  counts,
}: MailHeaderProps) {
  const multi = accounts !== undefined;
  const label = email ?? (accounts?.length ? "Choose a mailbox" : "Connected mail");
  const canAdd = multi && Boolean(onAddAccount) && accounts.length < maxAccounts;
  const usable = accounts?.filter((account) => !account.needsReconnect) ?? [];
  const lapsed = accounts?.filter((account) => account.needsReconnect) ?? [];

  // One mailbox and no list to open: the address is shown, and there is nothing to choose.
  if (!multi) {
    return (
      <span className={`${styles.chip} ${styles.chipStatic}`} data-testid="mail-account-chip">
        <span className={styles.chipEmail}>{label}</span>
        {countBadge(attentionCount)}
      </span>
    );
  }

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
    <DropdownMenu>
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
        className={`${mailStyles.typography} ${mailStyles.portal} ${styles.accountMenu}`}
      >
        <DropdownMenuRadioGroup aria-label="Mailboxes" value={selectedId ?? ""} onValueChange={(id) => onChoose?.(id)}>
          {usable.map((account) => (
            <DropdownMenuRadioItem
              key={account.id}
              value={account.id}
              disabled={busy}
              className={`${styles.accountRow} min-h-12 rounded-[16px] px-3.5 pl-3.5 text-[16px] [&>span:first-child]:hidden`}
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
        {/* A mailbox whose permission lapsed still counts toward the three. Choosing it opens Google sign-in directly. */}
        {lapsed.map((account) => (
          <DropdownMenuItem
            key={account.id}
            disabled={busy}
            className={`${styles.accountRow} min-h-12 rounded-[16px] px-3.5 text-[16px]`}
            onSelect={() => onReconnectAccount?.(account.id)}
            data-testid="mail-account-lapsed"
          >
            <span className={styles.accountEmail}>{account.email}</span>
            <span className={styles.accountMeta}>
              <span className={styles.lapsedDot} aria-hidden="true" />
              <span className="sr-only">Sign-in needed</span>
            </span>
          </DropdownMenuItem>
        ))}
        {canAdd ? (
          <>
            <DropdownMenuSeparator className={styles.menuRule} />
            <DropdownMenuItem
              disabled={busy}
              className={`${styles.accountRow} ${styles.addRow} min-h-12 rounded-[16px] px-3.5 text-[16px]`}
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
