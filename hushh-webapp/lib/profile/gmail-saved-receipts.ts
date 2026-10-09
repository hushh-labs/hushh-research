/**
 * Mail > Receipts rows rebuilt from the saved receipt memory.
 *
 * The saved canonical index is already the page's canonical transactions
 * (deduped when it was written), so these rows are built from it directly and
 * never pass through `buildRecentReceiptRows`, whose fallback matching could
 * merge two distinct saved receipts. Opening the page therefore shows the same
 * list the last sync produced, from private memory, with no Mail scan.
 *
 * A saved receipt carries only the closed set of fields the index holds, so
 * there is no sender, subject, email text or source evidence to show.
 */

import {
  formatReceiptPassage,
  receiptAttentionLabel,
  receiptStatusLabel,
  UNKNOWN_RECEIPT_MERCHANT,
  type RecentReceiptRow,
  type ReceiptTimelineEvent,
} from "@/lib/profile/gmail-receipt-presentation";
import type { ReceiptAction } from "@/lib/profile/gmail-receipt-action";
import type { ReceiptCanonicalIndex, ReceiptIndexTransaction } from "@/lib/profile/gmail-receipt-memory-index";
import type {
  ReceiptAttentionReason,
  ReceiptAttentionState,
  ReceiptCategory,
  ReceiptListItem,
} from "@/lib/services/gmail-receipts-service";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";

export type SavedReceiptView = {
  /** The rows to render, one per saved transaction. */
  rows: RecentReceiptRow[];
  /** One detail record per row, keyed by `source_id` (the saved transaction ref). */
  items: ReceiptListItem[];
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A saved calendar date becomes local noon, so no timezone moves it to another day. */
function displayInstant(value: string | null): string | null {
  if (!value) return null;
  const match = ISO_DATE.exec(value);
  if (match) {
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function attentionOf(status: ReceiptIndexTransaction["status"]): {
  state: ReceiptAttentionState;
  reason: ReceiptAttentionReason | null;
} {
  // A direct mapping of the saved lifecycle status, as the scan's own attention
  // states are, never an inference from text.
  if (status === "overdue" || status === "payment_failed" || status === "suspended") {
    return { state: "needs_attention", reason: status };
  }
  if (status === "renewal_due") return { state: "coming_up", reason: "renewal_due" };
  return { state: "none", reason: null };
}

function documentKindOf(
  transaction: ReceiptIndexTransaction,
): ReceiptListItem["document_kind"] {
  const kinds = new Set(transaction.identifiers.map((identifier) => identifier.kind));
  if (kinds.has("invoice")) return "invoice";
  if (kinds.has("receipt")) return "receipt";
  return null;
}

function specificCategory(category: ReceiptCategory | null): ReceiptCategory | null {
  return category && category !== "Other" && category !== "Uncategorized" ? category : null;
}

function rowFor(transaction: ReceiptIndexTransaction, position: number): RecentReceiptRow {
  const merchant = transaction.merchant;
  const category = specificCategory(transaction.category);
  const displayKind: RecentReceiptRow["displayKind"] = merchant
    ? "merchant"
    : category
      ? "category"
      : "generic";
  const merchantName = merchant || category || UNKNOWN_RECEIPT_MERCHANT;
  const instant = displayInstant(transaction.transaction_date);
  const attention = attentionOf(transaction.status);
  const statusLabel =
    receiptAttentionLabel(attention.state, attention.reason, false) ||
    receiptStatusLabel(transaction.status);
  const dateLabel = formatLocalDateTime(instant, { month: "short", day: "numeric" });
  const secondaryDetail = displayKind === "merchant" && category ? formatReceiptPassage(category) : null;
  const secondaryMeta = [statusLabel, dateLabel].filter(Boolean).join(" · ");
  const categoryLabel =
    displayKind === "merchant" ? category ?? "Uncategorized" : category ? null : "Uncategorized";
  const documentKind = documentKindOf(transaction);
  const timeline: ReceiptTimelineEvent = {
    sourceReceiptKey: transaction.ref,
    documentKind,
    eventKind:
      transaction.status === "refunded"
        ? "refund"
        : transaction.status === "cancelled"
          ? "cancellation"
          : "purchase",
    status: transaction.status,
    attentionState: attention.state,
    date: instant,
    merchantName,
    subject: null,
    detail: transaction.detail,
  };
  return {
    id: `saved-${transaction.ref}`,
    primaryReceiptId: -(position + 1),
    primaryReceiptKey: transaction.ref,
    merchantName,
    category: transaction.category ?? "Other",
    displayKind,
    // Only a reviewed canonical domain, and only beside a named merchant.
    logoDomain: merchant ? transaction.logo_domain ?? null : null,
    amount: transaction.amount,
    currency: transaction.currency,
    searchText: [
      merchantName,
      transaction.category,
      transaction.status,
      transaction.detail,
      ...transaction.identifiers.map((identifier) => identifier.value),
    ]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join(" "),
    secondaryText: [categoryLabel, statusLabel, dateLabel].filter(Boolean).join(" · "),
    secondaryDetail,
    secondaryMeta,
    sourceReceiptIds: [-(position + 1)],
    sourceReceiptKeys: [transaction.ref],
    identifiers: transaction.identifiers.map((identifier) => ({ ...identifier })),
    status: transaction.status,
    recurrence: "unknown",
    attentionState: attention.state,
    attentionReason: attention.reason,
    attentionIsPrediction: false,
    attentionDate: null,
    documentKind,
    receiptDate: instant,
    confidence: null,
    action: transaction.action ? { ...transaction.action } : null,
    eventTimeline: [timeline],
  };
}

function itemFor(transaction: ReceiptIndexTransaction, position: number): ReceiptListItem {
  const instant = displayInstant(transaction.transaction_date);
  const attention = attentionOf(transaction.status);
  return {
    id: -(position + 1),
    source_id: transaction.ref,
    receipt_key: transaction.ref,
    gmail_message_id: "",
    merchant_name: transaction.merchant,
    status: transaction.status,
    attention_state: attention.state,
    attention_reason: attention.reason,
    identifiers: transaction.identifiers.map((identifier) => ({ ...identifier })),
    short_detail: transaction.detail,
    transaction_date: transaction.transaction_date,
    receipt_date: instant,
    document_kind: documentKindOf(transaction),
    category: transaction.category ?? "Other",
    category_confidence: 1,
    amount: transaction.amount,
    currency: transaction.currency,
    event_type: "purchase",
    action: transaction.action ? { ...transaction.action } : null,
    // Marks the record as complete: opening it never reads Mail.
    source_evidence: [],
  };
}

/** The rows and detail records for a saved index; empty when nothing is saved. */
export function savedReceiptView(index: ReceiptCanonicalIndex | null): SavedReceiptView | null {
  if (!index || index.transactions.length === 0) return null;
  return {
    rows: index.transactions.map(rowFor),
    items: index.transactions.map(itemFor),
  };
}

export type SavedReceiptChatAction = {
  /** The saved transaction ref the action belongs to. */
  ref: string;
  /** The merchant, or the category, that names the receipt on the button. */
  label: string;
  action: ReceiptAction;
};

const CHAT_ACTION_LIMIT = 3;
// A receipt link is offered beside an answer only when the answer is about few
// receipts; a payment that is due is always worth surfacing.
const CHAT_VIEW_ACTION_MAX_CITED = 3;
const CITED_REF = /^receipt:(txn_[0-9a-f]{16,64})$/;

/**
 * The compact actions to offer under a Chat answer that cited saved receipts.
 *
 * Looked up in the owner's own saved index by the cited refs, so the answer
 * carries no link and no reference to one. A cited receipt without a verified
 * action offers nothing.
 */
export function savedReceiptChatActions(
  index: ReceiptCanonicalIndex | null,
  citedSourceRefs: readonly string[],
): SavedReceiptChatAction[] {
  if (!index || citedSourceRefs.length === 0) return [];
  const byRef = new Map(index.transactions.map((transaction) => [transaction.ref, transaction]));
  const offered: SavedReceiptChatAction[] = [];
  for (const sourceRef of citedSourceRefs) {
    const ref = CITED_REF.exec(sourceRef)?.[1];
    const transaction = ref ? byRef.get(ref) : undefined;
    if (!transaction?.action) continue;
    offered.push({
      ref: transaction.ref,
      label: transaction.merchant || specificCategory(transaction.category) || UNKNOWN_RECEIPT_MERCHANT,
      action: { ...transaction.action },
    });
  }
  const viewActionsAllowed = citedSourceRefs.length <= CHAT_VIEW_ACTION_MAX_CITED;
  return offered
    .filter(({ action }) => action.kind === "pay_due" || viewActionsAllowed)
    .sort((a, b) => Number(b.action.kind === "pay_due") - Number(a.action.kind === "pay_due"))
    .slice(0, CHAT_ACTION_LIMIT);
}
