/**
 * The bounded canonical transaction index saved in `shopping.receipts_memory`.
 *
 * Receipts canonical data -> encrypted PKM -> Email Agent -> One Chat response.
 *
 * The index is derived on the device from the SAME canonical rows Mail >
 * Receipts shows (`buildRecentReceiptRows`), never from the retired server
 * receipt table. It carries only what an answer needs, and nothing a mailbox
 * would: no subject, preview, body, sender address, provider message or thread
 * id, signed source handle, attachment, or link. The Python reader
 * (`consent-protocol/hushh_mcp/services/receipt_memory_read.py`) validates the
 * same closed shape and refuses anything else, so a field added here without
 * a matching change there is dropped as "not ready", never half-read.
 *
 * It is stored under a leading-underscore branch. The PKM treats that spelling
 * as plumbing (`lib/pkm/internal-path-keys.ts`): it never becomes a shareable
 * path, never appears as a Memory card, and never enters the always-on prompt
 * packet. Only the owner's device reads it, to send it with a typed chat turn.
 */

import { isReceiptAction, type ReceiptAction } from "@/lib/profile/gmail-receipt-action";
import type {
  ReceiptCategory,
  ReceiptLifecycleStatus,
} from "@/lib/services/gmail-receipts-service";
import {
  isVerifiedReceiptLogoDomain,
  normalizeReceiptSenderDomain,
} from "@/lib/mail/receipt-merchant-registry";
import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { sha256Hex } from "@/lib/personal-knowledge-model/mutation-plan";

export const RECEIPT_INDEX_SCHEMA = "receipt_canonical_index.v1" as const;
/** Leading underscore = private plumbing branch; see the module note. */
export const RECEIPT_INDEX_BRANCH = "_canonical_index" as const;
export const RECEIPT_INDEX_MAX_TRANSACTIONS = 100;

const MAX_MERCHANT = 80;
const MAX_DETAIL = 120;
const MAX_IDENTIFIER_VALUE = 100;
const MAX_IDENTIFIERS = 3;
const CURRENCY = /^(?:[A-Z]{3}|\$)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LINK_OR_ADDRESS =
  /https?:\/\/|www\.|mailto:|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i;
// Characters that would turn email-derived text into markdown structure.
const MARKDOWN_SIGNIFICANT = /[*_`~[\]<>\\|]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const IDENTIFIER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._\-/#: ]{0,99}$/;
// A leading list or heading marker would turn a one-line detail into structure.
const LEADING_MARKER = /^(?:[-+•·]+\s*|\d+[.)]\s+|#+\s*)+/;
const REF = /^txn_[0-9a-f]{16,64}$/;
const ACCOUNT_REF = /^acct_[0-9a-f]{16,64}$/;
const TRANSACTION_KEYS: ReadonlySet<string> = new Set([
  "ref",
  "merchant",
  "amount",
  "currency",
  "category",
  "status",
  "transaction_date",
  "identifiers",
  "detail",
  "logo_domain",
  "action",
]);
const INDEX_KEYS: ReadonlySet<string> = new Set([
  "schema",
  "generated_at",
  "total_transactions",
  "truncated",
  "transactions",
  "account_ref",
]);

export type ReceiptIndexIdentifierKind = "order" | "invoice" | "receipt" | "pnr";

export type ReceiptIndexIdentifier = {
  kind: ReceiptIndexIdentifierKind;
  value: string;
};

export type ReceiptIndexTransaction = {
  /** Opaque and derived here; never a provider id. */
  ref: string;
  merchant: string | null;
  amount: number | null;
  currency: string | null;
  category: ReceiptCategory | null;
  status: ReceiptLifecycleStatus | null;
  /** `YYYY-MM-DD` for a calendar date, or an offset-aware ISO instant. */
  transaction_date: string | null;
  identifiers: ReceiptIndexIdentifier[];
  /** One short grounded detail the backend extractor already validated. */
  detail: string | null;
  /**
   * A canonical domain from the reviewed merchant registry, never merchant
   * text: the only thing a logo is ever looked up by. Null when unreviewed.
   */
  logo_domain?: string | null;
  /**
   * The receipt's one verified link, as a sealed reference that holds no URL
   * and no Gmail id. It is for the owner's device only: it is removed before a
   * chat turn leaves the device, and the link is resolved only on a click.
   */
  action?: ReceiptAction | null;
};

export type ReceiptCanonicalIndex = {
  schema: typeof RECEIPT_INDEX_SCHEMA;
  /** When the owner saved this memory; the reader treats an old save as not ready. */
  generated_at: string;
  /** Canonical rows at save time, which may exceed what is stored. */
  total_transactions: number;
  truncated: boolean;
  transactions: ReceiptIndexTransaction[];
  /**
   * A one-way reference to the Mail account these receipts came from. Saved
   * receipts are shown only for the account that produced them.
   */
  account_ref?: string | null;
};

/** The one-way account reference stored beside the transactions, or null without an account. */
export async function receiptAccountRef(
  accountKey: string | null | undefined,
): Promise<string | null> {
  const key = String(accountKey ?? "").trim();
  if (!key) return null;
  return `acct_${(await sha256Hex(`receipt-account:${key}`)).slice(0, 24)}`;
}

const IDENTIFIER_KINDS: ReadonlySet<string> = new Set([
  "order",
  "invoice",
  "receipt",
  "pnr",
]);
const LIFECYCLE_STATUSES: ReadonlySet<string> = new Set([
  "paid",
  "overdue",
  "refunded",
  "cancelled",
  "trial",
  "delivered",
  "payment_failed",
  "suspended",
  "renewal_due",
]);
const CATEGORIES: ReadonlySet<string> = new Set([
  "Shopping",
  "Food",
  "Travel",
  "Transport",
  "Software & Subscriptions",
  "Cloud & Infra",
  "Bills",
  "Uncategorized",
  "Subscription",
  "Other",
]);

/** One line, link-free, markdown-inert text, or null when nothing safe remains. */
function plainText(
  value: unknown,
  limit: number,
  clip: boolean,
): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(CONTROL, " ")
    .replace(MARKDOWN_SIGNIFICANT, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEADING_MARKER, "");
  if (!text || LINK_OR_ADDRESS.test(text)) return null;
  if (text.length <= limit) return text;
  // A clipped merchant would be a different merchant; only prose may be cut.
  return clip ? `${text.slice(0, limit - 1).trimEnd()}…` : null;
}

/** A calendar date stays a calendar date; an instant stays a UTC instant. */
function normalizeTransactionDate(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (ISO_DATE.test(text)) {
    const parsed = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text
      ? null
      : text;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sortKey(date: string | null): number {
  if (!date) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(ISO_DATE.test(date) ? `${date}T12:00:00Z` : date);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function indexCategory(row: RecentReceiptRow): ReceiptCategory | null {
  const category = row.category;
  if (!category || category === "Other" || category === "Uncategorized") return null;
  return category === "Subscription" ? "Software & Subscriptions" : category;
}

function indexLogoDomain(row: RecentReceiptRow): string | null {
  if (row.displayKind !== "merchant") return null;
  const domain = normalizeReceiptSenderDomain(String(row.logoDomain ?? ""));
  return domain && isVerifiedReceiptLogoDomain(domain) ? domain : null;
}

function indexIdentifiers(row: RecentReceiptRow): ReceiptIndexIdentifier[] {
  const seen = new Set<string>();
  const identifiers: ReceiptIndexIdentifier[] = [];
  for (const item of row.identifiers) {
    if (!IDENTIFIER_KINDS.has(item.kind)) continue; // payment references stay in the timeline
    const value = String(item.value ?? "").replace(/\s+/g, " ").trim();
    if (!value || value.length > MAX_IDENTIFIER_VALUE || !IDENTIFIER_VALUE.test(value)) {
      continue; // never truncate a code into a different code
    }
    const key = `${item.kind}:${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    identifiers.push({ kind: item.kind as ReceiptIndexIdentifierKind, value });
    if (identifiers.length === MAX_IDENTIFIERS) break;
  }
  return identifiers;
}

function indexDetail(row: RecentReceiptRow): string | null {
  // The representative receipt's own detail first, then any grounded detail in
  // the transaction's timeline. Only `short_detail` is read: a subject line is
  // raw email content and is never stored.
  const timeline = row.eventTimeline;
  const preferred = timeline.find(
    (event) => event.sourceReceiptKey === row.primaryReceiptKey && event.detail,
  );
  for (const event of [preferred, ...timeline]) {
    const detail = plainText(event?.detail, MAX_DETAIL, true);
    if (detail) return detail;
  }
  return null;
}

/**
 * An opaque, collision-free reference. The display-group id alone is a 32-bit
 * hash, so the source key joins it, and a repeat (never expected) is re-derived
 * with a counter: two transactions sharing a ref would make the reader refuse
 * the whole index.
 */
async function opaqueRef(
  row: RecentReceiptRow,
  accountKey: string,
  used: Set<string>,
): Promise<string> {
  const seed = `${accountKey}:${row.id}:${row.primaryReceiptKey}`;
  for (let attempt = 0; ; attempt += 1) {
    const digest = await sha256Hex(attempt === 0 ? seed : `${seed}:${attempt}`);
    const ref = `txn_${digest.slice(0, 24)}`;
    if (!used.has(ref)) {
      used.add(ref);
      return ref;
    }
  }
}

async function indexTransaction(
  row: RecentReceiptRow,
  ref: string,
): Promise<ReceiptIndexTransaction> {
  const currency = String(row.currency ?? "").trim().toUpperCase();
  const hasAmount =
    typeof row.amount === "number" &&
    Number.isFinite(row.amount) &&
    row.amount >= 0 &&
    CURRENCY.test(currency);
  return {
    ref,
    merchant:
      row.displayKind === "merchant"
        ? plainText(row.merchantName, MAX_MERCHANT, false)
        : null,
    // An amount with no currency is not a real currency string, so neither is sent.
    amount: hasAmount ? Math.round((row.amount as number) * 100) / 100 : null,
    currency: hasAmount ? currency : null,
    category: indexCategory(row),
    status: row.status,
    transaction_date: normalizeTransactionDate(row.receiptDate),
    identifiers: indexIdentifiers(row),
    detail: indexDetail(row),
    logo_domain: indexLogoDomain(row),
    action: row.action ? { kind: row.action.kind, ref: row.action.ref } : null,
  };
}

/**
 * Builds the index from canonical rows. Newest first; bounded; the same rows
 * Mail > Receipts renders, so chat can never disagree with the page.
 */
export async function buildReceiptCanonicalIndex(params: {
  rows: readonly RecentReceiptRow[];
  accountKey: string;
  now?: Date;
}): Promise<ReceiptCanonicalIndex> {
  const used = new Set<string>();
  const transactions: ReceiptIndexTransaction[] = [];
  for (const row of params.rows) {
    transactions.push(
      await indexTransaction(row, await opaqueRef(row, params.accountKey, used)),
    );
  }
  transactions.sort(
    (left, right) =>
      sortKey(right.transaction_date) - sortKey(left.transaction_date) ||
      left.ref.localeCompare(right.ref),
  );
  const stored = transactions.slice(0, RECEIPT_INDEX_MAX_TRANSACTIONS);
  return {
    schema: RECEIPT_INDEX_SCHEMA,
    generated_at: (params.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    total_transactions: transactions.length,
    truncated: transactions.length > stored.length,
    transactions: stored,
    account_ref: await receiptAccountRef(params.accountKey),
  };
}

/** Content fingerprint that ignores when the save happened. */
export async function receiptIndexDigest(index: ReceiptCanonicalIndex): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      total: index.total_transactions,
      transactions: index.transactions,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullable<T>(value: unknown, check: (item: unknown) => item is T): value is T | null {
  return value === null || check(value);
}

const isString = (value: unknown): value is string => typeof value === "string";

function isTransaction(value: unknown): value is ReceiptIndexTransaction {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  // The nine original keys are required; `logo_domain` is optional.
  if (keys.length < 9 || keys.some((key) => !TRANSACTION_KEYS.has(key))) return false;
  return (
    isString(value.ref) &&
    REF.test(value.ref) &&
    isNullable(value.merchant, isString) &&
    (value.amount === null ||
      (typeof value.amount === "number" && Number.isFinite(value.amount) && value.amount >= 0)) &&
    (value.currency === null || (isString(value.currency) && CURRENCY.test(value.currency))) &&
    (value.category === null || (isString(value.category) && CATEGORIES.has(value.category))) &&
    (value.status === null || (isString(value.status) && LIFECYCLE_STATUSES.has(value.status))) &&
    isNullable(value.transaction_date, isString) &&
    isNullable(value.detail, isString) &&
    (value.logo_domain === undefined ||
      value.logo_domain === null ||
      (isString(value.logo_domain) && isVerifiedReceiptLogoDomain(value.logo_domain))) &&
    (value.action === undefined || value.action === null || isReceiptAction(value.action)) &&
    Array.isArray(value.identifiers) &&
    value.identifiers.length <= MAX_IDENTIFIERS &&
    value.identifiers.every(
      (item) =>
        isRecord(item) &&
        Object.keys(item).length === 2 &&
        isString(item.kind) &&
        IDENTIFIER_KINDS.has(item.kind) &&
        isString(item.value) &&
        item.value.length > 0 &&
        item.value.length <= MAX_IDENTIFIER_VALUE,
    )
  );
}

/**
 * Reads a saved index back from decrypted PKM, or null when it is absent or
 * not the current shape. The server validates again; this only keeps the
 * device from sending something that can never be read.
 */
export function parseReceiptCanonicalIndex(value: unknown): ReceiptCanonicalIndex | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !INDEX_KEYS.has(key))) return null;
  const { schema, generated_at, total_transactions, truncated, transactions, account_ref } = value;
  if (
    schema !== RECEIPT_INDEX_SCHEMA ||
    !isString(generated_at) ||
    Number.isNaN(Date.parse(generated_at)) ||
    typeof total_transactions !== "number" ||
    !Number.isInteger(total_transactions) ||
    total_transactions < 0 ||
    typeof truncated !== "boolean" ||
    !Array.isArray(transactions) ||
    transactions.length > RECEIPT_INDEX_MAX_TRANSACTIONS ||
    total_transactions < transactions.length ||
    truncated !== total_transactions > transactions.length ||
    !(account_ref === undefined || account_ref === null || (isString(account_ref) && ACCOUNT_REF.test(account_ref))) ||
    !transactions.every(isTransaction) ||
    new Set(transactions.map((item) => item.ref)).size !== transactions.length
  ) {
    return null;
  }
  return value as ReceiptCanonicalIndex;
}

/**
 * What a chat turn may carry: the answer fields only. The sealed action
 * references, logo domains and account reference are for this device's own
 * pages, so they never leave it, and the backend's closed schema has no place
 * for them.
 */
export function receiptIndexForChat(
  index: ReceiptCanonicalIndex | null,
): ReceiptCanonicalIndex | null {
  if (!index) return null;
  return {
    schema: index.schema,
    generated_at: index.generated_at,
    total_transactions: index.total_transactions,
    truncated: index.truncated,
    transactions: index.transactions.map((transaction) => ({
      ref: transaction.ref,
      merchant: transaction.merchant,
      amount: transaction.amount,
      currency: transaction.currency,
      category: transaction.category,
      status: transaction.status,
      transaction_date: transaction.transaction_date,
      identifiers: transaction.identifiers,
      detail: transaction.detail,
    })),
  };
}

/** The saved index inside decrypted `shopping` domain data, if any. */
export function readReceiptCanonicalIndex(
  shoppingDomainData: unknown,
): ReceiptCanonicalIndex | null {
  if (!isRecord(shoppingDomainData)) return null;
  const memory = shoppingDomainData.receipts_memory;
  return isRecord(memory) ? parseReceiptCanonicalIndex(memory[RECEIPT_INDEX_BRANCH]) : null;
}

type ReceiptsMemoryRecord = Record<string, unknown>;

/** Marks the minimal summary this module writes, so it alone is regenerated. */
const SUMMARY_GENERATOR = "receipt_canonical_index";

function topMerchants(index: ReceiptCanonicalIndex, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const item of index.transactions) {
    if (item.merchant) counts.set(item.merchant, (counts.get(item.merchant) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([merchant]) => merchant);
}

/**
 * The `receipts_memory` branch after saving: every existing summary field is
 * kept as it is for compatibility, a minimal one is written only where none
 * exists, and the canonical index and its provenance are added.
 */
export function mergeReceiptsMemoryWithIndex(params: {
  existing: unknown;
  index: ReceiptCanonicalIndex;
  digest: string;
  now: Date;
}): ReceiptsMemoryRecord {
  const nowIso = params.now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const existing: ReceiptsMemoryRecord = isRecord(params.existing)
    ? { ...params.existing }
    : {};
  const merchants = topMerchants(params.index, 3);
  const existingSummary = isRecord(existing.readable_summary) ? existing.readable_summary : null;
  // A summary written by an earlier artifact is kept as it is. The minimal one
  // written here describes the saved list, so it is rewritten with each save.
  const keepExistingSummary =
    existingSummary !== null &&
    existingSummary.generated_by !== SUMMARY_GENERATOR &&
    isString(existingSummary.text) &&
    existingSummary.text.trim().length > 0;
  const total = params.index.total_transactions;
  const readableSummary = keepExistingSummary
    ? existingSummary
    : {
        text:
          total === 0
            ? "No receipts are saved."
            : `Saved ${total} ${total === 1 ? "receipt" : "receipts"} from your Mail.`,
        highlights: merchants.length ? [`Top merchants: ${merchants.join(", ")}`] : [],
        updated_at: nowIso,
        source_label: "Gmail receipts",
        generated_by: SUMMARY_GENERATOR,
      };
  const provenance = isRecord(existing.provenance) ? existing.provenance : {};
  return {
    ...existing,
    schema_version: typeof existing.schema_version === "number" ? existing.schema_version : 1,
    readable_summary: readableSummary,
    observed_facts: isRecord(existing.observed_facts)
      ? existing.observed_facts
      : { merchant_affinity: [], purchase_patterns: [], recent_highlights: [] },
    inferred_preferences: isRecord(existing.inferred_preferences)
      ? existing.inferred_preferences
      : { preference_signals: [] },
    provenance: {
      ...provenance,
      source_kind: "gmail_receipts",
      canonical_index_digest: params.digest,
      receipt_count_used: params.index.total_transactions,
      imported_at: nowIso,
    },
    [RECEIPT_INDEX_BRANCH]: params.index,
  };
}
