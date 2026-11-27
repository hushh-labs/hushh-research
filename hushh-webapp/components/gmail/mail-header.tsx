"use client";

import { useRef } from "react";

import { TopBarRouteAccessory } from "@/components/app-ui/top-bar-route-accessory";
import { ChevronDown, Mail, Plus } from "@/components/icons";
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
  onReconnect: () => void;
  onDisconnect: () => void;
  /** Present when the owner can hold several mailboxes: the menu then lists them. */
  accounts?: readonly MailHeaderAccount[];
  selectedId?: string | null;
  onChoose?: (id: string) => void;
  onAddAccount?: () => void;
  /**
   * `content` draws the product mark and the owner's initial on the page.
   * `top-bar` puts only the mailbox controls beside the app's own avatar, so the
   * screen has one header and shows "Mail" once.
   */
  placement?: "content" | "top-bar";
};

/**
 * The selected mailbox with how many things need the owner, and the one Add
 * account action. The menu switches mailboxes and keeps Reconnect and
 * Disconnect with their confirmation.
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
}: MailHeaderProps) {
  const openingConfirmation = useRef(false);
  const label = email ?? (accounts?.length ? "Choose a mailbox" : "Connected mail");
  const selected = accounts?.find((account) => account.id === selectedId) ?? null;
  const reconnectNeeded = Boolean(selected?.needsReconnect);
  const manageable = Boolean(selected) || !accounts?.length;
  return (
    <>
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
            {attentionCount > 0 ? (
              <span className={styles.badge} aria-hidden="true" data-testid="mail-attention-count">
                {attentionCount}
              </span>
            ) : null}
            <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className={`${mailStyles.typography} ${mailStyles.portal} w-64 max-w-[calc(100vw-2rem)]`}
          onCloseAutoFocus={(event) => {
            // Let the confirmation dialog own focus after Disconnect.
            if (openingConfirmation.current) event.preventDefault();
          }}
        >
          {accounts?.length ? (
            <>
              <DropdownMenuLabel className="px-3 text-[12px] font-semibold text-muted-foreground">Mailboxes</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={selectedId ?? ""} onValueChange={(id) => onChoose?.(id)}>
                {accounts.map((account) => (
                  <DropdownMenuRadioItem
                    key={account.id}
                    value={account.id}
                    disabled={busy || account.needsReconnect}
                    className="min-h-11 px-3 pr-8"
                    data-testid="mail-account-option"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{account.email}</span>
                      {account.needsReconnect ? (
                        <span className="text-[12px] text-muted-foreground">Reconnect needed</span>
                      ) : null}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {manageable ? <DropdownMenuSeparator /> : null}
            </>
          ) : null}
          {manageable ? (
            <DropdownMenuItem className="min-h-11 px-3" disabled={busy} onSelect={onReconnect}>
              {reconnectNeeded ? "Reconnect to continue" : "Reconnect"}
            </DropdownMenuItem>
          ) : null}
          {manageable ? <DropdownMenuSeparator /> : null}
          {manageable ? (
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
        </DropdownMenuContent>
      </DropdownMenu>
      {onAddAccount ? (
        <button
          type="button"
          className={styles.addAccount}
          disabled={busy}
          onClick={onAddAccount}
          aria-label="Add account"
          data-testid="mail-add-account"
        >
          <Plus aria-hidden="true" className="size-4" />
          <span className={styles.addAccountLabel}>Add account</span>
        </button>
      ) : null}
    </>
  );
}

/**
 * The Mail header. In `content` placement: the product mark on the left, and on
 * the right the selected mailbox, the one Add account action and the owner's
 * initial. In `top-bar` placement the mailbox controls join the app bar's own
 * avatar, so Mail is named once.
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
