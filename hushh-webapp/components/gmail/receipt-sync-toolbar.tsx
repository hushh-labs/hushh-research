"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { RefreshCw } from "@/components/icons";
import { HelperText, SectionTitle } from "@/components/app-ui/typography";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ProfileConnectorsLink } from "@/components/profile/profile-connectors-link";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { MailActionButton } from "./mail-action-button";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import type { ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import type { ReceiptProgress } from "@/lib/services/mail-receipt-resource-service";
import styles from "./mail-workspace.module.css";

export function ReceiptSyncToolbar({ snapshot, refreshing, error, disabled, onRefresh, onRestore, progress = null, migration = false, active = true, restoring = false }: {
  snapshot: ReceiptSnapshot | null; refreshing: boolean; error: string | null; disabled: boolean; onRefresh?: () => void; onRestore?: () => void;
  progress?: ReceiptProgress | null; migration?: boolean; active?: boolean; restoring?: boolean;
}) {
  const pathname = usePathname();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const openingSettings = useRef(false);
  const closeDetails = useCallback(() => { setDetailsOpen(false); return true; }, []);
  useBackLayer(pathname, active && detailsOpen ? 2 : 0, closeDetails);
  useEffect(() => { if (!active) setDetailsOpen(false); }, [active]);
  const status = restoring ? "Opening saved receipts…" : refreshing
    ? progress?.phase === "opening" ? "Opening saved receipts…" : progress?.phase === "saving" ? `Saving ${progress.found} receipt${progress.found === 1 ? "" : "s"}…`
      : progress?.checked ? `${progress.checked} mail messages checked · ${progress.found} receipts found` : "Checking Mail for receipts…"
    : error || (disabled ? "New receipt updates aren’t available with this setup yet."
      : snapshot ? `${snapshot.coverage.partial ? "Some Mail remains unchecked · " : ""}Updated ${formatLocalDateTime(snapshot.freshness, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
      : "Ready to check for receipts.");
  const retry = onRestore ?? onRefresh;
  return <Dialog open={active && detailsOpen} onOpenChange={open => { openingSettings.current = false; setDetailsOpen(open); }}>
  <div className="flex min-h-20 items-center justify-between gap-3" data-no-auto-fade="true" data-testid="receipt-sync-toolbar" aria-busy={refreshing || restoring}>
    <div className="min-w-0 flex-1" role="status" aria-live="polite">
      <SectionTitle as="p">{snapshot ? "Saved receipts" : "Your receipts"}</SectionTitle>
      <HelperText as="p" className="block min-h-10 text-muted-foreground">{status}</HelperText>
    </div>
    <div className="flex shrink-0 flex-col items-end gap-1">
      {retry ? <MailActionButton disabled={refreshing || restoring} onClick={retry} aria-busy={refreshing || restoring}
        data-voice-action-id={onRestore ? "profile.gmail.restore_saved_receipts" : "profile.gmail.sync_now"} data-voice-control-id={onRestore ? "restore_saved_receipts" : "sync_gmail_receipts"} data-voice-label="Try again">
        <RefreshCw aria-hidden="true" className="size-4" /> Try again
      </MailActionButton> : null}
      {migration || disabled ? <DialogTrigger asChild><MailActionButton ref={trigger} data-voice-control-id="receipt_sync_details">View details</MailActionButton></DialogTrigger> : null}
    </div>
  </div>
    <DialogContent onCloseAutoFocus={event => { if (openingSettings.current) event.preventDefault(); }} className={`${styles.typography} ${styles.portal} sm:max-w-md`}>
      <DialogHeader><DialogTitle>Receipt updates</DialogTitle>
        <DialogDescription>{disabled ? "New receipt updates aren’t supported by your current setup yet. You can still open saved receipts found on this device."
          : "Your receipt sync continues while private receipt processing is prepared. New Mail is checked automatically when you return."}</DialogDescription>
      </DialogHeader>
      <HelperText as="p">Earlier saved history is kept separately when its original Mail account can’t be verified.</HelperText>
      <DialogFooter>
        <ProfileConnectorsLink connectorId="gmail" returnFocusRef={trigger} className={styles.utilityAction} onClick={() => { openingSettings.current = true; setDetailsOpen(false); }}>Manage Mail</ProfileConnectorsLink>
        <MailActionButton onClick={() => setDetailsOpen(false)} data-voice-control-id="receipt_sync_details_ack">Got it</MailActionButton>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
