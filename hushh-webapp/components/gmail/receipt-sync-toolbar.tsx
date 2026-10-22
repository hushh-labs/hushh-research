"use client";
import { RefreshCw } from "@/components/icons";
import { HelperText, SectionTitle } from "@/components/app-ui/typography";
import { MailActionButton } from "./mail-action-button";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import type { ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";

export function ReceiptSyncToolbar({ snapshot, refreshing, error, disabled, onRefresh }: {
  snapshot: ReceiptSnapshot | null; refreshing: boolean; error: string | null; disabled: boolean; onRefresh?: () => void;
}) {
  const status = refreshing ? "Checking for new receipts…" : error ||
    (snapshot ? `${snapshot.coverage.partial ? "Saved sample · " : ""}Updated ${formatLocalDateTime(snapshot.freshness, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Receipts update automatically.");
  return <div className="flex min-h-14 items-center justify-between gap-3" data-no-auto-fade="true" data-testid="receipt-sync-toolbar" aria-busy={refreshing}>
    <div className="min-w-0" role="status" aria-live="polite">
      <SectionTitle as="p">{snapshot ? "Saved receipts" : "Your receipts"}</SectionTitle>
      <HelperText as="p" className="block truncate text-muted-foreground" title={status}>{status}</HelperText>
    </div>
    {onRefresh ? <MailActionButton disabled={disabled || refreshing} onClick={onRefresh}
      aria-busy={refreshing} data-voice-action-id="profile.gmail.sync_now" data-voice-control-id="sync_gmail_receipts"
      data-voice-label="Refresh receipts" data-voice-purpose="checks for new Mail receipts while retaining saved receipts.">
      <RefreshCw aria-hidden="true" className={refreshing ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} /> Try again
    </MailActionButton> : null}
  </div>;
}
