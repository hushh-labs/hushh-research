"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Receipt,
  ShoppingBag,
  ForkKnife,
  AirplaneTilt,
  Car,
  CreditCard,
  FileText,
  Cloud,
} from "@/components/icons";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { surfaceDataTableShellClassName } from "@/lib/morphy-ux/surfaces";
import {
  buildReceiptLogoUrl,
  buildRecentReceiptRows,
  formatReceiptAmount,
  receiptSelectionKey,
  receiptStatusLabel,
  receiptAttentionLabel,
  receiptDocumentLabel,
  receiptIdentifierLabel,
  resolveReceiptMerchant,
  formatReceiptPassage,
  type RecentReceiptRow,
  type ReceiptTimelineEvent,
} from "@/lib/profile/gmail-receipt-presentation";
import type {
  ReceiptCategory,
  GmailReceiptSourceEvidence,
  ReceiptListItem,
} from "@/lib/services/gmail-receipts-service";
import { cn } from "@/lib/utils";

const CATEGORY_ICONS = {
  Shopping: ShoppingBag,
  Food: ForkKnife,
  Travel: AirplaneTilt,
  Transport: Car,
  "Software & Subscriptions": CreditCard,
  "Cloud & Infra": Cloud,
  Subscription: CreditCard,
  Bills: FileText,
  Uncategorized: Receipt,
  Other: Receipt,
};

const CATEGORY_COLORS = {
  Shopping: "text-blue-500",
  Food: "text-emerald-500",
  Travel: "text-indigo-500",
  Transport: "text-cyan-600",
  "Software & Subscriptions": "text-violet-500",
  "Cloud & Infra": "text-sky-600",
  Subscription: "text-violet-500",
  Bills: "text-amber-600",
  Uncategorized: "text-slate-500",
  Other: "text-slate-500",
};

function subscribeToConnectivity(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function getConnectivitySnapshot(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function ReceiptMerchantLogo({
  merchantName,
  logoDomain,
  providerUrlTemplate,
  category = null,
}: {
  merchantName: string;
  logoDomain: string | null;
  providerUrlTemplate?: string | null;
  category?: ReceiptCategory | null;
}) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const online = useSyncExternalStore(
    subscribeToConnectivity,
    getConnectivitySnapshot,
    () => true,
  );
  const configuredTemplate =
    providerUrlTemplate === undefined
      ? process.env.NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE
      : providerUrlTemplate;
  const logoUrl = buildReceiptLogoUrl(configuredTemplate, logoDomain);
  const showFallback = !online || !logoUrl || failedLogoUrl === logoUrl;
  const FallbackIcon = category ? CATEGORY_ICONS[category] : Receipt;

  return (
    <span
      aria-hidden="true"
      className="inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] text-muted-foreground shadow-[var(--shadow-xs)]"
      data-logo-kind={
        showFallback
          ? category && category !== "Other" && category !== "Uncategorized"
            ? "category"
            : "fallback"
          : "brand"
      }
      data-receipt-category={category || undefined}
      data-slot="receipt-merchant-logo"
      title={showFallback ? undefined : merchantName}
    >
      {showFallback ? (
        <FallbackIcon
          className={`size-[18px] ${CATEGORY_COLORS[category || "Other"]}`}
          weight="duotone"
        />
      ) : (
        // A repeated merchant uses an identical domain-only URL so the
        // browser/WebView and provider can reuse their normal HTTP caches.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          aria-hidden="true"
          className="h-full w-full bg-white object-contain p-1.5"
          crossOrigin="anonymous"
          decoding="async"
          loading="lazy"
          onError={() => setFailedLogoUrl(logoUrl)}
          referrerPolicy="no-referrer"
          src={logoUrl}
        />
      )}
    </span>
  );
}

type ReceiptFilter =
  | "all"
  | "paid"
  | "due"
  | "overdue"
  | "upcoming"
  | "cancelled";

const RECEIPT_FILTER_OPTIONS: Array<{
  label: string;
  value: ReceiptFilter;
}> = [
  { label: "All", value: "all" },
  { label: "Paid", value: "paid" },
  { label: "Due", value: "due" },
  { label: "Overdue", value: "overdue" },
  { label: "Upcoming", value: "upcoming" },
  { label: "Cancelled", value: "cancelled" },
];

const RECEIPT_STATUS_TONE_CLASSES = {
  success:
    "border-[color:var(--app-success-border)] bg-[color:var(--app-success-tint)] text-[color:var(--app-success-deep)] dark:text-[color:var(--app-success-bright)]",
  warning:
    "border-[color:var(--app-warning-border)] bg-[color:var(--app-warning-tint)] text-[color:var(--app-warning-deep)] dark:text-[color:var(--app-warning-bright)]",
  destructive:
    "border-[color:var(--app-destructive-border)] bg-[color:var(--app-destructive-tint)] text-[color:var(--app-destructive-deep)] dark:text-[color:var(--app-destructive-bright)]",
  upcoming:
    "border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]",
  neutral: "border-border/70 bg-muted/70 text-muted-foreground",
} as const;

const RECEIPT_STATUS_DOT_CLASSES = {
  success: "bg-[color:var(--app-success)]",
  warning: "bg-[color:var(--app-warning)]",
  destructive: "bg-[color:var(--app-destructive)]",
  upcoming: "bg-[color:var(--app-accent)]",
  neutral: "bg-muted-foreground",
} as const;

type ReceiptStatusTone = keyof typeof RECEIPT_STATUS_TONE_CLASSES;

function receiptStatusTone(row: RecentReceiptRow): ReceiptStatusTone {
  switch (row.status) {
    case "paid":
    case "delivered":
      return "success";
    case "overdue":
    case "payment_failed":
    case "suspended":
    case "cancelled":
      return "destructive";
    case "trial":
    case "renewal_due":
      return "upcoming";
    case "refunded":
      return "neutral";
    default:
      return "neutral";
  }
}

function ReceiptStatusBadge({ row }: { row: RecentReceiptRow }) {
  const label = receiptStatusLabel(row.status);
  if (!label) return null;
  const tone = receiptStatusTone(row);

  return (
    <Badge
      className={cn(
        "h-5 gap-1 px-1.5 py-0 text-[11px] font-semibold",
        RECEIPT_STATUS_TONE_CLASSES[tone],
      )}
      data-receipt-status={row.status || undefined}
      variant="outline"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          RECEIPT_STATUS_DOT_CLASSES[tone],
        )}
      />
      {label}
    </Badge>
  );
}

function receiptTimestamp(row: RecentReceiptRow): number {
  const timestamp = row.receiptDate ? new Date(row.receiptDate).getTime() : NaN;
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function formatReceiptRowDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(date);
}

function receiptSecondaryLabel(row: RecentReceiptRow): string | null {
  const category = row.displayKind === "merchant" ? row.secondaryDetail : null;
  const date = formatReceiptRowDate(row.receiptDate);
  return [category, date].filter(Boolean).join(" · ") || null;
}

function matchesReceiptFilter(
  row: RecentReceiptRow,
  filter: ReceiptFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "paid":
      return row.status === "paid";
    case "due":
      // The current backend contract has no general payment-due lifecycle.
      // Do not reinterpret renewal_due, attention, or a missing amount as Due.
      return false;
    case "overdue":
      return row.status === "overdue";
    case "upcoming":
      return row.status === "renewal_due" || row.status === "trial";
    case "cancelled":
      return row.status === "cancelled" || row.status === "refunded";
  }
}

type ReceiptMonthGroup = {
  key: string;
  label: string;
  rows: RecentReceiptRow[];
};

function groupReceiptRowsByMonth(
  rows: readonly RecentReceiptRow[],
): ReceiptMonthGroup[] {
  const groups = new Map<string, ReceiptMonthGroup>();

  for (const row of rows) {
    const date = row.receiptDate ? new Date(row.receiptDate) : null;
    const validDate = date && !Number.isNaN(date.getTime()) ? date : null;
    const key = validDate
      ? `${validDate.getFullYear()}-${String(validDate.getMonth() + 1).padStart(2, "0")}`
      : "date-unavailable";
    const label = validDate
      ? new Intl.DateTimeFormat(undefined, {
          month: "long",
          year: "numeric",
        })
          .format(validDate)
          .toUpperCase()
      : "DATE UNAVAILABLE";
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, { key, label, rows: [row] });
    }
  }

  return [...groups.values()];
}

function ReceiptListRow({
  row,
  onSelect,
}: {
  row: RecentReceiptRow;
  onSelect: (row: RecentReceiptRow, trigger: HTMLButtonElement) => void;
}) {
  const amount = formatReceiptAmount(row.currency, row.amount);
  const secondary = receiptSecondaryLabel(row);

  return (
    <li className="border-b border-border/60 last:border-b-0">
      <button
        className="grid min-h-[58px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 bg-[color:var(--app-card-surface-default-solid)] px-[max(10px,calc(var(--data-table-cell-px)-2px))] py-2.5 text-left transition-[background-color] duration-150 ease-out hover:bg-foreground/[0.045] active:bg-foreground/[0.065] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)]"
        data-receipt-row-id={row.id}
        data-testid="receipt-row"
        onClick={(event) => onSelect(row, event.currentTarget)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <ReceiptMerchantLogo
            merchantName={row.merchantName}
            logoDomain={row.logoDomain}
            category={row.category}
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                {row.merchantName}
              </span>
              <ReceiptStatusBadge row={row} />
            </span>
            {secondary ? (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {secondary}
              </span>
            ) : null}
          </span>
        </span>
        <span
          className="block shrink-0 whitespace-nowrap text-right text-sm font-semibold tabular-nums text-foreground"
          title={amount === "—" ? "Amount not found" : undefined}
        >
          {amount}
        </span>
      </button>
    </li>
  );
}

function receiptTimelineLabel(event: ReceiptTimelineEvent): string {
  return receiptStatusLabel(event.status) ||
    receiptDocumentLabel(event.documentKind) ||
    {
      purchase: "Purchase update",
      fulfillment: "Fulfilment update",
      refund: "Refund",
      cancellation: "Cancellation",
      unknown: "Receipt update",
    }[event.eventKind];
}

export function GmailRecentReceipts({
  accountKey,
  receipts,
  loadReceiptDetail,
  onReceiptDetailLoaded,
}: {
  accountKey: string | null | undefined;
  receipts: readonly ReceiptListItem[];
  loadReceiptDetail: (
    sourceId: string,
    signal: AbortSignal,
  ) => Promise<{
    item: ReceiptListItem;
    email_excerpt?: {
      kind?: string;
      label: string;
      text: string;
      truncated?: boolean;
    } | null;
    source_evidence?: GmailReceiptSourceEvidence[];
  }>;
  onReceiptDetailLoaded?: (item: ReceiptListItem) => void;
}) {
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [selectedReceiptKey, setSelectedReceiptKey] = useState<string | null>(
    null,
  );
  const selectedRowTriggerRef = useRef<HTMLElement | null>(null);
  const [receiptDetail, setReceiptDetail] = useState<ReceiptListItem | null>(
    null,
  );
  const [emailExcerpt, setEmailExcerpt] = useState<{
    label: string;
    text: string;
  } | null>(null);
  const [sourceEvidence, setSourceEvidence] = useState<
    GmailReceiptSourceEvidence[]
  >([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<ReceiptFilter>("all");
  const [displayPage, setDisplayPage] = useState(1);
  const rows = useMemo(
    () => buildRecentReceiptRows(receipts, accountKey),
    [accountKey, receipts],
  );
  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedRowId || Boolean(selectedReceiptKey && row.sourceReceiptKeys.includes(selectedReceiptKey))) || null,
    [rows, selectedRowId, selectedReceiptKey],
  );
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows
      .filter(
        (row) =>
          matchesReceiptFilter(row, activeFilter) &&
          (!query || row.searchText.toLowerCase().includes(query)),
      )
      .sort((left, right) => receiptTimestamp(right) - receiptTimestamp(left));
  }, [activeFilter, rows, search]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / 10));
  const currentPage = Math.min(displayPage, pageCount);
  const visibleRows = filteredRows.slice(
    (currentPage - 1) * 10,
    currentPage * 10,
  );
  const visibleGroups = useMemo(
    () => groupReceiptRowsByMonth(visibleRows),
    [visibleRows],
  );
  const selectedListReceipt = useMemo(
    () =>
      receipts.find(
        (receipt) => receiptSelectionKey(receipt) === selectedReceiptKey,
      ) || null,
    [receipts, selectedReceiptKey],
  );
  const selectedReceiptAvailable = Boolean(selectedListReceipt);

  useEffect(() => {
    if (displayPage > pageCount) setDisplayPage(pageCount);
  }, [displayPage, pageCount]);

  useEffect(() => {
    if (!selectedReceiptKey || !selectedReceiptAvailable) {
      setReceiptDetail(null);
      setEmailExcerpt(null);
      setSourceEvidence([]);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }

    const controller = new AbortController();
    setReceiptDetail(null);
    setEmailExcerpt(null);
    setSourceEvidence([]);
    setDetailError(null);
    setDetailLoading(true);
    void loadReceiptDetail(selectedReceiptKey, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        setReceiptDetail(detail.item);
        onReceiptDetailLoaded?.(detail.item);
        const excerpt = detail.email_excerpt;
        setSourceEvidence(detail.source_evidence || []);
        // Only email provenance may be labelled Email preview. A useful detail
        // can come from an attached invoice and remains in the structured rows.
        const availablePassage = detail.item.cleaned_preview;
        setEmailExcerpt(
          excerpt?.text?.trim()
            ? {
                label: excerpt.label || "Email preview",
                text: excerpt.text,
              }
            : availablePassage
              ? { label: "Email preview", text: availablePassage }
              : null,
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setDetailError(
          error instanceof Error && error.message.trim()
            ? error.message
            : "We couldn't load this receipt right now.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });

    return () => controller.abort();
  }, [
    detailAttempt,
    loadReceiptDetail,
    onReceiptDetailLoaded,
    selectedReceiptAvailable,
    selectedReceiptKey,
  ]);

  const closeDetail = useCallback(() => {
    setSelectedRowId(null);
    setSelectedReceiptKey(null);
    setReceiptDetail(null);
    setEmailExcerpt(null);
    setSourceEvidence([]);
    setDetailError(null);
    window.requestAnimationFrame(() => {
      selectedRowTriggerRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const receiptDate = receiptDetail
    ? formatReceiptDate(
        receiptDetail.receipt_date ||
          receiptDetail.gmail_internal_date ||
          receiptDetail.created_at,
      )
    : null;
  const detailIdentity = receiptDetail ? resolveReceiptMerchant(receiptDetail) : null;
  const sender = receiptDetail
    ? [receiptDetail.from_name, receiptDetail.from_email]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(" · ")
    : "";

  return (
    <>
      <Input
        type="search"
        aria-label="Search table"
        placeholder="Search receipts"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setDisplayPage(1);
        }}
      />
      <SegmentedTabs
        ariaLabel="Receipt status filters"
        className="pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onValueChange={(value) => {
          setActiveFilter(value as ReceiptFilter);
          setDisplayPage(1);
        }}
        options={RECEIPT_FILTER_OPTIONS}
        value={activeFilter}
        variant="filter"
      />
      <div
        aria-label={`${RECEIPT_FILTER_OPTIONS.find((option) => option.value === activeFilter)?.label || "All"} receipts`}
        className="space-y-5"
        role="tabpanel"
      >
        {visibleGroups.length ? (
          visibleGroups.map((group, groupIndex) => {
            const headingId = `receipt-month-${currentPage}-${groupIndex}`;
            return (
              <section
                aria-labelledby={headingId}
                className="space-y-2"
                data-testid="receipt-month-group"
                key={group.key}
              >
                <h3
                  className="px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                  id={headingId}
                >
                  {group.label}
                </h3>
                <ul
                  className={cn(
                    surfaceDataTableShellClassName,
                    "w-full min-w-0 max-w-full overflow-hidden",
                  )}
                >
                  {group.rows.map((row) => (
                    <ReceiptListRow
                      key={row.id}
                      onSelect={(selected, trigger) => {
                        selectedRowTriggerRef.current = trigger;
                        setSelectedRowId(selected.id);
                        setSelectedReceiptKey(selected.primaryReceiptKey);
                      }}
                      row={row}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        ) : (
          <div
            className={cn(
              surfaceDataTableShellClassName,
              "px-4 py-8 text-center text-sm text-muted-foreground",
            )}
            role="status"
          >
            No receipts match this view.
          </div>
        )}
      </div>
      {pageCount > 1 ? (
        <nav
          aria-label="Receipt pagination"
          className="flex items-center justify-between gap-3 pt-3 text-sm"
        >
          <Button
            variant="ghost"
            disabled={currentPage === 1}
            onClick={() => setDisplayPage(currentPage - 1)}
          >
            Previous
          </Button>
          <span aria-live="polite">
            {currentPage} / {pageCount}
          </span>
          <Button
            variant="ghost"
            disabled={currentPage === pageCount}
            onClick={() => setDisplayPage(currentPage + 1)}
          >
            Next
          </Button>
        </nav>
      ) : null}

      <AdaptiveDetailSurface
        open={Boolean(selectedRow && selectedListReceipt)}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
        leading={
          selectedRow ? (
            <ReceiptMerchantLogo
              merchantName={detailIdentity?.displayName || selectedRow.merchantName}
              logoDomain={detailIdentity ? detailIdentity.logoDomain : selectedRow.logoDomain}
              category={detailIdentity?.category || selectedRow.category}
            />
          ) : null
        }
        eyebrow="Receipt details"
        title={detailIdentity?.displayName || selectedRow?.merchantName || "Receipt"}
        description={
          receiptDetail
            ? formatReceiptAmount(
                receiptDetail.currency,
                receiptDetail.amount,
              ).replace("—", "Not available")
            : undefined
        }
        mobilePresentation="sheet"
        desktopMaxWidthClassName="sm:!max-w-[520px]"
        bodyClassName="py-3"
      >
        {detailLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading receipt details…
          </p>
        ) : null}
        {detailError ? (
          <div className="space-y-3 text-sm">
            <p className="text-destructive">{detailError}</p>
            <button
              className="font-medium text-primary"
              onClick={() => setDetailAttempt((attempt) => attempt + 1)}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : null}
        {receiptDetail && !detailLoading ? (
          <div className="space-y-4" data-testid="receipt-detail">
            <dl className="divide-y divide-border/60 rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-4">
              <ReceiptDetailRow
                label="Amount"
                value={formatReceiptAmount(
                  receiptDetail.currency,
                  receiptDetail.amount,
                ).replace("—", "Not available")}
              />
              <ReceiptDetailRow
                label="Status"
                value={receiptStatusLabel(selectedRow?.status || receiptDetail.status)}
              />
              <ReceiptDetailRow
                label="Attention"
                value={receiptAttentionLabel(
                  selectedRow?.attentionState || receiptDetail.attention_state,
                  selectedRow?.attentionReason || receiptDetail.attention_reason,
                  selectedRow?.attentionIsPrediction || receiptDetail.attention_is_prediction,
                )}
              />
              <ReceiptDetailRow
                label="Category"
                value={
                  receiptDetail.category === "Other"
                    ? "Uncategorized"
                    : receiptDetail.category
                }
              />
              <ReceiptDetailRow
                label="Document"
                value={receiptDocumentLabel(selectedRow?.documentKind || receiptDetail.document_kind)}
              />
              <ReceiptDetailRow
                label="Recurrence"
                value={
                  (selectedRow?.recurrence || receiptDetail.recurrence) === "recurring"
                    ? "Recurring"
                    : (selectedRow?.recurrence || receiptDetail.recurrence) === "one_time"
                      ? "One-time"
                      : null
                }
              />
              {(selectedRow?.identifiers.length ? selectedRow.identifiers : receiptDetail.identifiers || []).map((identifier) => (
                <ReceiptDetailRow key={`${identifier.kind}:${identifier.value}`} label={identifier.kind === "payment" ? "Payment reference" : receiptIdentifierLabel(identifier.kind)} value={identifier.value} />
              ))}
              {!selectedRow?.identifiers.length && !receiptDetail.identifiers?.length ? (
                <ReceiptDetailRow label={receiptIdentifierLabel(receiptDetail.identifier_kind)} value={receiptDetail.identifier_value || receiptDetail.order_id} />
              ) : null}
              <ReceiptDetailRow label="Details" value={receiptDetail.short_detail === emailExcerpt?.text ? null : receiptDetail.short_detail} />
              <ReceiptDetailRow label="Date" value={receiptDetail.transaction_date === undefined ? receiptDate : receiptDetail.transaction_date} />
              <ReceiptDetailRow label="Due / renewal" value={selectedRow?.attentionDate || receiptDetail.attention_date} />
              <ReceiptDetailRow label="Received" value={formatReceiptDate(receiptDetail.gmail_internal_date || receiptDetail.created_at)} />
              <ReceiptDetailRow
                label="Confidence"
                value={
                  typeof receiptDetail.classification_confidence === "number"
                    ? `${Math.round(receiptDetail.classification_confidence * 100)}%`
                    : null
                }
              />
              <ReceiptDetailRow label="Sender" value={sender} />
              <ReceiptDetailRow label="Subject" value={receiptDetail.subject} />
            </dl>

            {selectedRow && selectedRow.eventTimeline.length > 1 ? (
              <div className="space-y-2 rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Activity
                </p>
                <ol className="divide-y divide-border/60">
                  {selectedRow.eventTimeline.map((event) => (
                    <li
                      className="space-y-0.5 py-2.5 first:pt-0 last:pb-0"
                      key={event.sourceReceiptKey}
                    >
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="font-medium text-foreground">
                          {receiptTimelineLabel(event)}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatReceiptDate(event.date)}
                        </span>
                      </div>
                      {event.detail || event.subject ? (
                        <p className="line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
                          {formatReceiptPassage(event.detail || event.subject || "")}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            {emailExcerpt ? (
              <div className="space-y-1.5 rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {emailExcerpt.label}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                  {formatReceiptPassage(emailExcerpt.text)}
                </p>
              </div>
            ) : null}

            {sourceEvidence.length ? (
              <div className="space-y-2 rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Source evidence
                </p>
                <ul className="space-y-2">
                  {sourceEvidence.map((evidence, index) => (
                    <li
                      className="text-sm leading-5 text-foreground"
                      key={`${evidence.kind}:${index}`}
                    >
                      <span className="font-medium capitalize">
                        {evidence.kind.replace("_", " ")}
                      </span>
                      <span className="text-muted-foreground"> · </span>
                      {formatReceiptPassage(evidence.text)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </AdaptiveDetailSurface>
    </>
  );
}

function ReceiptDetailRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return null;

  return (
    <div className="grid grid-cols-[minmax(0,0.36fr)_minmax(0,0.64fr)] gap-3 py-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words text-right font-medium text-foreground">
        {normalizedValue}
      </dd>
    </div>
  );
}

function formatReceiptDate(value: string | null | undefined): string | null {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return null;
  const date = new Date(normalizedValue);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
