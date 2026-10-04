"use client";

import { AlertCircle, Check, FileText, Mail, PenLine, Undo2 } from "@/components/icons";
import { useRef, type CSSProperties } from "react";
import styles from "./mail-overview.module.css";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AskOneButton } from "@/components/agent/ask-one-button";
import { SettingsRow } from "@/components/app-ui/settings-ui";

/**
 * Ring with a single rotating arc. The track stays put and only the arc
 * turns, so the motion reads as activity at a glance. The global
 * `.animate-spin` rule keeps it turning even under Reduce Motion, which is the
 * convention for every other loading indicator in the app.
 */
function ReceiptSyncSpinner() {
  return (
    <span role="status" aria-label="Fetching receipts" className="relative block size-6 shrink-0">
      <span aria-hidden="true" className="absolute inset-0 rounded-full border-[2.5px] border-emerald-500/20" />
      <span aria-hidden="true" className="absolute inset-0 animate-spin rounded-full border-[2.5px] border-transparent border-t-emerald-600 dark:border-t-emerald-400" />
    </span>
  );
}

/** The existing Mail identity, reused in the connected-account card. */
function MailOverviewIcon() {
  return (
    <span aria-hidden="true" className="relative flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
      <Mail className="size-7" />
      <PenLine className="absolute bottom-2 right-1.5 size-3.5 rounded bg-[color:var(--app-accent-surface)]" />
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
    <div className="flex items-center justify-between gap-3 rounded-[22px] border border-border/60 bg-card p-4 shadow-sm lg:py-3">
      <div className="flex min-w-0 items-center gap-3.5">
        <MailOverviewIcon />
        <div>
          <h2 className="text-foreground [--foundation-title2-size:17px] [--foundation-title3-size:17px] [--foundation-title2-line:1.3] [--foundation-title3-line:1.3] [--foundation-title2-weight:700] [--foundation-title3-weight:700]">Mail</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-[13px] font-medium text-emerald-700 dark:text-emerald-400">
            <span aria-hidden="true" className="size-2.5 rounded-full bg-emerald-500" />
            Connected
          </p>
        </div>
      </div>
      <DropdownMenu onOpenChange={(open) => {
        if (open) openingConfirmation.current = false;
      }}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={busy}
            className="min-h-11 shrink-0 bg-transparent px-2 text-sm font-medium text-[color:var(--app-accent)] outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] disabled:opacity-50"
          >
            Manage
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="w-48"
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
  fetching,
  receiptDetail,
  receiptUpdated,
  receiptIssue = false,
  receiptCount,
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
    <section aria-label="Mail overview" className="w-full pb-4 pt-5 sm:pt-8 lg:pb-0 lg:pt-0">
      <div className="grid min-h-[232px] grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] items-center gap-1 pb-5 sm:min-h-[280px] sm:grid-cols-[1.2fr_1fr] sm:gap-8 sm:pb-8 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-6 lg:pb-2">
        <div className="relative z-10 min-w-0">
          <h2 className="text-foreground [--foundation-title2-size:clamp(1.75rem,8.2vw,2.125rem)] [--foundation-title3-size:var(--foundation-title2-size)] [--foundation-title2-line:1.08] [--foundation-title3-line:1.08] [--foundation-title2-weight:800] [--foundation-title3-weight:800] sm:[--foundation-title2-size:44px]">
            Draft with<br /><span className="text-[color:var(--app-accent)]">One.</span>
          </h2>
          <ul className="mt-4 space-y-2 text-[clamp(0.65rem,2.9vw,0.8125rem)] font-medium text-muted-foreground sm:text-sm">
            {["Instant drafts & replies", "Ready for your 1-tap review"].map((benefit) => (
              <li key={benefit} className="flex items-center gap-2">
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent)]">
                  <Check aria-hidden="true" className="size-3" />
                </span>
                <span>{benefit}</span>
              </li>
            ))}
          </ul>
        </div>
        <div aria-hidden="true" className="min-w-0 pr-1 sm:pr-3">
          <div data-testid="mail-draft-cards" className={`${styles.stack} ml-auto w-full max-w-[154px] sm:max-w-[220px] lg:ml-0 lg:max-w-[300px]`}>
            {[
              { label: "Reply", icon: Undo2, width: "w-3/4" },
              { label: "Follow up", icon: FileText, width: "w-2/3" },
              { label: "Write", icon: PenLine, width: "w-1/2" },
            ].map(({ label, icon: Icon, width }, index) => (
              <div key={label} data-testid="mail-draft-card" style={{ "--card-index": index } as CSSProperties} className={`${styles.card} rounded-[12px] border border-border/40 bg-card p-2.5 shadow-[0_8px_20px_-6px_color-mix(in_srgb,var(--app-accent)_18%,transparent)] sm:rounded-[16px] sm:p-4 lg:py-2`}>
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground sm:text-sm">
                  <Icon className="size-3.5 shrink-0 text-[color:var(--app-accent)] sm:size-4" />
                  {label}
                </div>
                <div className="mt-2 space-y-1 pl-5 sm:mt-3 sm:pl-6">
                  <div className="h-1.5 w-full rounded-full bg-muted-foreground/20" />
                  <div className={`h-1.5 rounded-full bg-muted-foreground/10 ${width}`} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="border-t border-border/50 py-3 sm:py-4 lg:py-2">
        <SettingsRow
          title="Receipt sync"
          leading={<span aria-hidden="true" className={`flex size-12 shrink-0 items-center justify-center rounded-full ${receiptIssue ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"}`}>{receiptIssue ? <AlertCircle className="size-6" /> : <FileText className="size-6" />}</span>}
          description={<span className="block space-y-0.5"><span className="block text-[13px] leading-snug">{receiptDetail}</span>{receiptUpdated || receiptCount !== undefined ? <span className="block text-xs leading-snug text-muted-foreground/75">{[receiptCount !== undefined ? `${receiptCount} receipt${receiptCount === 1 ? "" : "s"}` : null, receiptUpdated].filter(Boolean).join(" · ")}</span> : null}</span>}
          trailing={fetching ? <ReceiptSyncSpinner /> : undefined}
          testId="mail-receipt-sync"
          className={`!rounded-[20px] border ${receiptIssue ? "border-destructive/20 bg-destructive/[0.06] dark:bg-destructive/10" : "border-emerald-500/15 bg-emerald-500/[0.06] dark:bg-emerald-500/10"}`}
        />
      </div>
      <div className="mx-auto mt-3 w-full max-w-[244px] lg:mt-1">
        <AskOneButton onClick={onOpenChat} showIcon={false} size="prominent" className="w-full sm:w-full">
          Chat with One
        </AskOneButton>
      </div>
    </section>
  );
}
