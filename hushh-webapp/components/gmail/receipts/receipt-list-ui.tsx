"use client";

import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { receiptAttentionLabel, receiptStatusLabel } from "@/lib/profile/gmail-receipt-presentation";
import { ChevronDown, ChevronRight, Search } from "@/components/icons";
import { Input } from "@/components/ui/input";
import {
  DATE_FILTERS, TYPE_FILTERS, type DateFilter, type ReceiptFilterSelection, type TypeFilter,
} from "@/lib/mail/receipt-filters";
import { formatMajorCompact, formatMinor } from "@/lib/mail/receipt-money";
import { type MonthSummary, receiptMoneyKind } from "@/lib/mail/receipt-month-summary";
import { cn } from "@/lib/utils";
import styles from "./receipts.module.css";
import { ReceiptMerchantLogo } from "../gmail-recent-receipts";

export function ReceiptControls({
  search, onSearch, selection, onSelection,
}: {
  search: string;
  onSearch: (value: string) => void;
  selection: ReceiptFilterSelection;
  onSelection: (next: ReceiptFilterSelection) => void;
}) {
  const selectClass =
    "h-11 w-full appearance-none rounded-full border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] pl-4 pr-9 text-[16px] leading-[22px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] sm:text-[14px]";
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_150px_150px]" data-testid="receipt-controls">
      <div className="relative col-span-2 sm:col-span-1">
        <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-[color:var(--app-accent)]" />
        <Input
          type="search"
          aria-label="Search receipts"
          placeholder="Search receipts"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          className="h-11 rounded-full pl-11 text-[16px] sm:text-[14px]"
        />
      </div>
      <label className="relative block">
        <span className="sr-only">Filter by date</span>
        <select className={selectClass} value={selection.date} onChange={(event) => onSelection({ ...selection, date: event.target.value as DateFilter })} data-testid="receipt-date-filter">
          {DATE_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      </label>
      <label className="relative block">
        <span className="sr-only">Filter by type</span>
        <select className={selectClass} value={selection.type} onChange={(event) => onSelection({ ...selection, type: event.target.value as TypeFilter })} data-testid="receipt-type-filter">
          {TYPE_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      </label>
    </div>
  );
}

function net(summary: MonthSummary): { main: string; extra: string[] } {
  if (!summary.net.length) return { main: summary.paymentCount || summary.refundCount ? "—" : "", extra: [] };
  const show = (entry: { currency: string; minor: number }) => `${entry.minor < 0 ? "−" : ""}${formatMinor(Math.abs(entry.minor), entry.currency)}`;
  const [first, ...rest] = summary.net;
  return { main: show(first!), extra: rest.map(show) };
}

export function MonthHeader({ label, summary, headingId }: { label: string; summary: MonthSummary; headingId: string }) {
  const money = net(summary);
  const caption = ["After refunds", summary.unknownAmountCount ? `${summary.unknownAmountCount} amount${summary.unknownAmountCount === 1 ? "" : "s"} unknown` : null].filter(Boolean).join(" · ");
  return (
    <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4" data-testid="receipt-month-summary">
      <div className="min-w-0">
        <h3 id={headingId} className={cn(styles.monthTitle, "text-foreground")}>{label}</h3>
        <p className="text-[12px] leading-[18px] text-muted-foreground">
          {summary.paymentCount} payment{summary.paymentCount === 1 ? "" : "s"}
          {summary.refundCount ? ` · ${summary.refundCount} refund${summary.refundCount === 1 ? "" : "s"}` : ""}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[18px] leading-[24px] font-bold tabular-nums text-foreground">{money.main}</p>
        {money.extra.length ? <p className="text-[12px] leading-[18px] tabular-nums text-muted-foreground">+ {money.extra.join(" · ")}</p> : null}
        <p className="text-[12px] leading-[18px] text-muted-foreground">{caption}</p>
      </div>
    </div>
  );
}

function rowDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);
}

function rowStatus(row: RecentReceiptRow): { text: string | null; tone: "neutral" | "bad" } {
  const kind = receiptMoneyKind(row);
  const label = receiptAttentionLabel(row.attentionState, row.attentionReason, row.attentionIsPrediction) || receiptStatusLabel(row.status);
  return { text: label, tone: kind === "failed" || row.status === "overdue" || row.status === "suspended" ? "bad" : "neutral" };
}

export function ReceiptRowButton({ row, onSelect }: { row: RecentReceiptRow; onSelect: (row: RecentReceiptRow, trigger: HTMLButtonElement) => void }) {
  const amount = formatMajorCompact(row.amount, row.currency);
  const status = rowStatus(row);
  const kind = receiptMoneyKind(row);
  const type = row.secondaryDetail || (row.category && row.category !== "Other" ? row.category : null);
  const meta = [rowDate(row.receiptDate), type].filter(Boolean).join(" · ");
  const third = row.archived ? "Previously saved · reconciliation needed" : row.sourceUnavailable ? "Source unavailable" : row.recurrence === "recurring" ? "Recurring payment" : null;
  return (
    <li className="border-t border-border/60 first:border-t-0">
      <button
        type="button"
        className="grid min-h-[72px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-foreground/[0.04] active:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)]"
        data-receipt-row-id={row.id}
        data-testid="receipt-row"
        onClick={(event) => onSelect(row, event.currentTarget)}
      >
        <span className="flex min-w-0 items-center gap-3">
          <ReceiptMerchantLogo merchantName={row.merchantName} logoDomain={row.logoDomain} category={row.category} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] leading-[21px] font-semibold text-foreground">{row.merchantName}</span>
            {meta ? <span className="block truncate text-[12px] leading-[18px] text-muted-foreground">{meta}</span> : null}
            {third ? <span className="block truncate text-[12px] leading-[18px] text-muted-foreground">{third}</span> : null}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-right">
            <span className={cn("block whitespace-nowrap text-[14px] leading-[21px] font-bold tabular-nums", kind === "failed" || kind === "cancelled" ? "text-muted-foreground line-through" : "text-foreground")} title={amount ? undefined : "Amount not found"}>
              {kind === "refund" && amount ? `+${amount}` : amount ?? "—"}
              {!amount ? <span className="sr-only">Amount not found</span> : null}
            </span>
            {status.text ? (
              <span className={cn("block text-[12px] leading-[18px]", status.tone === "bad" ? "text-[color:var(--app-destructive-deep)] dark:text-[color:var(--app-destructive-bright)]" : "text-muted-foreground")}>{status.text}</span>
            ) : null}
          </span>
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </span>
      </button>
    </li>
  );
}
