import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { receiptSnapshotRows, type ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { buildGmailWorkspaceRoute } from "@/lib/navigation/routes";

export interface DueReceiptItem {
  id: string;
  merchantName: string;
  title: string;
  amount: string | null;
  date: string | null;
  status: "overdue" | "renewal_due" | "payment_failed" | "attention";
  statusLabel: string;
  href: string;
}

type DueReceiptSource = Partial<Pick<ReceiptListItem,
  "source_id" | "gmail_message_id" | "status" | "attention_reason" | "attention_state" |
  "merchant_name" | "from_name" | "amount" | "currency" | "attention_date" |
  "receipt_date" | "transaction_date" | "subject" | "short_detail"
>> & { id: number | string };

export function extractSavedDueReceipts(snapshot: ReceiptSnapshot | null): DueReceiptItem[] {
  if (!snapshot) return [];
  return extractDueReceipts(receiptSnapshotRows(snapshot).filter(row => !row.archived).map(row => ({
    id: row.id, merchant_name: row.merchantName, amount: row.amount, currency: row.currency,
    status: row.status, attention_state: row.attentionState, attention_reason: row.attentionReason,
    attention_date: row.attentionDate, receipt_date: row.receiptDate,
  })));
}

export function extractDueReceipts(
  items: readonly DueReceiptSource[],
): DueReceiptItem[] {
  const dueItems: DueReceiptItem[] = [];
  for (const item of items) {
    const isOverdue =
      item.status === "overdue" || item.attention_reason === "overdue";
    const isFailed =
      item.status === "payment_failed" ||
      item.attention_reason === "payment_failed";
    const isRenewal =
      item.status === "renewal_due" || item.attention_reason === "renewal_due";
    const isSuspended =
      item.status === "suspended" || item.attention_reason === "suspended";
    const needsAttention =
      item.attention_state === "needs_attention" ||
      item.attention_state === "coming_up" ||
      item.attention_state === "needs_review";

    if (
      !isOverdue &&
      !isFailed &&
      !isRenewal &&
      !isSuspended &&
      !needsAttention
    ) {
      continue;
    }

    const status: DueReceiptItem["status"] = isFailed
      ? "payment_failed"
      : isOverdue
        ? "overdue"
        : isRenewal
          ? "renewal_due"
          : "attention";

    const statusLabel = isFailed
      ? "Payment failed"
      : isOverdue
        ? "Payment overdue"
        : isRenewal
          ? "Renewal due"
          : isSuspended
            ? "Payment suspended"
            : "Review payment";

    const merchant = item.merchant_name || item.from_name || "Payment due";
    const amountStr =
      typeof item.amount === "number" && Number.isFinite(item.amount)
        ? new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: item.currency || "USD",
          }).format(item.amount)
        : null;

    const dateStr =
      item.attention_date || item.receipt_date || item.transaction_date || null;
    let formattedDate: string | null = null;
    if (dateStr) {
      const parsed = new Date(dateStr);
      if (!Number.isNaN(parsed.getTime())) {
        formattedDate = new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
        }).format(parsed);
      }
    }

    dueItems.push({
      id: String(item.source_id || item.gmail_message_id || item.id),
      merchantName: merchant,
      title: item.subject || item.short_detail || merchant,
      amount: amountStr,
      date: formattedDate,
      status,
      statusLabel,
      href: buildGmailWorkspaceRoute("receipts"),
    });
  }
  return dueItems;
}
