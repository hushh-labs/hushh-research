"use client";

import { Check, FileText, Mail, PenLine, Undo2 } from "@/components/icons";
import { useRef, type CSSProperties } from "react";
import styles from "./mail-overview.module.css";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MailActionButton } from "./mail-action-button";
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

export function MailOverview({
  onOpenChat,
}: {
  fetching: boolean;
  receiptDetail: string;
  receiptUpdated: string | null;
  receiptIssue?: boolean;
  receiptCount?: number;
  onOpenChat: () => void;
}) {
  return (
    <section aria-label="Mail overview" className={mailStyles.overview}>
      <div className={mailStyles.overviewCopy}>
        <h2 className={mailStyles.sectionTitle}>Draft with <span className="text-[color:var(--app-accent)]">One.</span></h2>
        <ul className={`${mailStyles.benefits} ${mailStyles.support} text-muted-foreground`}>
          {["Instant drafts & replies", "Ready for your 1-tap review"].map((benefit) => (
            <li key={benefit} className="flex items-center gap-2">
              <Check aria-hidden="true" className="size-4 text-[color:var(--app-accent)]" />
              <span>{benefit}</span>
            </li>
          ))}
        </ul>
      </div>
      <div aria-hidden="true" className="min-w-0">
        <div data-testid="mail-draft-cards" className={`${styles.stack} w-full max-w-[300px]`}>
          {[
            { label: "Reply", icon: Undo2, width: "w-3/4" },
            { label: "Follow up", icon: FileText, width: "w-2/3" },
            { label: "Write", icon: PenLine, width: "w-1/2" },
          ].map(({ label, icon: Icon, width }, index) => (
            <div key={label} data-testid="mail-draft-card" style={{ "--card-index": index } as CSSProperties} className={`${styles.card} rounded-xl border border-border/40 bg-card p-3`}>
              <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                <Icon className="size-4 text-[color:var(--app-accent)]" />{label}
              </div>
              <div className="mt-2 space-y-1 pl-6">
                <div className="h-1.5 w-full rounded-full bg-muted-foreground/20" />
                <div className={`h-1.5 rounded-full bg-muted-foreground/10 ${width}`} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div><MailActionButton onClick={onOpenChat}>Chat with One</MailActionButton></div>
    </section>
  );
}
