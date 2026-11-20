import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { parseHoldNextStep, parseHoldReason, type HoldNextStep, type HoldReason } from "@/lib/payouts/review-copy";
import { apiJson } from "@/lib/services/api-client";
import { PayoutContractError } from "@/lib/services/document-payout-service";

/**
 * Owner payout activity (GET /api/one/payouts/activity) and receipts
 * (GET /api/one/payouts/activity/{itemId}).
 *
 * Strict where a wrong value would mislead about money: amounts, ids and mode.
 * A list row that breaks them is left out; a receipt that breaks them is
 * refused. Tolerant elsewhere: unknown fields are ignored, a status this build
 * cannot name reads as "unrecognized" (never settled, never a refund), and a
 * malformed label or review falls back to nothing. Only known fields are
 * copied, so provider object ids the server might add never reach the UI.
 */

export const PAYOUT_ACTIVITY_KINDS = ["earning", "redemption", "deposit", "adjustment"] as const;
export type PayoutActivityKind = (typeof PAYOUT_ACTIVITY_KINDS)[number];
/** "coins" is every row that moves the coin balance: earnings, redemptions and adjustments. */
export type PayoutActivityQueryKind = "all" | PayoutActivityKind | "coins";
export type PayoutActivityMode = "live" | "test";

const QUERY_KINDS: readonly string[] = ["all", ...PAYOUT_ACTIVITY_KINDS, "coins"];
const ITEM_ID = /^(earning|redemption|reversal|redemption_reversal|deposit):([A-Za-z0-9_-]{4,64})$/;
const DEPOSIT_SOURCE = /^po_[A-Za-z0-9_]{1,61}$/;
const HUSSH_REFERENCE = /^HC-[0-9A-F]{8}$/;
// Provider object ids the client must never show (deposit po_ ids appear only inside item ids).
const PROVIDER_ID = /(?:^|[^A-Za-z0-9])(?:acct|ch|pi|py|tr|trr|txn|po|ba|card|src|cus|pm|re|fee|seti|evt)_[A-Za-z0-9]{3,}/;

export const EARNING_STATUSES = ["pending", "credited", "held", "reversed", "no_earning"] as const;
export const REDEMPTION_STATUSES = ["pending", "succeeded", "failed", "unknown"] as const;
export const DEPOSIT_STATUSES = ["pending", "in_transit", "paid", "canceled", "failed"] as const;
const REVERSAL_STATUSES = ["none", "due", "unknown", "reversed", "manual_review"] as const;
const TRANSFER_STATUSES = ["requested", "sent", "failed", "unknown"] as const;
const FUNDS_STATUSES = ["pending", "available", "paid_out", "unknown"] as const;
const STAGES = ["paid", "delivered", "credited", "held", "reversed"] as const;
const CONTENT_STATUSES = ["pending", "complete", "not_applicable"] as const;
const CONTENT_TYPES = ["cash_out", "document_transfer", "returned_deposit", "refund", "other"] as const;

/** Client-only: a newer server state this build cannot name. */
export type Unrecognized = "unrecognized";
export type EarningActivityStatus = (typeof EARNING_STATUSES)[number] | Unrecognized;
export type RedemptionActivityStatus = (typeof REDEMPTION_STATUSES)[number] | Unrecognized;
export type DepositActivityStatus = (typeof DEPOSIT_STATUSES)[number] | Unrecognized;
export type ReversalStatus = (typeof REVERSAL_STATUSES)[number] | Unrecognized;
export type AdjustmentType = "earning_reversed" | "cash_out_returned";

export type PayoutReview = { reason: HoldReason; nextStep: HoldNextStep };
export type PayoutMaskedBank = { name: string | null; last4: string | null };
export type PayoutActivityRequest = { id: string; label: string | null };

type ActivityItemBase = {
  /** Stable id, e.g. "earning:<request uuid>" or "deposit:po_…". Never shown. */
  id: string;
  occurredAt: string;
  updatedAt: string;
  /** Signed coin movement (1 coin = 1 cent); null when the balance did not move. */
  coinsDelta: number | null;
  amountCents: number | null;
  /** Ledger balance after this row; not the redeemable balance. */
  balanceAfterCoins: number | null;
  request: PayoutActivityRequest | null;
  review: PayoutReview | null;
  test: boolean;
};
export type PayoutActivityItem =
  | (ActivityItemBase & { kind: "earning"; status: EarningActivityStatus })
  | (ActivityItemBase & { kind: "redemption"; status: RedemptionActivityStatus; reversalStatus: ReversalStatus | null })
  | (ActivityItemBase & { kind: "adjustment"; type: AdjustmentType })
  | (ActivityItemBase & {
      kind: "deposit"; status: DepositActivityStatus; expectedArrivalAt: string | null; bank: PayoutMaskedBank | null;
    });

export type PayoutActivityPage = {
  mode: PayoutActivityMode;
  kind: PayoutActivityQueryKind;
  asOf: string;
  balanceCoins: number;
  items: PayoutActivityItem[];
  nextCursor: string | null;
  /** Only with `since`: too many changes to list, so reread from the top. */
  reset: boolean;
};

export type PayoutActivityQuery = {
  kind: PayoutActivityQueryKind;
  mode: PayoutActivityMode;
  limit: number;
  cursor?: string;
  since?: string;
};

export type ReceiptRequest = { id: string; label: string | null; confirmedFiles: number | null; expectedFiles: number | null };
export type FeeBreakdown = {
  grossCents: number | null; refundCents: number | null; platformFeeCents: number | null;
  processingFeeCents: number | null; netCents: number | null;
};
export type ReceiptStage = { stage: (typeof STAGES)[number]; at: string };

export type EarningReceipt = {
  id: string; kind: "earning"; status: EarningActivityStatus; coins: number | null; reference: string | null;
  request: ReceiptRequest | null; breakdown: FeeBreakdown | null; stages: ReceiptStage[];
  cashOut: { itemId: string; status: RedemptionActivityStatus } | null; review: PayoutReview | null;
};
export type RedemptionReceipt = {
  id: string; kind: "redemption"; status: RedemptionActivityStatus; mode: PayoutActivityMode;
  coins: number; amountCents: number; reference: string | null; request: ReceiptRequest | null;
  earning: (FeeBreakdown & { creditedAt: string | null }) | null;
  transfer: {
    status: (typeof TRANSFER_STATUSES)[number] | Unrecognized;
    requestedAt: string | null; sentAt: string | null; completedAt: string | null;
  };
  reversal: { status: ReversalStatus; at: string | null } | null;
  funds: { status: (typeof FUNDS_STATUSES)[number]; availableOn: string | null } | null;
  bankDeposit: { id: string; status: DepositActivityStatus; arrivalAt: string | null; bank: PayoutMaskedBank | null } | null;
  review: PayoutReview | null;
};
export type DepositContentItem = {
  itemId: string | null; type: (typeof CONTENT_TYPES)[number]; requestLabel: string | null; amountCents: number;
};
export type DepositReceipt = {
  id: string; kind: "deposit"; status: DepositActivityStatus; amountCents: number;
  createdAt: string | null; expectedArrivalAt: string | null; paidAt: string | null; failedAt: string | null;
  bank: PayoutMaskedBank | null; bankReference: string | null;
  contents: { status: (typeof CONTENT_STATUSES)[number]; items: DepositContentItem[]; otherCents: number } | null;
  actionRequired: "update_bank" | null;
};
export type AdjustmentReceipt = {
  id: string; kind: "adjustment"; type: AdjustmentType; coins: number; reference: string | null;
  request: ReceiptRequest | null; at: string | null; relatedItemId: string | null;
};
export type PayoutReceipt = EarningReceipt | RedemptionReceipt | DepositReceipt | AdjustmentReceipt;

type Prefix = "earning" | "redemption" | "reversal" | "redemption_reversal" | "deposit";
const KIND_OF_PREFIX: Record<Prefix, PayoutActivityKind> = {
  earning: "earning", redemption: "redemption", reversal: "adjustment",
  redemption_reversal: "adjustment", deposit: "deposit",
};

/** The prefix and kind of a valid item id, else null. Every id the client uses passes here. */
export function parsePayoutActivityItemId(value: unknown): { prefix: Prefix; kind: PayoutActivityKind } | null {
  if (typeof value !== "string") return null;
  const match = ITEM_ID.exec(value);
  if (!match) return null;
  const prefix = match[1] as Prefix;
  const source = match[2] ?? "";
  if (prefix === "deposit" ? !DEPOSIT_SOURCE.test(source) : !DOCUMENT_REQUEST_UUID.test(source)) return null;
  return { prefix, kind: KIND_OF_PREFIX[prefix] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function optionalDate(value: unknown): string | null {
  return isoDate(value) ? value : null;
}
function cents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function signed(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function nullableCents(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return cents(value) ? value : undefined;
}
function closed<T extends string>(values: readonly T[], value: unknown): T | Unrecognized {
  return (values as readonly unknown[]).includes(value) ? (value as T) : "unrecognized";
}
function label(value: unknown, max = 120): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value : null;
}
function reference(value: unknown): string | null {
  return typeof value === "string" && HUSSH_REFERENCE.test(value) ? value : null;
}
function bankReference(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 128 && !PROVIDER_ID.test(value) ? value : null;
}
function review(value: unknown): PayoutReview | null {
  return isRecord(value) ? { reason: parseHoldReason(value.reason), nextStep: parseHoldNextStep(value.nextStep) } : null;
}
/** Masked bank only: a value that is not a 4-digit tail is never shown. */
function maskedBank(value: unknown): PayoutMaskedBank | null {
  if (!isRecord(value)) return null;
  if (!(value.last4 === null || value.last4 === undefined || (typeof value.last4 === "string" && /^\d{4}$/.test(value.last4)))) return null;
  const name = label(value.name, 80);
  const last4 = typeof value.last4 === "string" ? value.last4 : null;
  return name || last4 ? { name, last4 } : null;
}
function activityRequest(value: unknown): PayoutActivityRequest | null {
  if (!isRecord(value) || typeof value.id !== "string" || !DOCUMENT_REQUEST_UUID.test(value.id)) return null;
  return { id: value.id, label: label(value.label) };
}
function receiptRequest(value: unknown): ReceiptRequest | null {
  const request = activityRequest(value);
  if (!request || !isRecord(value)) return null;
  const files = (key: string) => (cents(value[key]) ? (value[key] as number) : null);
  const confirmedFiles = files("confirmedFiles");
  const expectedFiles = files("expectedFiles");
  const consistent = confirmedFiles === null || expectedFiles === null || confirmedFiles <= expectedFiles;
  return { ...request, confirmedFiles: consistent ? confirmedFiles : null, expectedFiles: consistent ? expectedFiles : null };
}

/** The coin sign each kind may carry; deposits never move coins. */
function coinSignAllowed(kind: PayoutActivityKind, prefix: Prefix, delta: number): boolean {
  if (kind === "earning" || prefix === "redemption_reversal") return delta >= 0;
  if (kind === "redemption" || prefix === "reversal") return delta <= 0;
  return false;
}

function activityItem(
  value: unknown, mode: PayoutActivityMode, queryKind: PayoutActivityQueryKind,
): PayoutActivityItem | null {
  if (!isRecord(value)) return null;
  const id = parsePayoutActivityItemId(value.id);
  // An unknown kind is an additive server change this build cannot show.
  if (!id || value.kind !== id.kind) return null;
  if (queryKind !== "all" && (queryKind === "coins" ? id.kind === "deposit" : id.kind !== queryKind)) return null;
  if (!isoDate(value.occurredAt)) return null;
  const test = typeof value.test === "boolean" ? value.test : mode === "test";
  // Test money is never shown as real.
  if (mode === "live" && test) return null;
  const coinsDelta = value.coinsDelta === null || value.coinsDelta === undefined ? null : value.coinsDelta;
  if (coinsDelta !== null && (!signed(coinsDelta) || !coinSignAllowed(id.kind, id.prefix, coinsDelta))) return null;
  const amountCents = nullableCents(value.amountCents);
  if (amountCents === undefined) return null;
  // 100 coins = $1, so a coin row's dollars and coins are the same number.
  if (coinsDelta !== null && amountCents !== null && Math.abs(coinsDelta) !== amountCents) return null;
  const balance = value.balanceAfterCoins === null || value.balanceAfterCoins === undefined ? null : value.balanceAfterCoins;
  if (balance !== null && !signed(balance)) return null;
  const base: ActivityItemBase = {
    id: value.id as string,
    occurredAt: value.occurredAt,
    updatedAt: isoDate(value.updatedAt) ? value.updatedAt : value.occurredAt,
    coinsDelta,
    amountCents,
    balanceAfterCoins: id.kind === "deposit" ? null : balance,
    request: id.kind === "deposit" ? null : activityRequest(value.request),
    review: review(value.review),
    test,
  };
  switch (id.kind) {
    case "earning":
      return { ...base, kind: "earning", status: closed(EARNING_STATUSES, value.status) };
    case "redemption":
      return { ...base, kind: "redemption", status: closed(REDEMPTION_STATUSES, value.status),
        reversalStatus: value.reversalStatus === null || value.reversalStatus === undefined
          ? null : closed(REVERSAL_STATUSES, value.reversalStatus) };
    case "adjustment":
      return { ...base, kind: "adjustment", type: id.prefix === "reversal" ? "earning_reversed" : "cash_out_returned" };
    case "deposit":
      return { ...base, kind: "deposit", status: closed(DEPOSIT_STATUSES, value.status),
        expectedArrivalAt: optionalDate(value.expectedArrivalAt), bank: maskedBank(value.bank) };
  }
}

function invalidPage(field: string): PayoutContractError {
  return new PayoutContractError("Invalid payout activity", field);
}
function invalidReceipt(field: string): PayoutContractError {
  return new PayoutContractError("Invalid payout receipt", field);
}

export function parsePayoutActivityPage(
  body: unknown,
  query: PayoutActivityQuery,
  options: { sourceRead?: boolean } = {},
): PayoutActivityPage {
  if (!isRecord(body)) throw invalidPage("activity");
  // A new schema is a breaking change this build cannot read.
  if (body.schemaVersion !== 1) throw invalidPage("schemaVersion");
  if (body.mode !== query.mode) throw invalidPage("mode");
  if (body.kind !== query.kind) throw invalidPage("kind");
  if (body.currency !== "USD") throw invalidPage("currency");
  if (body.coinsPerDollar !== 100) throw invalidPage("coinsPerDollar");
  if (!isoDate(body.asOf)) throw invalidPage("asOf");
  if (!signed(body.balanceCoins)) throw invalidPage("balanceCoins");
  if (!Array.isArray(body.items) || body.items.length > (query.since ? 100 : query.limit)) throw invalidPage("items");
  if (!(body.nextCursor === null || (typeof body.nextCursor === "string" && body.nextCursor.length >= 1 &&
      body.nextCursor.length <= 256)) || (query.cursor !== undefined && body.nextCursor === query.cursor)) {
    throw invalidPage("nextCursor");
  }
  if (body.reset !== undefined && typeof body.reset !== "boolean") throw invalidPage("reset");
  const seen = new Set<string>();
  const items: PayoutActivityItem[] = [];
  for (const value of body.items) {
    const item = activityItem(value, query.mode, query.kind);
    if (options.sourceRead) {
      if (!isRecord(value) || !item || seen.has(item.id) ||
          value.test !== (query.mode === "test") || !isoDate(value.updatedAt) ||
          (item.kind !== "earning" && item.amountCents === null) ||
          ("status" in item && item.status === "unrecognized") ||
          (item.kind === "redemption" && item.reversalStatus === "unrecognized") ||
          (item.kind === "deposit" && value.expectedArrivalAt != null &&
            !isoDate(value.expectedArrivalAt)))
        throw invalidPage("sourceRead.items");
    } else if (!item || seen.has(item.id)) continue;
    if (!item) continue;
    seen.add(item.id);
    items.push(item);
  }
  if (options.sourceRead &&
      (items.length !== body.items.length || body.sourceItemCount !== body.items.length ||
        body.reset === true ||
        (body.nextCursor !== null && items.length !== query.limit)))
    throw invalidPage("sourceRead.completeness");
  return { mode: query.mode, kind: query.kind, asOf: body.asOf, balanceCoins: body.balanceCoins, items,
    nextCursor: body.nextCursor as string | null, reset: body.reset === true };
}

function breakdown(value: unknown, field: string): FeeBreakdown | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw invalidReceipt(field);
  const read = (key: keyof FeeBreakdown) => {
    const parsed = nullableCents(value[key]);
    if (parsed === undefined) throw invalidReceipt(`${field}.${key}`);
    return parsed;
  };
  return { grossCents: read("grossCents"), refundCents: read("refundCents"), platformFeeCents: read("platformFeeCents"),
    processingFeeCents: read("processingFeeCents"), netCents: read("netCents") };
}

function linkedId(value: unknown, kind?: PayoutActivityKind): string | null {
  const id = parsePayoutActivityItemId(value);
  return id && (!kind || id.kind === kind) ? (value as string) : null;
}

function earningReceipt(body: Record<string, unknown>, id: string): EarningReceipt {
  const coins = nullableCents(body.coins);
  if (coins === undefined) throw invalidReceipt("coins");
  const stages = Array.isArray(body.stages) ? body.stages.flatMap((value): ReceiptStage[] => {
    if (!isRecord(value) || !isoDate(value.at) || !(STAGES as readonly unknown[]).includes(value.stage)) return [];
    return [{ stage: value.stage as ReceiptStage["stage"], at: value.at }];
  }) : [];
  const cashOutId = isRecord(body.cashOut) ? linkedId(body.cashOut.itemId, "redemption") : null;
  return {
    id, kind: "earning", status: closed(EARNING_STATUSES, body.status), coins, reference: reference(body.reference),
    request: receiptRequest(body.request), breakdown: breakdown(body.breakdown, "breakdown"), stages,
    cashOut: cashOutId && isRecord(body.cashOut)
      ? { itemId: cashOutId, status: closed(REDEMPTION_STATUSES, body.cashOut.status) } : null,
    review: review(body.review),
  };
}

function redemptionReceipt(body: Record<string, unknown>, id: string): RedemptionReceipt {
  if (body.mode !== "live" && body.mode !== "test") throw invalidReceipt("mode");
  if (!cents(body.coins) || body.coins < 1 || body.coins > 50000) throw invalidReceipt("coins");
  if (body.amountCents !== body.coins) throw invalidReceipt("amountCents");
  if (!isRecord(body.transfer)) throw invalidReceipt("transfer");
  const transfer = body.transfer;
  const earning = isRecord(body.earning)
    ? { ...breakdown(body.earning, "earning")!, creditedAt: optionalDate(body.earning.creditedAt) } : null;
  const depositId = isRecord(body.bankDeposit) ? linkedId(body.bankDeposit.id, "deposit") : null;
  const funds = isRecord(body.funds) ? body.funds : null;
  return {
    id, kind: "redemption", status: closed(REDEMPTION_STATUSES, body.status), mode: body.mode,
    coins: body.coins, amountCents: body.coins, reference: reference(body.reference),
    request: receiptRequest(body.request), earning,
    transfer: { status: closed(TRANSFER_STATUSES, transfer.status), requestedAt: optionalDate(transfer.requestedAt),
      sentAt: optionalDate(transfer.sentAt), completedAt: optionalDate(transfer.completedAt) },
    reversal: isRecord(body.reversal)
      ? { status: closed(REVERSAL_STATUSES, body.reversal.status), at: optionalDate(body.reversal.at) } : null,
    funds: funds ? { status: (FUNDS_STATUSES as readonly unknown[]).includes(funds.status)
      ? (funds.status as (typeof FUNDS_STATUSES)[number]) : "unknown", availableOn: optionalDate(funds.availableOn) } : null,
    bankDeposit: depositId && isRecord(body.bankDeposit) ? {
      id: depositId, status: closed(DEPOSIT_STATUSES, body.bankDeposit.status),
      arrivalAt: optionalDate(body.bankDeposit.arrivalAt), bank: maskedBank(body.bankDeposit.bank),
    } : null,
    review: review(body.review),
  };
}

function depositContents(value: unknown): DepositReceipt["contents"] {
  if (!isRecord(value) || !(CONTENT_STATUSES as readonly unknown[]).includes(value.status)) return null;
  const items = Array.isArray(value.items) ? value.items.flatMap((item): DepositContentItem[] => {
    if (!isRecord(item) || !signed(item.amountCents)) return [];
    return [{
      itemId: linkedId(item.itemId),
      type: (CONTENT_TYPES as readonly unknown[]).includes(item.type) ? (item.type as DepositContentItem["type"]) : "other",
      requestLabel: label(item.requestLabel),
      amountCents: item.amountCents,
    }];
  }) : [];
  return { status: value.status as (typeof CONTENT_STATUSES)[number], items, otherCents: signed(value.otherCents) ? value.otherCents : 0 };
}

function depositReceipt(body: Record<string, unknown>, id: string): DepositReceipt {
  if (!cents(body.amountCents)) throw invalidReceipt("amountCents");
  return {
    id, kind: "deposit", status: closed(DEPOSIT_STATUSES, body.status), amountCents: body.amountCents,
    createdAt: optionalDate(body.createdAt), expectedArrivalAt: optionalDate(body.expectedArrivalAt),
    paidAt: optionalDate(body.paidAt), failedAt: optionalDate(body.failedAt),
    bank: maskedBank(body.bank), bankReference: bankReference(body.bankReference),
    contents: depositContents(body.contents),
    actionRequired: body.actionRequired === "update_bank" ? "update_bank" : null,
  };
}

function adjustmentReceipt(body: Record<string, unknown>, id: string, prefix: Prefix): AdjustmentReceipt {
  if (!signed(body.coins)) throw invalidReceipt("coins");
  return {
    id, kind: "adjustment", type: prefix === "reversal" ? "earning_reversed" : "cash_out_returned",
    coins: Math.abs(body.coins), reference: reference(body.reference), request: receiptRequest(body.request),
    at: optionalDate(body.at), relatedItemId: linkedId(body.relatedItemId),
  };
}

export function parsePayoutReceipt(body: unknown, itemId: string): PayoutReceipt {
  const id = parsePayoutActivityItemId(itemId);
  if (!id) throw new Error("Invalid activity item");
  if (!isRecord(body)) throw invalidReceipt("receipt");
  // Never show one item's receipt for another.
  if (body.id !== itemId) throw invalidReceipt("id");
  if (body.kind !== id.kind) throw invalidReceipt("kind");
  switch (id.kind) {
    case "earning": return earningReceipt(body, itemId);
    case "redemption": return redemptionReceipt(body, itemId);
    case "deposit": return depositReceipt(body, itemId);
    case "adjustment": return adjustmentReceipt(body, itemId, id.prefix);
  }
}

function authHeaders(vaultOwnerToken: string) {
  if (!vaultOwnerToken) throw new Error("Unlock your vault to view payouts");
  return { Authorization: `Bearer ${vaultOwnerToken}` };
}

function activityPath(query: PayoutActivityQuery): string {
  if (!QUERY_KINDS.includes(query.kind) || (query.mode !== "live" && query.mode !== "test") ||
      !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50 ||
      (query.cursor !== undefined && (typeof query.cursor !== "string" || !query.cursor || query.cursor.length > 256)) ||
      (query.since !== undefined && (!isoDate(query.since) || query.cursor !== undefined))) {
    throw new Error("Invalid activity query");
  }
  const params = new URLSearchParams({ kind: query.kind, mode: query.mode, limit: String(query.limit) });
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  if (query.since !== undefined) params.set("since", query.since);
  return `/api/one/payouts/activity?${params.toString()}`;
}

export class PayoutActivityService {
  static async list(
    vaultOwnerToken: string,
    query: PayoutActivityQuery,
    options: { sourceRead?: boolean } = {},
  ): Promise<PayoutActivityPage> {
    const path = activityPath(query);
    const body = await apiJson<unknown>(path, { headers: authHeaders(vaultOwnerToken), cache: "no-store" });
    return parsePayoutActivityPage(body, query, options);
  }

  static async item(vaultOwnerToken: string, itemId: string): Promise<PayoutReceipt> {
    if (!parsePayoutActivityItemId(itemId)) throw new Error("Invalid activity item");
    const body = await apiJson<unknown>(`/api/one/payouts/activity/${encodeURIComponent(itemId)}`, {
      headers: authHeaders(vaultOwnerToken), cache: "no-store",
    });
    return parsePayoutReceipt(body, itemId);
  }
}
