"use client";
import Link from "next/link";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { buildGmailWorkspaceRoute } from "@/lib/navigation/routes";
import { Receipt, ExternalLink } from "@/components/icons";
import { CaptionText, MediumRowLabel, SectionLabel } from "@/components/app-ui/typography";

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

export function extractDueReceipts(
  items: readonly ReceiptListItem[],
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

export function DueReceiptRow({ receipt }: { receipt: DueReceiptItem }) {
  return (
    <div data-receipt-item={receipt.id}>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[color:var(--app-neutral-fill)] text-foreground">
            <Receipt className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <MediumRowLabel as="h3" data-profile-role="name" className="min-w-0 break-words [overflow-wrap:anywhere]">
                {receipt.merchantName}
              </MediumRowLabel>
              <span
                data-profile-role="description"
                className={cn(
                  "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                  receipt.status === "overdue" ||
                    receipt.status === "payment_failed"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)]",
                )}
              >
                {receipt.statusLabel}
              </span>
            </div>
            <div data-profile-role="description" className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {receipt.amount ? (
                <span className="font-semibold text-foreground">
                  {receipt.amount}
                </span>
              ) : null}
              {receipt.amount && receipt.date ? <span>·</span> : null}
              {receipt.date ? <span>{receipt.date}</span> : null}
              {receipt.title && receipt.title !== receipt.merchantName ? (
                <>
                  <span>·</span>
                  <span className="truncate max-w-[200px]">
                    {receipt.title}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <Button
          asChild
          variant="none"
          effect="fade"
          size="compact"
          data-profile-role="action"
          className="min-h-11 shrink-0 !px-2 !text-[color:var(--app-accent)]"
        >
          <Link
            href={receipt.href}
            aria-label={`View ${receipt.merchantName} receipt`}
          >
            View
            <ExternalLink className="ml-1 size-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

export function DueReceiptsSection({
  receipts,
}: {
  receipts: DueReceiptItem[];
}) {
  if (receipts.length === 0) return null;
  return (
    <section aria-label="Due payments and receipts">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <SectionLabel as="h2" data-profile-role="group-label" compact>
          <span>Receipts & Due Payments</span>
        </SectionLabel>
        <CaptionText data-profile-role="group-label" className="tabular-nums !text-[color:var(--app-secondary-label)]">
          {receipts.length}
        </CaptionText>
      </div>
      <SurfaceInset className="divide-y divide-border/60 p-0">
        {receipts.map((receipt) => (
          <DueReceiptRow key={receipt.id} receipt={receipt} />
        ))}
      </SurfaceInset>
    </section>
  );
}
