"use client";
import { isNetworkOnline } from "@/lib/runtime/network-status";
import { NativeMailLayer, useNativeMailPaneActive, type MailNativeSection } from "./native-mail-workspace";

import { withDeadline } from "@/lib/utils/with-deadline";
import mailStyles from "./mail-workspace.module.css";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { ReceiptScrollContinuity } from "./receipt-scroll-continuity";
import { ReceiptCollectionOverview, receiptCollectionOverview } from "./receipt-collection-overview";
import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { MailActionButton as Button } from "./mail-action-button";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
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
import { SectionHeader } from "@/components/app-ui/page-sections";
import { surfaceDataTableShellClassName } from "@/lib/morphy-ux/surfaces";
import {
  DEFAULT_FILTERS, TYPE_FILTERS, filterReceiptRows, loadFilterSelection, saveFilterSelection, type ReceiptFilterSelection,
} from "@/lib/mail/receipt-filters";
import type { ReceiptInsight } from "@/lib/mail/receipt-insights";
import { summarizeMonth } from "@/lib/mail/receipt-month-summary";
import { InsightCard, InsightReviewSheet, InsightsSheet, useCancellationConfirmation, useNoticeInsights } from "./receipts/receipt-insights-ui";
import { MonthHeader, ReceiptControls, ReceiptRowButton } from "./receipts/receipt-list-ui";
import { useReceiptTracking } from "./receipts/receipt-tracking-context";
import { pendingCancellations } from "@/lib/mail/receipt-tracking";
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
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { getVerifiedReceiptMerchant, resolveVerifiedReceiptMerchantBrand } from "@/lib/mail/receipt-merchant-registry";

const RECEIPT_LOGO_TIMEOUT_MS = 5000;

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
  return isNetworkOnline();
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
  const [loadedLogoUrl, setLoadedLogoUrl] = useState<string | null>(null);
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
  const requestLogo = online && Boolean(logoUrl) && failedLogoUrl !== logoUrl;
  const showFallback = !requestLogo || loadedLogoUrl !== logoUrl;
  // A reviewed brand fallback affects the icon only, never receipt grouping or labels.
  const fallbackCategory = category && category !== "Other" && category !== "Uncategorized"
    ? category : (logoDomain ? resolveVerifiedReceiptMerchantBrand({ merchantName, merchantDomain: logoDomain })?.categoryFallback : null) ?? category;
  const FallbackIcon = fallbackCategory ? CATEGORY_ICONS[fallbackCategory] : Receipt;

  useEffect(() => {
    if (!requestLogo || loadedLogoUrl === logoUrl) return;
    const timeout = window.setTimeout(() => setFailedLogoUrl(logoUrl), RECEIPT_LOGO_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [requestLogo, loadedLogoUrl, logoUrl]);

  return (
    <span
      aria-hidden="true"
      className="relative inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] text-muted-foreground shadow-[var(--shadow-xs)]"
      data-logo-kind={
        showFallback
          ? fallbackCategory && fallbackCategory !== "Other" && fallbackCategory !== "Uncategorized"
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
          className={`size-[18px] ${CATEGORY_COLORS[fallbackCategory || "Other"]}`}
          weight="regular"
        />
      ) : null}
      {requestLogo ? (
        // A repeated merchant uses an identical domain-only URL so the
        // browser/WebView and provider can reuse their normal HTTP caches.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          aria-hidden="true"
          className={cn("absolute inset-0 h-full w-full bg-white object-contain p-1.5", showFallback && "opacity-0")}
          decoding="async"
          loading="eager"
          onError={() => setFailedLogoUrl(logoUrl)}
          onLoad={() => setLoadedLogoUrl(logoUrl)}
          referrerPolicy="no-referrer"
          src={logoUrl!}
        />
      ) : null}
    </span>
  );
}

function ReceiptMerchantVisit({ homepageUrl }: { homepageUrl: string }) {
  const [openError, setOpenError] = useState(false);
  return (
    <div className="space-y-2">
      <Button
        className={`${mailStyles.wideAction} min-h-11 w-full`}
        data-voice-control-id="visit_receipt_merchant"
        type="button"
        variant="outline"
        onClick={() => {
          setOpenError(false);
          try {
            openExternalUrl(homepageUrl);
          } catch {
            setOpenError(true);
          }
        }}
      >
        Visit merchant
      </Button>
      {openError ? (
        <p className="text-xs text-muted-foreground" role="status">
          We couldn’t open the merchant website. Please try again.
        </p>
      ) : null}
    </div>
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
      : "Date unavailable";
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, { key, label, rows: [row] });
    }
  }

  return [...groups.values()];
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
  headingId,
  receipts,
  savedRows,
  sourceKeyAliases,
  loadReceiptDetail,
  onReceiptDetailLoaded,
  title = "Recent receipts",
  showOverview = false,
  nativePresentation = true,
  openRequest = null,
  showInsights = true,
}: {
  accountKey: string | null | undefined;
  /** Renders a section heading; the current receipts view shows its own header instead. */
  headingId?: string;
  title?: string;
  showOverview?: boolean;
  nativePresentation?: boolean;
  /** Opens one receipt's detail, for example from a recurring bill's evidence. */
  openRequest?: { key: string; nonce: number } | null;
  /** Earlier saved history belongs to another Mail account, so it never raises current insights. */
  showInsights?: boolean;
  receipts: readonly ReceiptListItem[];
  savedRows?: readonly RecentReceiptRow[];
  sourceKeyAliases?: Readonly<Record<string, string>>;
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
    live_unavailable?: string;
  }>;
  onReceiptDetailLoaded?: (item: ReceiptListItem) => void;
}) {
  const nativePaneActive = useNativeMailPaneActive("receipts");
  const nativeActive = nativePresentation && nativePaneActive;
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
  const [liveUnavailable, setLiveUnavailable] = useState<string | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const tracking = useReceiptTracking();
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<ReceiptFilterSelection>(DEFAULT_FILTERS);
  useEffect(() => setSelection(loadFilterSelection()), []);
  const [pageNavigation, setPageNavigation] = useState({ page: 1, revision: 0 });
  const displayPage = pageNavigation.page;
  const setDisplayPage = (page: number) => setPageNavigation(previous => ({ page, revision: previous.revision + 1 }));
  const mailRows = useMemo(
    () => savedRows ?? buildRecentReceiptRows(receipts, accountKey),
    [accountKey, receipts, savedRows],
  );
  const rows = mailRows;
  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedRowId || Boolean(selectedReceiptKey && row.sourceReceiptKeys.includes(sourceKeyAliases?.[selectedReceiptKey] ?? selectedReceiptKey))) || null,
    [rows, selectedRowId, selectedReceiptKey, sourceKeyAliases],
  );
  const filteredRows = useMemo(
    () => filterReceiptRows(rows, selection, search).sort((left, right) => receiptTimestamp(right) - receiptTimestamp(left)),
    [rows, search, selection],
  );
  const changeSelection = (next: ReceiptFilterSelection) => {
    setSelection(next);
    saveFilterSelection(next);
    setDisplayPage(1);
  };
  const { insights, caption: insightCaption, canRetry: insightCanRetry, retry: retryInsights } = useNoticeInsights(mailRows);
  useCancellationConfirmation(mailRows);
  const waiting = tracking?.doc ? pendingCancellations(tracking.doc) : [];
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [reviewing, setReviewing] = useState<ReceiptInsight | null>(null);
  const monthSummaries = useMemo(() => {
    const byMonth = new Map<string, RecentReceiptRow[]>();
    for (const row of filteredRows) {
      const at = row.receiptDate ? new Date(row.receiptDate) : null;
      const key = at && !Number.isNaN(at.getTime()) ? `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}` : "date-unavailable";
      byMonth.set(key, [...(byMonth.get(key) ?? []), row]);
    }
    return new Map([...byMonth].map(([key, monthRows]) => [key, summarizeMonth(monthRows)]));
  }, [filteredRows]);
  const openReceipt = useCallback((receiptKey: string) => {
    const row = rows.find((item) => item.sourceReceiptKeys.includes(sourceKeyAliases?.[receiptKey] ?? receiptKey));
    if (!row) return;
    selectedRowTriggerRef.current = null;
    setInsightsOpen(false);
    setReviewing(null);
    setSelectedRowId(row.id);
    setSelectedReceiptKey(sourceKeyAliases?.[receiptKey] ?? receiptKey);
  }, [rows, sourceKeyAliases]);
  useEffect(() => { if (openRequest) openReceipt(openRequest.key); }, [openRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / 10));
  const requestedPage = Math.min(displayPage, pageCount);
  const scope = `${search}\u0000${selection.date}:${selection.type}\u0000${requestedPage}\u0000${pageNavigation.revision}`;
  const [windowState, setWindowState] = useState({ rows: filteredRows, scope, first: filteredRows[0]?.id, start: 0 });
  let start = windowState.start;
  if (windowState.rows !== filteredRows || windowState.scope !== scope) {
    const root = typeof document === "undefined" ? null : document.querySelector('[data-app-scroll-root="true"]') ?? document.scrollingElement;
    const priorPosition = windowState.first ? filteredRows.findIndex(row => row.id === windowState.first) : -1;
    start = windowState.scope === scope && root && root.scrollTop > 0 && priorPosition >= 0 ? priorPosition : (requestedPage - 1) * 10;
    setWindowState({ rows: filteredRows, scope, first: filteredRows[start]?.id, start });
  }
  const currentPage = Math.floor(start / 10) + 1;
  const visibleRows = filteredRows.slice(start, start + 10);

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
  const selectedReceiptAvailable = Boolean(selectedListReceipt || (savedRows && selectedRow?.sourceReceiptKeys.includes(selectedReceiptKey ?? "")));

  useEffect(() => {
    if (selectedRow && selectedReceiptKey && !selectedRow.sourceReceiptKeys.includes(selectedReceiptKey))
      setSelectedReceiptKey(sourceKeyAliases?.[selectedReceiptKey] && selectedRow.sourceReceiptKeys.includes(sourceKeyAliases[selectedReceiptKey]!) ? sourceKeyAliases[selectedReceiptKey]! : selectedRow.primaryReceiptKey);
  }, [selectedRow, selectedReceiptKey, sourceKeyAliases]);

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
      setLiveUnavailable(null);
      return;
    }

    const controller = new AbortController();
    setReceiptDetail(null);
    setEmailExcerpt(null);
    setSourceEvidence([]);
    setDetailError(null);
    setLiveUnavailable(null);
    setDetailLoading(true);
    void withDeadline(loadReceiptDetail(selectedReceiptKey, controller.signal), Date.now() + 30_000)
      .then((detail) => {
        if (controller.signal.aborted) return;
        setReceiptDetail(detail.item);
        setLiveUnavailable(detail.live_unavailable ?? null);
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
  // A saved detail has no live sender/domain evidence. Keep its reviewed key
  // authoritative instead of promoting a formerly rejected label-only match.
  const detailBrand = liveUnavailable && savedRows
    ? getVerifiedReceiptMerchant(selectedRow?.brandKey)
    : detailIdentity;
  const sender = receiptDetail
    ? [receiptDetail.from_name, receiptDetail.from_email]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(" · ")
    : "";

  const fallback = (
    <ReceiptScrollContinuity scope={scope}>
      {showOverview ? <ReceiptCollectionOverview rows={rows} /> : null}
      {headingId ? <SectionHeader id={headingId} title={title} /> : null}
      {showInsights && (insights[0] || waiting.length) ? (
        <InsightCard
          insight={insights[0] ?? null}
          total={insights.length}
          onSeeAll={() => setInsightsOpen(true)}
          onReview={setReviewing}
          caption={insightCaption}
          onTryAgain={insightCanRetry ? retryInsights : null}
          waitingNote={!insights.length && waiting.length ? {
            title: `${waiting.length} cancellation${waiting.length === 1 ? "" : "s"} waiting for the provider`,
            detail: "Savings count only after each provider confirms the change.",
          } : null}
        />
      ) : null}
      <ReceiptControls search={search} onSearch={(value) => { setSearch(value); setDisplayPage(1); }} selection={selection} onSelection={changeSelection} />
      <div
        aria-label={`${TYPE_FILTERS.find((option) => option.value === selection.type)?.label || "All types"} receipts`}
        className="space-y-4"
        role="tabpanel"
        id="receipts-panel-all"
        aria-labelledby="receipts-view-all"
      >
        {visibleGroups.length ? (
          visibleGroups.map((group, groupIndex) => {
            const headingId = `receipt-month-${currentPage}-${groupIndex}`;
            return (
              <section
                aria-labelledby={headingId}
                className="overflow-hidden rounded-[20px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--shadow-xs)]"
                data-testid="receipt-month-group"
                key={group.key}
              >
                <MonthHeader headingId={headingId} label={group.label} summary={monthSummaries.get(group.key) ?? summarizeMonth(group.rows)} />
                <ul className="w-full min-w-0 max-w-full border-t border-border/60">
                  {group.rows.map((row) => (
                    <ReceiptRowButton
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
            {rows.length ? "No receipts match this view." : "No saved receipts yet. New receipts will appear after the next update."}
          </div>
        )}
      </div>
      {pageCount > 1 ? (
        <nav
          aria-label="Receipt pagination"
          className="flex items-center justify-between gap-3 pt-3 text-sm"
        >
          <MorphyButton
            variant="none" effect="fade"
            size="compact" className={mailStyles.utilityAction}
            disabled={currentPage === 1}
            onClick={() => setDisplayPage(currentPage - 1)}
          >
            Previous
          </MorphyButton>
          <span aria-live="polite">{currentPage} / {pageCount}</span>
          <MorphyButton
            variant="none" effect="fade"
            size="compact" className={mailStyles.utilityAction}
            disabled={currentPage === pageCount}
            onClick={() => setDisplayPage(currentPage + 1)}
          >
            Next
          </MorphyButton>
        </nav>
      ) : null}

      <AdaptiveDetailSurface
        surfaceClassName={`${mailStyles.typography} ${mailStyles.portal} ${mailStyles.detailPortal}`}
        open={Boolean(selectedRow && selectedReceiptAvailable)}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
        leading={
          selectedRow ? (
            <ReceiptMerchantLogo
              merchantName={detailIdentity?.displayName || selectedRow.merchantName}
              logoDomain={detailIdentity ? detailBrand?.logoDomain ?? null : selectedRow.logoDomain}
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
        {liveUnavailable ? <p className="text-sm text-muted-foreground" role="status">{liveUnavailable}</p> : null}
        {detailLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading receipt details…
          </p>
        ) : null}
        {detailError ? (
          <div className="space-y-3 text-sm">
            <p className="text-destructive">{detailError}</p>
            <Button
              onClick={() => setDetailAttempt((attempt) => attempt + 1)}
              type="button"
            >
              Try again
            </Button>
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
                <p className={`${mailStyles.sourceGroup} text-muted-foreground`}>
                  Activity
                </p>
                <ol className="divide-y divide-border/60">
                  {selectedRow.eventTimeline.map((event) => (
                    <li
                      className="space-y-0.5 py-2.5 first:pt-0 last:pb-0"
                      key={event.sourceReceiptKey}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className={`${mailStyles.rowName} text-foreground`}>
                          {receiptTimelineLabel(event)}{event.sourceUnavailable ? " · Source unavailable" : ""}
                        </span>
                        <span className={`${mailStyles.support} shrink-0 text-muted-foreground`}>
                          {formatReceiptDate(event.date)}
                        </span>
                      </div>
                      {event.detail || event.subject ? (
                        <p className={`${mailStyles.support} line-clamp-2 break-words text-muted-foreground`}>
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
                <p className={`${mailStyles.sourceGroup} text-muted-foreground`}>
                  {emailExcerpt.label}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                  {formatReceiptPassage(emailExcerpt.text)}
                </p>
              </div>
            ) : null}

            {sourceEvidence.length ? (
              <div className="space-y-2 rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-4 py-3">
                <p className={`${mailStyles.sourceGroup} text-muted-foreground`}>
                  Source evidence
                </p>
                <ul className="space-y-2">
                  {sourceEvidence.map((evidence, index) => (
                    <li
                      className="text-sm leading-5 text-foreground"
                      key={`${evidence.kind}:${index}`}
                    >
                      <span className="font-normal capitalize">
                        {evidence.kind.replace("_", " ")}
                      </span>
                      <span className="text-muted-foreground"> · </span>
                      {formatReceiptPassage(evidence.text)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {detailBrand?.homepageUrl ? (
              <ReceiptMerchantVisit key={detailBrand.homepageUrl} homepageUrl={detailBrand.homepageUrl} />
            ) : null}
          </div>
        ) : null}
      </AdaptiveDetailSurface>
      <InsightsSheet
        open={insightsOpen}
        onOpenChange={setInsightsOpen}
        insights={insights}
        caption={insightCaption}
        onTryAgain={insightCanRetry ? retryInsights : null}
        onReview={(insight) => { setInsightsOpen(false); setReviewing(insight); }}
      />
      <InsightReviewSheet insight={reviewing} onClose={() => setReviewing(null)} rows={mailRows} onOpenReceipt={openReceipt} />
    </ReceiptScrollContinuity>
  );
  if (!nativeActive) return fallback;
  const overview = receiptCollectionOverview(rows);
  const nativeSections: MailNativeSection[] = [
    ...(showOverview ? [
      { key: "receipt-overview", title: "Overview", rows: [
        { key: "saved-count", label: "Saved receipts", detail: String(overview.active.length) },
        { key: "paid-count", label: "Paid", detail: String(overview.summary.paid) },
        { key: "attention-count", label: "Needs attention", detail: String(overview.summary.attention) },
        { key: "upcoming-count", label: "Coming up", detail: String(overview.summary.upcoming) },
        { key: "sample", label: "From your saved Mail sample." },
        ...(rows.length !== overview.active.length ? [{ key: "archive-counts", label: "Previously saved receipts remain below; unresolved archive entries are excluded from these counts." }] : []),
      ] },
      { key: "receipt-categories", title: "Categories", rows: overview.ranked.length ? overview.ranked.map(([category, count]) => ({
        key: "category:" + category, label: category, detail: String(count) + " · " + String(Math.round(count / overview.active.length * 100)) + "%",
      })) : [{ key: "categories-empty", label: "Categories appear as receipts arrive." }] },
    ] : []),
    { key: "receipt-filters", title: "Receipt types", rows: TYPE_FILTERS.map(option => ({
      key: "filter:" + option.value, label: option.label, selected: selection.type === option.value,
      run: () => changeSelection({ ...selection, type: option.value }),
    })) },
    ...visibleGroups.map(group => ({ key: "month:" + group.key, title: group.label, rows: group.rows.map(row => ({
      key: "receipt:" + row.id, label: row.merchantName,
      detail: [formatReceiptAmount(row.currency, row.amount), row.archived ? "Previously saved · reconciliation needed" : row.sourceUnavailable ? "Source unavailable · " + receiptSecondaryLabel(row) : receiptSecondaryLabel(row)].filter(Boolean).join(" · "),
      web: true, run: () => { selectedRowTriggerRef.current = null; setSelectedRowId(row.id); setSelectedReceiptKey(row.primaryReceiptKey); },
    })) })),
    ...(!visibleGroups.length ? [{ key: "receipt-empty", rows: [{ key: "empty", label: rows.length ? "No receipts match this view." : "No saved receipts yet. New receipts will appear after the next update." }] }] : []),
    ...(pageCount > 1 ? [{ key: "receipt-pagination", rows: [
      { key: "page", label: String(currentPage) + " / " + String(pageCount) },
      { key: "previous", label: "Previous", enabled: currentPage > 1, run: () => setDisplayPage(currentPage - 1) },
      { key: "next", label: "Next", enabled: currentPage < pageCount, run: () => setDisplayPage(currentPage + 1) },
    ] }] : []),
  ];
  return <NativeMailLayer active={nativeActive} title={title} includeRoot sections={nativeSections}
    search={{ query: search, label: "Search receipts", change: query => { setSearch(query); setDisplayPage(1); } }}
    webChild={Boolean(selectedRow && selectedReceiptAvailable)} fallback={fallback} />;
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
    <div className="grid grid-cols-[minmax(0,0.36fr)_minmax(0,0.64fr)] gap-3 py-3">
      <dt className={`${mailStyles.support} text-muted-foreground`}>{label}</dt>
      <dd className={`${mailStyles.rowName} break-words text-right text-foreground`}>
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
