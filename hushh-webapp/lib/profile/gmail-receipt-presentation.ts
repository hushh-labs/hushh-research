import type {
  ReceiptCategory,
  ReceiptAttentionReason,
  ReceiptAttentionState,
  ReceiptLifecycleStatus,
  ReceiptRecurrence,
  ReceiptListItem,
} from "@/lib/services/gmail-receipts-service";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import {
  isVerifiedReceiptLogoDomain,
  normalizeReceiptSenderDomain,
  resolveVerifiedReceiptMerchant,
} from "@/lib/mail/receipt-merchant-registry";

export { extractReceiptSenderDomain } from "@/lib/mail/receipt-merchant-registry";

export const UNKNOWN_RECEIPT_MERCHANT = "Receipt";
export const UNAVAILABLE_RECEIPT_AMOUNT = "—";

export type ResolvedReceiptMerchant = {
  merchantId: string | null;
  displayName: string;
  logoDomain: string | null;
  category: ReceiptCategory | null;
  displayKind: "merchant" | "category" | "generic";
};

export type RecentReceiptRow = {
  id: string;
  primaryReceiptId: number;
  primaryReceiptKey: string;
  merchantName: string;
  category: ReceiptCategory | null;
  displayKind: "merchant" | "category" | "generic";
  logoDomain: string | null;
  amount: number | null;
  currency: string | null;
  searchText: string;
  secondaryText: string;
  secondaryDetail: string | null;
  secondaryMeta: string;
  sourceReceiptIds: readonly number[];
  sourceReceiptKeys: readonly string[];
  identifiers: NonNullable<ReceiptListItem["identifiers"]>;
  status: ReceiptLifecycleStatus | null;
  recurrence: ReceiptRecurrence;
  attentionState: ReceiptAttentionState;
  attentionReason: ReceiptAttentionReason | null;
  attentionIsPrediction: boolean;
  attentionDate: string | null;
  documentKind: ReceiptListItem["document_kind"];
  receiptDate: string | null;
  confidence: number | null;
  eventTimeline: readonly ReceiptTimelineEvent[];
};

export type ReceiptTimelineEvent = {
  sourceReceiptKey: string;
  documentKind: ReceiptListItem["document_kind"];
  eventKind: ReceiptEventKind;
  status: ReceiptLifecycleStatus | null;
  attentionState: ReceiptAttentionState;
  date: string | null;
  merchantName: string;
  subject: string | null;
  detail: string | null;
};

export type ReceiptSummary = {
  paid: number;
  attention: number;
  upcoming: number;
  missingAmount: number;
  hasData: boolean;
};

type ReceiptEventKind =
  "purchase" | "fulfillment" | "refund" | "cancellation" | "unknown";

/** Remove emphasis delimiters from plain-text backend quotes, not their facts. */
export function formatReceiptPassage(value: string): string {
  return value.replace(/\*\*([^*]+)\*\*/g, "$1");
}

export function receiptStatusLabel(
  status: ReceiptListItem["status"],
): string | null {
  if (!status) return null;
  return {
    paid: "Paid", overdue: "Overdue", refunded: "Refunded",
    cancelled: "Cancelled", trial: "Trial", delivered: "Delivered",
    payment_failed: "Payment failed", suspended: "Service suspended",
    renewal_due: "Renewal due",
  }[status] || null;
}

export function receiptAttentionLabel(
  state: ReceiptAttentionState | null | undefined,
  reason: ReceiptAttentionReason | null | undefined,
  isPrediction = false,
): string | null {
  if (!state || state === "none") return null;
  const reasonLabels: Record<ReceiptAttentionReason, string> = {
    overdue: "Overdue",
    payment_failed: "Payment failed",
    suspended: "Service suspended",
    renewal_due: "Renewal due",
    low_confidence: "Needs review",
  };
  const label = (reason ? reasonLabels[reason] : null) || {
    needs_attention: "Needs attention",
    coming_up: "Coming up",
    needs_review: "Needs review",
  }[state];
  return isPrediction ? `${label} · Predicted` : label;
}

export function receiptDocumentLabel(
  kind: ReceiptListItem["document_kind"],
): string | null {
  if (!kind) return null;
  return {
    invoice: "Invoice",
    receipt: "Receipt",
    payment_confirmation: "Payment confirmation",
    order_confirmation: "Order confirmation",
    booking: "Booking",
    fulfillment: "Fulfillment update",
  }[kind] || null;
}

export function receiptIdentifierLabel(
  kind: ReceiptListItem["identifier_kind"],
): string {
  if (!kind) return "Identifier";
  return {
    order: "Order", invoice: "Invoice", receipt: "Receipt", pnr: "PNR",
  }[kind] || "Identifier";
}

/** Presentation of backend facts only; no inference from email text. */
function receiptSecondaryParts(
  receipt: ReceiptListItem,
  merchant: ResolvedReceiptMerchant,
) {
  const detail = merchant.displayKind === "merchant" &&
    merchant.category !== "Other" &&
    merchant.category !== "Uncategorized"
    ? merchant.category
    : null;
  const date = formatLocalDateTime(
    receipt.receipt_date || receipt.gmail_internal_date,
    { month: "short", day: "numeric" },
  );
  // Email dates are not necessarily paid/due dates: keep them separate.
  return {
    detail: detail ? formatReceiptPassage(detail) : null,
    meta: [
      receiptAttentionLabel(
        receipt.attention_state,
        receipt.attention_reason,
        receipt.attention_is_prediction,
      ) || receiptStatusLabel(receipt.status),
      date,
    ].filter(Boolean).join(" · "),
  };
}

export function receiptSecondaryText(
  receipt: ReceiptListItem,
  merchant: ResolvedReceiptMerchant,
): string {
  const { detail, meta } = receiptSecondaryParts(receipt, merchant);
  return [detail, meta].filter(Boolean).join(" · ");
}

type ReceiptCandidate = {
  receipt: ReceiptListItem;
  merchant: ResolvedReceiptMerchant;
  eventKind: ReceiptEventKind;
  sourceIndex: number;
};

export function resolveReceiptMerchant(
  receipt: Pick<
    ReceiptListItem,
    | "from_email"
    | "from_name"
    | "merchant_name"
    | "merchant_domain"
    | "category"
    | "category_confidence"
  >,
): ResolvedReceiptMerchant {
  const merchantName = String(receipt.merchant_name || "").trim();
  const category =
    receipt.category &&
    [
      "Shopping",
      "Food",
      "Travel",
      "Transport",
      "Subscription",
      "Software & Subscriptions",
      "Cloud & Infra",
      "Bills",
      "Uncategorized",
      "Other",
    ].includes(receipt.category) &&
    typeof receipt.category_confidence === "number" &&
    receipt.category_confidence >= 0.85 &&
    receipt.category_confidence <= 1
      ? receipt.category
      : null;
  const merchantDomain = normalizeReceiptSenderDomain(
    String(receipt.merchant_domain || ""),
  );
  const verifiedBrand = merchantDomain
    ? resolveVerifiedReceiptMerchant(merchantDomain)
    : null;

  return {
    // Backend extraction is authoritative for the merchant label. The
    // reviewed registry is presentation-only and can supply a logo domain,
    // never decide whether the receipt exists or rename it in the browser.
    merchantId: merchantName
      ? `${merchantDomain || "unknown"}:${merchantName.toLowerCase()}`
      : null,
    displayName:
      merchantName ||
      (category !== "Other" && category !== "Uncategorized" ? category : null) ||
      UNKNOWN_RECEIPT_MERCHANT,
    logoDomain: merchantName ? verifiedBrand?.logoDomain || null : null,
    category: category || "Other",
    displayKind: merchantName
      ? "merchant"
      : category && category !== "Other" && category !== "Uncategorized"
        ? "category"
        : "generic",
  };
}

/**
 * Builds one cache-stable provider URL from an allowlisted canonical domain.
 * The template must be public HTTPS configuration with exactly one `{domain}`
 * placeholder. No receipt or account object can enter this function.
 */
export function buildReceiptLogoUrl(
  template: string | null | undefined,
  logoDomain: string | null | undefined,
): string | null {
  const normalizedDomain = normalizeReceiptSenderDomain(
    String(logoDomain || ""),
  );
  const normalizedTemplate = String(template || "").trim();
  if (
    !normalizedDomain ||
    !isVerifiedReceiptLogoDomain(normalizedDomain) ||
    !normalizedTemplate ||
    (normalizedTemplate.match(/\{domain\}/g) || []).length !== 1
  ) {
    return null;
  }

  try {
    const url = new URL(
      normalizedTemplate.replace(
        "{domain}",
        encodeURIComponent(normalizedDomain),
      ),
    );
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function formatReceiptAmount(
  currency: string | null | undefined,
  amount: number | null | undefined,
): string {
  const normalizedCurrency = String(currency || "")
    .trim()
    .toUpperCase();
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    !normalizedCurrency
  ) {
    return UNAVAILABLE_RECEIPT_AMOUNT;
  }

  if (normalizedCurrency === "$") return `$${amount.toFixed(2)}`;

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${normalizedCurrency}`;
  }
}

function classifyReceiptEvent(receipt: ReceiptListItem): ReceiptEventKind {
  // Either explicit normalized signal is sufficient to forbid a collapse.
  if (receipt.status === "refunded") return "refund";
  if (receipt.status === "cancelled") return "cancellation";
  const eventType = String(receipt.event_type || "")
    .trim()
    .toLowerCase();
  if (eventType === "refund") return "refund";
  if (eventType === "cancellation") return "cancellation";
  if (eventType === "fulfillment") return "fulfillment";
  if (eventType === "purchase") return "purchase";
  return "unknown";
}

function normalizeOrderId(orderId: string | null | undefined): string | null {
  const normalized = String(orderId || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  return normalized || null;
}

function hasDisplayAmount(receipt: ReceiptListItem): boolean {
  return (
    typeof receipt.amount === "number" &&
    Number.isFinite(receipt.amount) &&
    Boolean(String(receipt.currency || "").trim())
  );
}

function representativeScore(candidate: ReceiptCandidate): number {
  const documentRank = {
    invoice: 6, receipt: 5, payment_confirmation: 4,
    order_confirmation: 3, booking: 2, fulfillment: 1,
  }[candidate.receipt.document_kind || "fulfillment"];
  const primaryReceipt = candidate.eventKind === "purchase";
  const hasAmount = hasDisplayAmount(candidate.receipt);
  return documentRank * 10 + (primaryReceipt ? 2 : 0) + (hasAmount ? 1 : 0);
}

function lifecycleStatus(candidates: readonly ReceiptCandidate[]): ReceiptLifecycleStatus | null {
  const priority: Partial<Record<ReceiptLifecycleStatus, number>> = {
    suspended: 100,
    overdue: 95,
    payment_failed: 90,
    delivered: 80,
    renewal_due: 70,
    refunded: 65,
    cancelled: 60,
    paid: 50,
    trial: 40,
  };
  let selected: ReceiptCandidate | null = null;
  for (const candidate of candidates) {
    if (!candidate.receipt.status) continue;
    if (!selected) {
      selected = candidate;
      continue;
    }
    const candidateTime = receiptEventTimestamp(candidate.receipt);
    const selectedTime = receiptEventTimestamp(selected.receipt);
    if (
      candidateTime > selectedTime ||
      (candidateTime === selectedTime &&
        (priority[candidate.receipt.status] || 0) >
          (priority[selected.receipt.status || "trial"] || 0))
    ) {
      selected = candidate;
    }
  }
  return selected?.receipt.status || null;
}

function canonicalAttention(candidates: readonly ReceiptCandidate[]): {
  state: ReceiptAttentionState;
  reason: ReceiptAttentionReason | null;
  isPrediction: boolean;
  date: string | null;
} {
  const priority: Record<ReceiptAttentionState, number> = {
    none: 0,
    needs_review: 10,
    coming_up: 20,
    needs_attention: 30,
  };
  let selected: ReceiptCandidate | null = null;
  for (const candidate of candidates) {
    const state = candidate.receipt.attention_state || "none";
    if (state === "none" && !candidate.receipt.status) continue;
    if (!selected) {
      selected = candidate;
      continue;
    }
    const candidateTime = receiptEventTimestamp(candidate.receipt);
    const selectedTime = receiptEventTimestamp(selected.receipt);
    if (
      candidateTime > selectedTime ||
      (candidateTime === selectedTime &&
        priority[state] > priority[selected.receipt.attention_state || "none"])
    ) {
      selected = candidate;
    }
  }
  return {
    state: selected?.receipt.attention_state || "none",
    reason: selected?.receipt.attention_reason || null,
    isPrediction: selected?.receipt.attention_is_prediction === true,
    date: selected?.receipt.attention_date || null,
  };
}

function canonicalRecurrence(candidates: readonly ReceiptCandidate[]): ReceiptRecurrence {
  if (candidates.some(({ receipt }) => receipt.recurrence === "recurring")) return "recurring";
  if (candidates.some(({ receipt }) => receipt.recurrence === "one_time")) return "one_time";
  return "unknown";
}

function receiptSortTimestamp(value: string | null | undefined): number {
  const timestamp = new Date(String(value || "")).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function receiptEventDate(receipt: ReceiptListItem): string | null {
  return receipt.gmail_internal_date ||
    receipt.receipt_date ||
    receipt.transaction_date ||
    receipt.created_at ||
    null;
}

function receiptEventTimestamp(receipt: ReceiptListItem): number {
  return receiptSortTimestamp(receiptEventDate(receipt));
}

function receiptUrgency(row: RecentReceiptRow): number {
  if (row.attentionState === "needs_attention") return 30;
  if (row.attentionState === "coming_up") return 20;
  if (row.attentionState === "needs_review") return 10;
  return 0;
}

export function receiptIdentifiers(receipt: ReceiptListItem): NonNullable<ReceiptListItem["identifiers"]> {
  // New normalized records explicitly declare the full typed set. Never turn
  // a legacy invoice-like order_id into a second, conflicting order identity.
  if (receipt.identifiers) return receipt.identifiers;
  if (receipt.identifier_kind && receipt.identifier_value) {
    return [{ kind: receipt.identifier_kind, value: receipt.identifier_value }];
  }
  return receipt.order_id ? [{ kind: "order", value: receipt.order_id }] : [];
}

function buildSearchText(candidates: readonly ReceiptCandidate[]): string {
  return candidates
    .flatMap(({ receipt, merchant }) => [
      merchant.displayName,
      merchant.category,
      receipt.merchant_name,
      receipt.from_name,
      receipt.subject,
      receipt.order_id,
      receipt.identifier_value,
      receipt.short_detail,
      receipt.status,
      receipt.attention_state,
      receipt.attention_reason,
      receipt.recurrence,
      receipt.document_kind,
    ])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function buildEventTimeline(
  candidates: readonly ReceiptCandidate[],
): ReceiptTimelineEvent[] {
  return [...candidates]
    .sort((left, right) =>
      receiptEventTimestamp(right.receipt) - receiptEventTimestamp(left.receipt) ||
      receiptSelectionKey(left.receipt).localeCompare(receiptSelectionKey(right.receipt)),
    )
    .map(({ receipt, merchant, eventKind }) => ({
      sourceReceiptKey: receiptSelectionKey(receipt),
      documentKind: receipt.document_kind,
      eventKind,
      status: receipt.status || null,
      attentionState: receipt.attention_state || "none",
      date: receiptEventDate(receipt),
      merchantName: merchant.displayName,
      subject: receipt.subject || null,
      detail: receipt.short_detail || null,
    }));
}

function stableDisplayGroupId(groupKey: string): string {
  // FNV-1a keeps account/order identifiers out of rendered row keys while
  // preserving one stable display identity as a same-order group expands.
  let hash = 0x811c9dc5;
  for (let index = 0; index < groupKey.length; index += 1) {
    hash ^= groupKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `group-${(hash >>> 0).toString(36)}`;
}

export function receiptSelectionKey(receipt: ReceiptListItem): string {
  const sourceId = String(receipt.source_id || "").trim();
  if (sourceId) return sourceId;
  const explicit = String(receipt.receipt_key || "").trim();
  if (explicit) return explicit;
  const messageId = String(receipt.gmail_message_id || "").trim();
  return messageId ? `legacy:${messageId}` : `legacy-row:${receipt.id}`;
}

function toRecentReceiptRow(
  candidates: readonly ReceiptCandidate[],
  groupKey: string | null = null,
): RecentReceiptRow {
  const firstCandidate = candidates[0];
  if (!firstCandidate) {
    throw new Error(
      "A recent receipt row requires at least one source record.",
    );
  }

  let representative = firstCandidate;
  for (const candidate of candidates.slice(1)) {
    if (representativeScore(candidate) > representativeScore(representative)) {
      representative = candidate;
    }
  }

  const secondary = receiptSecondaryParts(representative.receipt, representative.merchant);
  const status = lifecycleStatus(candidates);
  const attention = canonicalAttention(candidates);
  const receiptDate = representative.receipt.transaction_date ||
    representative.receipt.receipt_date ||
    representative.receipt.gmail_internal_date ||
    null;
  const category = representative.merchant.category;
  const categorySecondary = representative.merchant.displayKind === "merchant"
    ? category === "Other" ? "Uncategorized" : category
    : category === "Uncategorized" || category === "Other" ? "Uncategorized" : null;
  const statusSecondary = receiptAttentionLabel(
    attention.state,
    attention.reason,
    attention.isPrediction,
  ) || receiptStatusLabel(status);
  const dateSecondary = formatLocalDateTime(receiptDate, { month: "short", day: "numeric" });
  const secondaryText = [categorySecondary, statusSecondary, dateSecondary]
    .filter(Boolean)
    .join(" · ");

  return {
    id: groupKey
      ? stableDisplayGroupId(groupKey)
      : stableDisplayGroupId(
          `receipt:${receiptSelectionKey(representative.receipt)}`,
        ),
    primaryReceiptId: representative.receipt.id,
    primaryReceiptKey: receiptSelectionKey(representative.receipt),
    merchantName: representative.merchant.displayName,
    category,
    displayKind: representative.merchant.displayKind,
    logoDomain: representative.merchant.logoDomain,
    amount:
      typeof representative.receipt.amount === "number" &&
      Number.isFinite(representative.receipt.amount)
        ? representative.receipt.amount
        : null,
    currency: representative.receipt.currency || null,
    searchText: buildSearchText(candidates),
    secondaryText,
    secondaryDetail: secondary.detail,
    secondaryMeta: secondary.meta,
    sourceReceiptIds: [...candidates].sort((left, right) => left.sourceIndex - right.sourceIndex).map(({ receipt }) => receipt.id),
    sourceReceiptKeys: [...candidates].sort((left, right) => left.sourceIndex - right.sourceIndex).map(({ receipt }) =>
      receiptSelectionKey(receipt),
    ),
    identifiers: candidates.flatMap(({ receipt }) => receiptIdentifiers(receipt)).filter(
      (item, index, all) => all.findIndex((other) => other.kind === item.kind && normalizeOrderId(other.value) === normalizeOrderId(item.value)) === index,
    ),
    status,
    recurrence: canonicalRecurrence(candidates),
    attentionState: attention.state,
    attentionReason: attention.reason,
    attentionIsPrediction: attention.isPrediction,
    attentionDate: attention.date,
    documentKind: representative.receipt.document_kind,
    receiptDate,
    confidence: typeof representative.receipt.classification_confidence === "number"
      ? representative.receipt.classification_confidence
      : null,
    eventTimeline: buildEventTimeline(candidates),
  };
}

function candidateIdentifierKeys(candidate: ReceiptCandidate): Set<string> {
  return new Set(
    receiptIdentifiers(candidate.receipt).flatMap((identifier) => {
      const value = normalizeOrderId(identifier.value);
      return value ? [`${identifier.kind}:${value}`] : [];
    }),
  );
}

function groupIdentifierKeys(group: readonly ReceiptCandidate[]): Set<string> {
  return new Set(group.flatMap((candidate) => [...candidateIdentifierKeys(candidate)]));
}

function groupHasIdentifierConflict(group: readonly ReceiptCandidate[]): boolean {
  const valuesByKind = new Map<string, Set<string>>();
  for (const { receipt } of group) {
    for (const identifier of receiptIdentifiers(receipt)) {
      const value = normalizeOrderId(identifier.value);
      if (!value) continue;
      const values = valuesByKind.get(identifier.kind) || new Set<string>();
      values.add(value);
      valuesByKind.set(identifier.kind, values);
    }
  }
  return [...valuesByKind.values()].some((values) => values.size > 1);
}

function recurringLifecycleHasTransactionConflict(
  group: readonly ReceiptCandidate[],
): boolean {
  // A subscription can emit a new payment-attempt reference for every retry.
  // Those references belong in the timeline and are not separate purchases.
  // Durable transaction identifiers remain authoritative: two different
  // orders/invoices/receipts/PNRs must never be collapsed.
  const durableKinds = new Set(["order", "invoice", "receipt", "pnr"]);
  const valuesByKind = new Map<string, Set<string>>();
  for (const { receipt } of group) {
    for (const identifier of receiptIdentifiers(receipt)) {
      if (!durableKinds.has(identifier.kind)) continue;
      const value = normalizeOrderId(identifier.value);
      if (!value) continue;
      const values = valuesByKind.get(identifier.kind) || new Set<string>();
      values.add(value);
      valuesByKind.set(identifier.kind, values);
    }
  }
  return [...valuesByKind.values()].some((values) => values.size > 1);
}

function merchantFingerprint(candidate: ReceiptCandidate): string[] {
  const ignored = new Set([
    "co", "com", "in", "inc", "llc", "ltd", "limited", "private", "pvt",
  ]);
  return String(candidate.receipt.merchant_name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !ignored.has(token));
}

function merchantsAgree(left: ReceiptCandidate, right: ReceiptCandidate): boolean {
  const leftTokens = merchantFingerprint(left);
  const rightTokens = merchantFingerprint(right);
  if (!leftTokens.length || !rightTokens.length) return false;
  const leftValue = leftTokens.join(" ");
  const rightValue = rightTokens.join(" ");
  if (leftValue === rightValue) return true;
  const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const longer = new Set(leftTokens.length <= rightTokens.length ? rightTokens : leftTokens);
  return shorter.some((token) => token.length >= 5) && shorter.every((token) => longer.has(token));
}

function isFulfillment(candidate: ReceiptCandidate): boolean {
  return candidate.eventKind === "fulfillment" ||
    candidate.receipt.document_kind === "fulfillment";
}

function specificCategory(candidate: ReceiptCandidate): string | null {
  const category = candidate.merchant.category;
  if (!category || category === "Other" || category === "Uncategorized") return null;
  if (category === "Subscription") return "Software & Subscriptions";
  return category;
}

function datesAreNear(
  candidate: ReceiptCandidate,
  group: readonly ReceiptCandidate[],
  maximumDays: number,
): boolean {
  const candidateTime = receiptEventTimestamp(candidate.receipt);
  if (!candidateTime) return false;
  const knownTimes = group
    .map(({ receipt }) => receiptEventTimestamp(receipt))
    .filter(Boolean);
  if (!knownTimes.length) return false;
  const nearest = Math.min(...knownTimes.map((timestamp) => Math.abs(timestamp - candidateTime)));
  return nearest <= maximumDays * 24 * 60 * 60 * 1000;
}

function isSeparateLifecycle(candidate: ReceiptCandidate): boolean {
  return candidate.eventKind === "refund" || candidate.eventKind === "cancellation";
}

function isCanonicalGroupEvent(candidate: ReceiptCandidate): boolean {
  return candidate.eventKind === "purchase" ||
    candidate.eventKind === "fulfillment" ||
    Boolean(candidate.receipt.document_kind) ||
    Boolean(candidate.receipt.status);
}

function strongIdentifierMatch(
  candidate: ReceiptCandidate,
  group: readonly ReceiptCandidate[],
): boolean {
  if (isSeparateLifecycle(candidate) || group.some(isSeparateLifecycle)) return false;
  if (!isCanonicalGroupEvent(candidate) || !group.some(isCanonicalGroupEvent)) return false;
  const candidateKeys = candidateIdentifierKeys(candidate);
  if (!candidateKeys.size) return false;
  const sharesIdentifier = [...groupIdentifierKeys(group)].some((key) => candidateKeys.has(key));
  if (!sharesIdentifier || groupHasIdentifierConflict([...group, candidate])) return false;
  const hasNamedMerchant = Boolean(String(candidate.receipt.merchant_name || "").trim()) &&
    group.some((member) => Boolean(String(member.receipt.merchant_name || "").trim()));
  return group.some((member) => merchantsAgree(member, candidate)) ||
    (hasNamedMerchant && (isFulfillment(candidate) || group.some(isFulfillment)));
}

function fulfillmentFallbackMatch(
  candidate: ReceiptCandidate,
  group: readonly ReceiptCandidate[],
): boolean {
  if (
    isSeparateLifecycle(candidate) ||
    (candidateIdentifierKeys(candidate).size && groupIdentifierKeys(group).size)
  ) return false;
  const candidateIsFulfillment = isFulfillment(candidate);
  const groupHasFulfillment = group.some(isFulfillment);
  const groupHasTransaction = group.some((member) => !isFulfillment(member));
  if (!(candidateIsFulfillment ? groupHasTransaction : groupHasFulfillment)) return false;
  if (!group.some((member) => merchantsAgree(member, candidate))) return false;
  const category = specificCategory(candidate);
  if (!category || !group.some((member) => specificCategory(member) === category)) return false;
  return datesAreNear(candidate, group, 21) && !groupHasIdentifierConflict([...group, candidate]);
}

function normalizedDetail(candidate: ReceiptCandidate): string {
  return String(candidate.receipt.short_detail || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function recurringLifecycleFallbackMatch(
  candidate: ReceiptCandidate,
  group: readonly ReceiptCandidate[],
): boolean {
  const lifecycleStatuses = new Set<ReceiptLifecycleStatus>([
    "trial", "payment_failed", "suspended", "renewal_due",
  ]);
  const status = candidate.receipt.status || null;
  const detail = normalizedDetail(candidate);
  const groupDetails = new Set(group.map(normalizedDetail).filter(Boolean));
  const amountAgrees = hasDisplayAmount(candidate.receipt) && group.some(({ receipt }) =>
    hasDisplayAmount(receipt) &&
    receipt.amount === candidate.receipt.amount &&
    String(receipt.currency || "").toUpperCase() ===
      String(candidate.receipt.currency || "").toUpperCase(),
  );
  const detailAgrees = Boolean(detail && groupDetails.has(detail));
  const hasConflictingDetail = Boolean(detail && groupDetails.size && !groupDetails.has(detail));
  const recurrenceValues = [
    candidate.receipt.recurrence || "unknown",
    ...group.map(({ receipt }) => receipt.recurrence || "unknown"),
  ];
  if (
    recurringLifecycleHasTransactionConflict([...group, candidate]) ||
    recurrenceValues.includes("one_time") ||
    !recurrenceValues.includes("recurring") ||
    !status ||
    !lifecycleStatuses.has(status) ||
    (!detailAgrees && !amountAgrees) ||
    (hasConflictingDetail && !amountAgrees) ||
    specificCategory(candidate) !== "Software & Subscriptions"
  ) return false;
  return group.every((member) =>
    Boolean(member.receipt.status && lifecycleStatuses.has(member.receipt.status)) &&
    specificCategory(member) === "Software & Subscriptions" &&
    merchantsAgree(member, candidate)
  ) && datesAreNear(candidate, group, 45);
}

function displayGroupKey(
  accountKey: string,
  group: readonly ReceiptCandidate[],
): string {
  const counts = new Map<string, number>();
  for (const candidate of group) {
    for (const key of candidateIdentifierKeys(candidate)) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const sharedKey = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort()[0];
  return JSON.stringify([
    accountKey,
    sharedKey || `source:${receiptSelectionKey(group[0]!.receipt)}`,
  ]);
}

/**
 * Creates a display-only projection. Raw receipt/cache records are never
 * changed. Strong identifiers are authoritative. Identifier-free fulfilment
 * and recurring lifecycle records collapse only with multiple agreeing
 * normalized facts and one unambiguous target. Conflicting order IDs and
 * refund/cancellation events never collapse, including through a bridge ID.
 */
export function buildRecentReceiptRows(
  receipts: readonly ReceiptListItem[],
  accountKey: string | null | undefined,
): RecentReceiptRow[] {
  const normalizedAccountKey = String(accountKey || "").trim();
  const hasKnownAccount = Boolean(normalizedAccountKey);
  const candidates: ReceiptCandidate[] = receipts.map((receipt, sourceIndex) => {
    const merchant = resolveReceiptMerchant(receipt);
    const eventKind = classifyReceiptEvent(receipt);
    return { receipt, merchant, eventKind, sourceIndex };
  });

  const groups: ReceiptCandidate[][] = [];
  const orderedCandidates = [...candidates].sort((left, right) =>
    representativeScore(right) - representativeScore(left) ||
    left.sourceIndex - right.sourceIndex,
  );
  for (const candidate of orderedCandidates) {
    if (!hasKnownAccount || isSeparateLifecycle(candidate)) {
      groups.push([candidate]);
      continue;
    }
    let matches = groups.filter((group) => strongIdentifierMatch(candidate, group));
    let recurringLifecycleMerge = false;
    if (!matches.length) {
      const fulfillmentMatches = groups.filter((group) =>
        fulfillmentFallbackMatch(candidate, group),
      );
      if (fulfillmentMatches.length === 1) {
        matches = fulfillmentMatches;
      } else if (!fulfillmentMatches.length) {
        const recurringMatches = groups.filter((group) =>
          recurringLifecycleFallbackMatch(candidate, group),
        );
        // Multiple plausible subscriptions are intentionally left separate.
        if (recurringMatches.length === 1) {
          matches = recurringMatches;
          recurringLifecycleMerge = true;
        }
      }
    }
    const merged = [...matches.flat(), candidate];
    const firstMatch = matches[0];
    const hasIdentifierConflict = recurringLifecycleMerge
      ? recurringLifecycleHasTransactionConflict(merged)
      : groupHasIdentifierConflict(merged);
    if (!firstMatch || hasIdentifierConflict) {
      groups.push([candidate]);
      continue;
    }
    firstMatch.push(candidate, ...matches.slice(1).flat());
    for (const group of matches.slice(1)) groups.splice(groups.indexOf(group), 1);
  }
  return groups
    .sort((left, right) =>
      Math.min(...left.map((candidate) => candidate.sourceIndex)) -
      Math.min(...right.map((candidate) => candidate.sourceIndex)),
    )
    .map((group) => toRecentReceiptRow(group, group.length > 1
    ? displayGroupKey(normalizedAccountKey, group) : null))
    .sort((left, right) =>
      receiptUrgency(right) - receiptUrgency(left) ||
      receiptSortTimestamp(right.receiptDate) - receiptSortTimestamp(left.receiptDate),
    );
}

export function summarizeRecentReceiptRows(
  rows: readonly RecentReceiptRow[],
): ReceiptSummary {
  return {
    paid: rows.filter((row) => row.status === "paid").length,
    attention: rows.filter((row) =>
      row.attentionState === "needs_attention" || row.attentionState === "needs_review",
    ).length,
    upcoming: rows.filter((row) => row.attentionState === "coming_up").length,
    missingAmount: rows.filter((row) => row.amount === null || !row.currency).length,
    hasData: rows.some((row) =>
      Boolean(row.status) || row.attentionState !== "none" || row.recurrence !== "unknown",
    ),
  };
}
