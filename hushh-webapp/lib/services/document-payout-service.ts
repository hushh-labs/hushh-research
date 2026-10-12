import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { parseHoldNextStep, parseHoldReason, type HoldNextStep, type HoldReason } from "@/lib/payouts/review-copy";
import { apiJson } from "@/lib/services/api-client";

export const PAYOUT_VERIFICATION_STATES = ["none", "upcoming", "due", "past_due", "in_review", "disabled"] as const;
const VERIFICATION_ITEMS = ["identity", "tax_id", "address", "bank_account", "business", "terms", "other"] as const;
const DISABLED_REASONS = ["requirements_past_due", "pending_verification", "under_review", "rejected", "listed",
  "platform_paused", "action_required", "other"] as const;
/** What Stripe still needs from the owner, in closed categories; never Stripe's own wording. */
export type PayoutVerification = {
  state: (typeof PAYOUT_VERIFICATION_STATES)[number];
  deadline: string | null;
  items: (typeof VERIFICATION_ITEMS)[number][];
  eventuallyDue: boolean;
  hasErrors: boolean;
  disabledReason: (typeof DISABLED_REASONS)[number] | null;
};
export type PayoutSchedule = { interval: "daily" | "weekly" | "monthly" | "manual"; delayDays: number | null };

/** Stripe Connect readiness for a US document owner. */
export type DocumentPayoutAccount = {
  detailsSubmitted: boolean;
  transfersEnabled: boolean;
  payoutsEnabled: boolean;
  ready: boolean;
  status: "ready" | "onboarding_required" | "restricted";
  bankStatus?: "linked" | "missing" | "needs_attention" | "unavailable";
  canManageBank?: boolean;
  bank?: {
    name: string | null;
    last4: string | null;
    status: "new" | "validated" | "verified" | "verification_failed" | "errored" | "unknown";
  } | null;
  /** Newer servers only. */
  verification?: PayoutVerification;
  payoutSchedule?: PayoutSchedule | null;
};
export type DocumentPayoutAccountResponse = { account: DocumentPayoutAccount | null; stripeMode?: "test" | "live" };
export type DocumentBankPayout = {
  id: string;
  amountCents: number;
  status: "pending" | "in_transit" | "paid" | "canceled" | "failed";
  expectedArrivalAt: string | null;
  failureCode: string | null;
  /** Newer servers only: the deposit's own times, destination and bank trace. */
  createdAt?: string | null;
  paidAt?: string | null;
  failedAt?: string | null;
  bank?: { name: string | null; last4: string | null } | null;
  bankReference?: string | null;
};
export type DocumentBankPayoutsResponse = {
  currency: "USD"; payouts: DocumentBankPayout[]; stripeMode?: "test" | "live";
  /** Newer servers only; null on the last page. */
  nextCursor?: string | null;
};
/** The connected account's Stripe balance ("In Stripe"), from a server snapshot. */
export type DocumentPayoutBalance = {
  stripeMode: "test" | "live"; currency: "USD"; accountLinked: boolean;
  inStripeCents: number; availableCents: number; pendingCents: number;
  nextAvailableOn: string | null; nextAvailableCents: number | null;
  asOf: string; stale: boolean;
};

/** Why some coins can't move yet, from the server's closed review vocabulary. */
export type HashcoinHold = {
  id: string; reason: HoldReason; nextStep: HoldNextStep; coins: number;
  requestId: string | null; requestLabel: string | null; since: string | null;
};
export type HashcoinBalance = {
  balanceCoins: number; reservedCoins: number; availableCoins: number; amountCents: number; held: boolean;
  nextRedeemCoins?: number;
  /** Live wallet, newer servers only. nextRedeemCoins <= redeemableCoins <= availableCoins. */
  holds?: HashcoinHold[];
  redeemableCoins?: number;
  redeemableCount?: number;
  remainingAfterNextCoins?: number;
  notRedeemableCoins?: number;
  nextRedeemSource?: { requestId: string; label: string | null } | null;
};
export type HashcoinRedemption = {
  id: string; clientRequestId?: string; amountCoins: number;
  status: "pending" | "succeeded" | "failed" | "unknown"; stripeMode: "test" | "live";
  /** "unrecognized" is client-only: a newer server state this build can't name. */
  reversalStatus?: "none" | "due" | "unknown" | "reversed" | "manual_review" | "unrecognized";
  createdAt?: string;
};
export type HashcoinWallet = {
  coinName: "Hussh Coins"; coinsPerDollar: 100; currency: "USD";
  live: HashcoinBalance; sandbox: HashcoinBalance;
  payoutMode: "test" | "live"; testPayouts: boolean; liveRedemptionEnabled: boolean;
  maxRedeemCoins: number;
  latestRedemption: HashcoinRedemption | null;
  redemptionHistory: HashcoinRedemption[];
  /** The open redemption was unreadable, so new ones wait until it reads again. */
  redeemBlocked?: boolean;
};

/** A Hussh Coins response broke its contract; `field` names where, never the value. */
export class PayoutContractError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = "PayoutContractError";
    this.field = field;
  }
}

const EARNING_STATUSES = ["awaiting_delivery", "awaiting_refund", "awaiting_fee", "awaiting_account",
  "due", "dispatching", "unknown", "manual_review", "transferred", "reversal_due",
  "reversal_unknown", "reversed", "void", "hashcoins_credited", "hashcoins_held", "hashcoins_reversed"] as const;
export type DocumentEarning = {
  requestId: string;
  description: string;
  stripeMode?: "test" | "live" | "legacy";
  status: typeof EARNING_STATUSES[number];
  grossAmountCents: number;
  refundAmountCents: number | null;
  platformFeeCents: number | null;
  processingFeeCents: number | null;
  netAmountCents: number | null;
  reversedAmountCents: number | null;
  createdAt: string;
  transferredAt: string | null;
  expectedFiles: number | null;
  confirmedFiles: number | null;
  settlementMethod?: "stripe_transfer" | "hashcoins";
  creditedCoins?: number | null;
  creditedAt?: string | null;
};
export type DocumentEarningsResponse = {
  currency: "USD"; transactions: DocumentEarning[]; nextCursor: string | null; stripeMode?: "test" | "live";
  /** Newer servers only: which mode's earnings this page holds ("test" includes legacy rows). */
  mode?: "test" | "live";
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("Invalid payout response");
  return value;
}
function stripeMode(body: Record<string, unknown>): { stripeMode?: "test" | "live" } {
  if (body.stripeMode === undefined) return {};
  if (body.stripeMode !== "test" && body.stripeMode !== "live") throw new Error("Invalid payout mode");
  return { stripeMode: body.stripeMode };
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nullableInteger(value: unknown): value is number | null {
  return value === null || integer(value);
}
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function label(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value : null;
}
// Opaque, printable and bounded; the server alone knows what it encodes.
const PAGE_CURSOR = /^[\x21-\x7e]{1,256}$/;
const HOLD_ID = /^(?:(?:earning|redemption):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|balance)$/i;

/** Additive fields read tolerantly: a part this build can't read is left out, as an older server would. */
function verification(value: unknown): PayoutVerification | undefined {
  const state = PAYOUT_VERIFICATION_STATES.find((item) => isObject(value) && item === value.state);
  if (!isObject(value) || !state) return undefined;
  const named = (Array.isArray(value.items) ? value.items.slice(0, 20) : []).filter((item) => typeof item === "string")
    .map((item) => VERIFICATION_ITEMS.find((known) => known === item) ?? "other");
  const reason = value.disabledReason;
  return { state, deadline: date(value.deadline) ? value.deadline : null,
    items: VERIFICATION_ITEMS.filter((item) => named.includes(item)),
    eventuallyDue: value.eventuallyDue === true, hasErrors: value.hasErrors === true,
    disabledReason: typeof reason === "string" ? DISABLED_REASONS.find((known) => known === reason) ?? "other" : null };
}
function payoutSchedule(value: unknown): PayoutSchedule | null {
  if (!isObject(value) || !["daily", "weekly", "monthly", "manual"].includes(String(value.interval))) return null;
  return { interval: value.interval as PayoutSchedule["interval"],
    delayDays: integer(value.delayDays) && value.delayDays <= 365 ? value.delayDays : null };
}
function hold(row: unknown): HashcoinHold | null {
  if (!isObject(row) || typeof row.id !== "string" || !HOLD_ID.test(row.id) || !integer(row.coins)) return null;
  // An unknown reason reads as a neutral check, never as a refund.
  return { id: row.id, reason: parseHoldReason(row.reason), nextStep: parseHoldNextStep(row.nextStep), coins: row.coins,
    requestId: typeof row.requestId === "string" && DOCUMENT_REQUEST_UUID.test(row.requestId) ? row.requestId : null,
    requestLabel: label(row.requestLabel, 120), since: date(row.since) ? row.since : null };
}
/** Live-only additions. Holds drop unreadable rows; redeemable totals must keep their invariants. */
function liveExtras(row: Record<string, unknown>): Partial<HashcoinBalance> {
  const invalid = (key: string) => new PayoutContractError("Invalid Hussh Coins balance", `live.${key}`);
  const extras: Partial<HashcoinBalance> = {};
  for (const key of ["redeemableCoins", "redeemableCount", "remainingAfterNextCoins", "notRedeemableCoins"] as const) {
    if (row[key] === undefined) continue;
    if (!integer(row[key])) throw invalid(key);
    extras[key] = row[key];
  }
  const available = row.availableCoins as number;
  const next = (row.nextRedeemCoins as number | undefined) ?? 0;
  const { redeemableCoins: redeemable, redeemableCount: count, remainingAfterNextCoins: remaining, notRedeemableCoins: blocked } = extras;
  if (redeemable !== undefined && (redeemable < next || redeemable > available)) throw invalid("redeemableCoins");
  // Each source is at least one coin, and none means nothing redeemable.
  if (count !== undefined && redeemable !== undefined && (count > redeemable || (count === 0) !== (redeemable === 0))) {
    throw invalid("redeemableCount");
  }
  if (remaining !== undefined && remaining !== available - next) throw invalid("remainingAfterNextCoins");
  if (blocked !== undefined && (blocked > available || (redeemable !== undefined && blocked !== available - redeemable))) {
    throw invalid("notRedeemableCoins");
  }
  if (Array.isArray(row.holds)) {
    const holds = row.holds.slice(0, 20).map(hold).filter((item) => item !== null);
    extras.holds = holds.filter((item, index) => holds.findIndex((other) => other.id === item.id) === index);
  }
  const source = row.nextRedeemSource;
  if (source !== undefined) {
    extras.nextRedeemSource = next > 0 && isObject(source) && typeof source.requestId === "string" &&
      DOCUMENT_REQUEST_UUID.test(source.requestId) ? { requestId: source.requestId, label: label(source.label, 120) } : null;
  }
  return extras;
}
function authHeaders(vaultOwnerToken: string) {
  if (!vaultOwnerToken) throw new Error("Unlock your vault to view payouts");
  return { Authorization: `Bearer ${vaultOwnerToken}` };
}
/** Stripe owns onboarding and bank edits; validate again at the navigation boundary. */
export function documentPayoutLinkUrl(value: unknown, purpose: "onboarding" | "management"): string {
  if (typeof value !== "string") throw new Error("Invalid payout link");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid payout link"); }
  const allowed = purpose === "management"
    ? ["stripe.com", "connect.stripe.com"].includes(url.hostname) && /^\/express\/.+/.test(url.pathname)
    : url.hostname === "connect.stripe.com";
  if (url.protocol !== "https:" || !allowed || url.username || url.password || url.port) {
    throw new Error("Invalid payout link");
  }
  return url.href;
}
function connectLink(value: unknown, purpose: "onboarding" | "management"): { url: string } {
  return { url: documentPayoutLinkUrl(object(value).url, purpose) };
}

function coinBalance(row: unknown, field: "live" | "sandbox"): HashcoinBalance {
  if (!isObject(row) || !["reservedCoins", "availableCoins"].every((key) => integer(row[key])) ||
      !Number.isSafeInteger(row.balanceCoins) || !Number.isSafeInteger(row.amountCents) ||
      typeof row.held !== "boolean" || row.amountCents !== row.balanceCoins || (Number(row.balanceCoins) < 0 && row.held !== true) ||
      row.availableCoins !== (row.held ? 0 : Math.max(Number(row.balanceCoins) - Number(row.reservedCoins), 0))) {
    throw new PayoutContractError("Invalid Hussh Coins balance", field);
  }
  if (row.nextRedeemCoins !== undefined && (!integer(row.nextRedeemCoins) || row.nextRedeemCoins > 50000 || row.nextRedeemCoins > row.availableCoins)) {
    throw new PayoutContractError("Invalid Hussh Coins balance", `${field}.nextRedeemCoins`);
  }
  return { balanceCoins: row.balanceCoins as number, reservedCoins: row.reservedCoins as number,
    availableCoins: row.availableCoins as number, amountCents: row.amountCents as number, held: row.held,
    ...(row.nextRedeemCoins !== undefined ? { nextRedeemCoins: row.nextRedeemCoins as number } : {}),
    ...(field === "live" ? liveExtras(row) : {}) };
}

function redemption(row: unknown, mode: "test" | "live"): HashcoinRedemption {
  const invalid = (field: string) => new PayoutContractError("Invalid Hussh Coins redemption", field);
  if (!isObject(row)) throw invalid("redemption");
  if (typeof row.id !== "string" || !DOCUMENT_REQUEST_UUID.test(row.id)) throw invalid("id");
  if (row.clientRequestId !== undefined && (typeof row.clientRequestId !== "string" || !DOCUMENT_REQUEST_UUID.test(row.clientRequestId))) throw invalid("clientRequestId");
  if (!integer(row.amountCoins) || row.amountCoins < 1 || row.amountCoins > 50000) throw invalid("amountCoins");
  if (row.stripeMode !== mode) throw invalid("stripeMode");
  if (typeof row.status !== "string") throw invalid("status");
  if (mode === "live" && typeof row.reversalStatus !== "string") throw invalid("reversalStatus");
  if (row.createdAt !== undefined && !date(row.createdAt)) throw invalid("createdAt");
  // A state this build does not know reads as unknown, never as settled. Test rows carry no reversal.
  return { id: row.id, amountCoins: row.amountCoins, stripeMode: mode,
    status: (["pending", "succeeded", "failed"] as const).find((status) => status === row.status) ?? "unknown",
    ...(row.clientRequestId ? { clientRequestId: row.clientRequestId as string } : {}),
    ...(mode === "live" ? { reversalStatus: (["none", "due", "unknown", "reversed", "manual_review"] as const)
      .find((status) => status === row.reversalStatus) ?? "unrecognized" } : {}),
    ...(row.createdAt ? { createdAt: row.createdAt as string } : {}) };
}
/** Wallet rows that break the contract drop out; redeem responses stay strict. */
function walletRedemption(row: unknown, mode: "test" | "live"): HashcoinRedemption | null {
  try {
    return redemption(row, mode);
  } catch (error) {
    if (error instanceof PayoutContractError) return null;
    throw error;
  }
}

export class DocumentPayoutService {
  static async hashcoins(vaultOwnerToken: string): Promise<HashcoinWallet> {
    const body = await apiJson<unknown>("/api/one/payouts/hashcoins", {
      headers: authHeaders(vaultOwnerToken), cache: "no-store",
    });
    const invalid = (field: string) => new PayoutContractError("Invalid Hussh Coins wallet", field);
    if (!isObject(body)) throw invalid("wallet");
    if (body.coinName !== "Hussh Coins") throw invalid("coinName");
    if (body.coinsPerDollar !== 100) throw invalid("coinsPerDollar");
    if (body.currency !== "USD") throw invalid("currency");
    if (body.payoutMode !== "test" && body.payoutMode !== "live") throw invalid("payoutMode");
    if (typeof body.testPayouts !== "boolean" || (body.payoutMode === "live" && body.testPayouts)) throw invalid("testPayouts");
    if (typeof body.liveRedemptionEnabled !== "boolean" ||
        (body.liveRedemptionEnabled && (body.payoutMode !== "live" || body.testPayouts))) throw invalid("liveRedemptionEnabled");
    if (body.maxRedeemCoins !== undefined && (typeof body.maxRedeemCoins !== "number" || !Number.isFinite(body.maxRedeemCoins))) throw invalid("maxRedeemCoins");
    if (body.redemptionHistory !== undefined && !Array.isArray(body.redemptionHistory)) throw invalid("redemptionHistory");
    const mode = body.payoutMode;
    const live = coinBalance(body.live, "live");
    const latestRedemption = body.latestRedemption == null ? null : walletRedemption(body.latestRedemption, mode);
    return { coinName: "Hussh Coins", coinsPerDollar: 100, currency: "USD",
      live: body.liveRedemptionEnabled ? { ...live, nextRedeemCoins: live.nextRedeemCoins ?? 0 } : live,
      sandbox: coinBalance(body.sandbox, "sandbox"), payoutMode: mode, testPayouts: body.testPayouts,
      liveRedemptionEnabled: body.liveRedemptionEnabled,
      maxRedeemCoins: Math.min(Math.max(Math.floor(body.maxRedeemCoins ?? 50000), 1), 50000),
      redemptionHistory: (body.redemptionHistory ?? []).slice(0, 10).map((row) => walletRedemption(row, mode)).filter((row) => row !== null),
      // An unreadable open redemption may still hold coins, so block new ones instead of guessing.
      latestRedemption, ...(body.latestRedemption != null && !latestRedemption ? { redeemBlocked: true } : {}) };
  }

  static async redeem(vaultOwnerToken: string, amountCoins: number, clientRequestId: string, mode: "test" | "live"): Promise<HashcoinRedemption> {
    if (!integer(amountCoins) || amountCoins < 1 || amountCoins > 50000 ||
        !DOCUMENT_REQUEST_UUID.test(clientRequestId) || !["test", "live"].includes(mode)) throw new Error("Invalid redemption");
    return redemption(await apiJson<unknown>("/api/one/payouts/hashcoins/redeem", {
      method: "POST", headers: { ...authHeaders(vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify({ amountCoins, clientRequestId, mode }), cache: "no-store",
    }), mode);
  }

  static async redeemTest(vaultOwnerToken: string, amountCoins: number, clientRequestId: string): Promise<HashcoinRedemption> {
    return this.redeem(vaultOwnerToken, amountCoins, clientRequestId, "test");
  }

  static async redeemLive(vaultOwnerToken: string, amountCoins: number, clientRequestId: string): Promise<HashcoinRedemption> {
    return this.redeem(vaultOwnerToken, amountCoins, clientRequestId, "live");
  }

  static async account(vaultOwnerToken: string, options?: { fresh?: boolean }): Promise<DocumentPayoutAccountResponse> {
    const body = object(await apiJson<unknown>(`/api/one/payouts/account${options?.fresh ? "?fresh=true" : ""}`, {
      headers: authHeaders(vaultOwnerToken), cache: "no-store",
    }));
    const mode = stripeMode(body);
    if (body.account === null) return { account: null, ...mode };
    const account = object(body.account);
    if (!["detailsSubmitted", "transfersEnabled", "payoutsEnabled", "ready"].every((key) => typeof account[key] === "boolean") ||
        !["ready", "onboarding_required", "restricted"].includes(String(account.status)) ||
        (account.ready === true && (!account.detailsSubmitted || !account.transfersEnabled || !account.payoutsEnabled || account.status !== "ready"))) {
      throw new Error("Invalid payout account response");
    }
    let bank: DocumentPayoutAccount["bank"];
    if (account.bank === null) bank = null;
    else if (account.bank !== undefined) {
      const item = object(account.bank);
      if (!(item.name === null || (typeof item.name === "string" && item.name.length <= 100)) ||
          !(item.last4 === null || (typeof item.last4 === "string" && /^\d{4}$/.test(item.last4))) ||
          !["new", "validated", "verified", "verification_failed", "errored", "unknown"].includes(String(item.status))) {
        throw new Error("Invalid payout bank response");
      }
      bank = { name: item.name as string | null, last4: item.last4 as string | null,
        status: item.status as NonNullable<DocumentPayoutAccount["bank"]>["status"] };
    }
    if ((account.bankStatus !== undefined && !["linked", "missing", "needs_attention", "unavailable"].includes(String(account.bankStatus))) ||
        (account.canManageBank !== undefined && typeof account.canManageBank !== "boolean") ||
        (account.ready === true && ["missing", "needs_attention", "unavailable"].includes(String(account.bankStatus)))) {
      throw new Error("Invalid payout bank response");
    }
    const verified = verification(account.verification);
    return { ...mode, account: {
      ...(bank !== undefined ? { bank } : {}),
      ...(account.bankStatus !== undefined ? { bankStatus: account.bankStatus as DocumentPayoutAccount["bankStatus"] } : {}),
      ...(account.canManageBank !== undefined ? { canManageBank: account.canManageBank as boolean } : {}),
      ...(verified ? { verification: verified } : {}),
      ...(account.payoutSchedule !== undefined ? { payoutSchedule: payoutSchedule(account.payoutSchedule) } : {}),
      detailsSubmitted: account.detailsSubmitted as boolean,
      transfersEnabled: account.transfersEnabled as boolean,
      payoutsEnabled: account.payoutsEnabled as boolean,
      ready: account.ready as boolean,
      status: account.status as DocumentPayoutAccount["status"],
    } };
  }

  /** "verify" also collects what Stripe will need later, in the same visit. */
  static async onboard(vaultOwnerToken: string, purpose?: "verify"): Promise<{ url: string }> {
    if (purpose !== undefined && purpose !== "verify") throw new Error("Invalid payout setup purpose");
    return connectLink(await apiJson<unknown>("/api/one/payouts/account/onboard", purpose ? {
      method: "POST", headers: { ...authHeaders(vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify({ purpose }), cache: "no-store",
    } : {
      method: "POST", headers: authHeaders(vaultOwnerToken), cache: "no-store",
    }), "onboarding");
  }

  static async balance(vaultOwnerToken: string): Promise<DocumentPayoutBalance> {
    const body = object(await apiJson<unknown>("/api/one/payouts/account/balance", {
      headers: authHeaders(vaultOwnerToken), cache: "no-store",
    }));
    const cents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
    const nextOn = body.nextAvailableOn ?? null;
    const nextCents = body.nextAvailableCents ?? null;
    if ((body.stripeMode !== "test" && body.stripeMode !== "live") || body.currency !== "USD" ||
        typeof body.accountLinked !== "boolean" || typeof body.stale !== "boolean" || !date(body.asOf) ||
        !cents(body.inStripeCents) || !cents(body.availableCents) || !cents(body.pendingCents) ||
        !(nextOn === null || date(nextOn)) || !(nextCents === null || cents(nextCents)) ||
        // No linked account has no money in Stripe.
        (!body.accountLinked && (body.inStripeCents !== 0 || body.availableCents !== 0 || body.pendingCents !== 0))) {
      throw new Error("Invalid payout balance response");
    }
    return { stripeMode: body.stripeMode, currency: "USD", accountLinked: body.accountLinked,
      inStripeCents: body.inStripeCents, availableCents: body.availableCents, pendingCents: body.pendingCents,
      nextAvailableOn: nextOn, nextAvailableCents: nextCents, asOf: body.asOf, stale: body.stale };
  }

  static async manage(vaultOwnerToken: string): Promise<{ url: string }> {
    return connectLink(await apiJson<unknown>("/api/one/payouts/account/manage", {
      method: "POST", headers: authHeaders(vaultOwnerToken), cache: "no-store",
    }), "management");
  }

  /** `mode` picks live or test earnings ("test" includes legacy rows); omitted, the server's mode. */
  static async earnings(vaultOwnerToken: string, cursor?: string, mode?: "live" | "test"): Promise<DocumentEarningsResponse> {
    if (cursor !== undefined && !DOCUMENT_REQUEST_UUID.test(cursor)) throw new Error("Invalid earnings cursor");
    if (mode !== undefined && mode !== "live" && mode !== "test") throw new Error("Invalid earnings mode");
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    if (mode) query.set("mode", mode);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const body = object(await apiJson<unknown>(`/api/one/payouts/account/earnings${suffix}`, {
      headers: authHeaders(vaultOwnerToken), cache: "no-store",
    }));
    if (body.currency !== "USD" || !Array.isArray(body.transactions) || body.transactions.length > 20 ||
        !(body.nextCursor === null || (typeof body.nextCursor === "string" && DOCUMENT_REQUEST_UUID.test(body.nextCursor))) ||
        (cursor !== undefined && body.nextCursor === cursor) ||
        // Another mode's rows must never fill this mode's list.
        (body.mode !== undefined && body.mode !== "live" && body.mode !== "test") ||
        (mode !== undefined && body.mode !== undefined && body.mode !== mode)) throw new Error("Invalid earnings response");
    const accountMode = stripeMode(body);
    const transactions = body.transactions.map((value): DocumentEarning => {
      const item = object(value);
      if (typeof item.requestId !== "string" || !DOCUMENT_REQUEST_UUID.test(item.requestId) ||
          typeof item.description !== "string" || !item.description.trim() || item.description.length > 120 ||
          (item.stripeMode !== undefined && !["test", "live", "legacy"].includes(String(item.stripeMode))) ||
          !EARNING_STATUSES.includes(item.status as DocumentEarning["status"]) || !integer(item.grossAmountCents) ||
          !["refundAmountCents", "platformFeeCents", "processingFeeCents", "netAmountCents", "reversedAmountCents", "expectedFiles", "confirmedFiles"].every((key) => nullableInteger(item[key])) ||
          !date(item.createdAt) || !(item.transferredAt === null || date(item.transferredAt)) ||
          (item.settlementMethod !== undefined && !["stripe_transfer", "hashcoins"].includes(String(item.settlementMethod))) ||
          (item.creditedCoins !== undefined && !nullableInteger(item.creditedCoins)) ||
          (item.creditedAt !== undefined && item.creditedAt !== null && !date(item.creditedAt)) ||
          (typeof item.expectedFiles === "number" && typeof item.confirmedFiles === "number" && item.confirmedFiles > item.expectedFiles)) {
        throw new Error("Invalid earnings response");
      }
      return {
        ...(item.stripeMode !== undefined ? { stripeMode: item.stripeMode as DocumentEarning["stripeMode"] } : {}),
        requestId: item.requestId, description: item.description, status: item.status as DocumentEarning["status"],
        grossAmountCents: item.grossAmountCents,
        refundAmountCents: item.refundAmountCents as number | null,
        platformFeeCents: item.platformFeeCents as number | null,
        processingFeeCents: item.processingFeeCents as number | null,
        netAmountCents: item.netAmountCents as number | null,
        reversedAmountCents: item.reversedAmountCents as number | null,
        createdAt: item.createdAt, transferredAt: item.transferredAt as string | null,
        expectedFiles: item.expectedFiles as number | null, confirmedFiles: item.confirmedFiles as number | null,
        ...(item.settlementMethod !== undefined ? { settlementMethod: item.settlementMethod as DocumentEarning["settlementMethod"] } : {}),
        ...(item.creditedCoins !== undefined ? { creditedCoins: item.creditedCoins as number | null } : {}),
        ...(item.creditedAt !== undefined ? { creditedAt: item.creditedAt as string | null } : {}),
      };
    });
    if (new Set(transactions.map((item) => item.requestId)).size !== transactions.length) throw new Error("Invalid earnings response");
    return { ...accountMode, ...(body.mode !== undefined ? { mode: body.mode as "live" | "test" } : {}),
      currency: "USD", transactions, nextCursor: body.nextCursor as string | null };
  }

  /** Newest deposits first, at most 20 a page; `cursor` is the previous page's nextCursor. */
  static async bankPayouts(vaultOwnerToken: string, cursor?: string): Promise<DocumentBankPayoutsResponse> {
    if (cursor !== undefined && !PAGE_CURSOR.test(cursor)) throw new Error("Invalid bank payout cursor");
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const body = object(await apiJson<unknown>(`/api/one/payouts/account/bank-payouts${suffix}`, {
      headers: authHeaders(vaultOwnerToken), cache: "no-store",
    }));
    if (body.currency !== "USD" || !Array.isArray(body.payouts) || body.payouts.length > 20) {
      throw new Error("Invalid bank payout response");
    }
    const payouts = body.payouts.map((value): DocumentBankPayout => {
      const item = object(value);
      if (typeof item.id !== "string" || !item.id || !integer(item.amountCents) ||
          !["pending", "in_transit", "paid", "canceled", "failed"].includes(String(item.status)) ||
          !(item.expectedArrivalAt === null || date(item.expectedArrivalAt)) ||
          !(item.failureCode === null || typeof item.failureCode === "string")) {
        throw new Error("Invalid bank payout response");
      }
      // Additive details read tolerantly; an unreadable one shows as not recorded.
      const at = (key: "createdAt" | "paidAt" | "failedAt") => item[key] === undefined ? {}
        : { [key]: date(item[key]) ? item[key] as string : null };
      const bank = isObject(item.bank) ? { name: label(item.bank.name, 80),
        last4: typeof item.bank.last4 === "string" && /^\d{4}$/.test(item.bank.last4) ? item.bank.last4 : null } : null;
      return { id: item.id, amountCents: item.amountCents, status: item.status as DocumentBankPayout["status"],
        expectedArrivalAt: item.expectedArrivalAt as string | null, failureCode: item.failureCode as string | null,
        ...at("createdAt"), ...at("paidAt"), ...at("failedAt"),
        ...(item.bank !== undefined ? { bank: bank && (bank.name || bank.last4) ? bank : null } : {}),
        ...(item.bankReference !== undefined ? { bankReference: label(item.bankReference, 128) } : {}) };
    });
    // A cursor this build can't send back, or one that repeats, ends the list.
    const next = body.nextCursor;
    return { ...stripeMode(body), currency: "USD", payouts,
      ...(next !== undefined ? { nextCursor: typeof next === "string" && PAGE_CURSOR.test(next) && next !== cursor ? next : null } : {}) };
  }
}
