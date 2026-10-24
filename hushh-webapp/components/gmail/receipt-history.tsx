"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { HelperText } from "@/components/app-ui/typography";
import { MailReceiptHistoryService as History } from "@/lib/services/mail-receipt-history-service";
import type { ReceiptStoreSession } from "@/lib/mail/receipt-store";
import { GmailRecentReceipts } from "./gmail-recent-receipts";
import { MailActionButton } from "./mail-action-button";

export function ReceiptHistory({ session, getIdToken, allowRead, active }: { session: ReceiptStoreSession; getIdToken: () => Promise<string>; allowRead: boolean; active: boolean }) {
  const resource = useSyncExternalStore(History.subscribe, () => History.peek(session.userId), () => History.peek(""));
  const open = useCallback((retry = false) => History.open(session, getIdToken, allowRead, retry).catch(() => {}), [session, getIdToken, allowRead]);
  useEffect(() => { if (active) void open(); }, [open, active]);
  const detail = useCallback(async (sourceId: string) => {
    const item = History.peek(session.userId).items.find(row => row.source_id === sourceId);
    if (!item || !session.isCurrent?.()) throw new Error("Open your vault to view saved history.");
    return { item, source_evidence: [], email_excerpt: null, live_unavailable: "This saved history has no verified original Mail account or source email." };
  }, [session]);
  if (!resource.items.length && !resource.refreshing && !resource.error) return null;
  return <section className="space-y-3" aria-label="Earlier saved receipts" data-testid="receipt-history" data-no-auto-fade="true" aria-busy={resource.refreshing}>
    <div className="flex min-h-20 items-center justify-between gap-3">
      <HelperText as="p" role="status">{resource.refreshing ? "Opening earlier saved receipts…" : resource.error ??
        "Saved history · original Mail account unverified"}</HelperText>
      {resource.error ? <MailActionButton disabled={resource.refreshing} onClick={() => void open(true)}>Try opening history again</MailActionButton> : null}
    </div>
    {resource.items.length ? <GmailRecentReceipts accountKey={null} headingId="earlier-receipts-title" title="Earlier saved receipts" showOverview={false}
      receipts={resource.items} loadReceiptDetail={detail} /> : null}
  </section>;
}
