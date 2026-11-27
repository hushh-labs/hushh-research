"use client";

import { useMemo } from "react";

import { noticeInsight } from "@/lib/mail/receipt-notice";
import { receiptPriceUpdate, type ReceiptPriceUpdate } from "@/lib/mail/receipt-price-update";
import { MailBriefSections, type MailBriefSectionsProps } from "./mail-brief";
import { useReceiptTracking } from "./receipts/receipt-tracking-context";
import { useVisibleInsights } from "./receipts/receipt-insights-ui";

/**
 * The Overview brief plus the price rises One's mailbox check already saved in
 * Receipts. A rise the owner dismissed or already answered stays out of the way
 * here exactly as it does there, and each one opens its own Receipts finding.
 * Reading the saved findings needs no network and starts no check.
 */
export function MailBriefPanel(props: Omit<MailBriefSectionsProps, "receiptUpdates">) {
  const tracking = useReceiptTracking();
  const saved = tracking?.doc?.notice.findings;
  const rises = useMemo(
    () => (saved ?? []).filter((finding) => finding.kind === "price_rise").map(noticeInsight),
    [saved],
  );
  const visible = useVisibleInsights(rises);
  const receiptUpdates = useMemo(
    () =>
      visible
        .map((insight) => (insight.notice ? receiptPriceUpdate(insight.notice) : null))
        .filter((update): update is ReceiptPriceUpdate => update !== null),
    [visible],
  );
  return <MailBriefSections {...props} receiptUpdates={receiptUpdates} />;
}
