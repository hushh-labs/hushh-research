"use client";

import { useRef } from "react";

import { ChevronDown, Mail } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import styles from "./mail-brief.module.css";
import mailStyles from "./mail-workspace.module.css";

/**
 * The Mail header: the product mark, the one connected mailbox with how many
 * things need the owner, and the owner's initial. The mailbox menu keeps the
 * existing Reconnect and Disconnect controls and their confirmation.
 */
export function MailHeader({
  email,
  attentionCount,
  busy = false,
  onReconnect,
  onDisconnect,
}: {
  email: string | null;
  /** How many items need the owner now; the badge is hidden at zero or unknown. */
  attentionCount: number;
  busy?: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const openingConfirmation = useRef(false);
  const initial = (email ?? "").trim().charAt(0).toUpperCase() || "M";
  const label = email ?? "Connected mail";
  return (
    <header className={styles.header} data-testid="mail-header">
      <div className={styles.brand}>
        <span aria-hidden="true" data-testid="mail-connected-account-icon" className={styles.brandIcon}>
          <Mail className="size-6" />
        </span>
        <p className={styles.brandName} aria-hidden="true">
          Mail
        </p>
      </div>
      <div className={styles.who}>
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
        <span aria-hidden="true" className={styles.avatar}>
          {initial}
        </span>
      </div>
    </header>
  );
}
