import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { apiJson } from "@/lib/services/api-client";

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
};
export type DocumentPayoutAccountResponse = { account: DocumentPayoutAccount | null; stripeMode?: "test" | "live" };
export type DocumentBankPayout = {
  id: string;
  amountCents: number;
  status: "pending" | "in_transit" | "paid" | "canceled" | "failed";
  expectedArrivalAt: string | null;
  failureCode: string | null;
};
export type DocumentBankPayoutsResponse = { currency: "USD"; payouts: DocumentBankPayout[]; stripeMode?: "test" | "live" };

export type HashcoinBalance = {
  balanceCoins: number; reservedCoins: number; availableCoins: number; amountCents: number; held: boolean;
};
export type HashcoinRedemption = {
  id: string; clientRequestId?: string; amountCoins: number;
  status: "pending" | "succeeded" | "failed" | "unknown"; stripeMode: "test";
  createdAt?: string;
};
export type HashcoinWallet = {
  coinName: "Hussh Coins"; coinsPerDollar: 100; currency: "USD";
  live: HashcoinBalance; sandbox: HashcoinBalance;
  payoutMode: "test"; liveRedemptionEnabled: false;
  maxRedeemCoins: number;
  latestRedemption: HashcoinRedemption | null;
  redemptionHistory: HashcoinRedemption[];
};

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
export type DocumentEarningsResponse = { currency: "USD"; transactions: DocumentEarning[]; nextCursor: string | null; stripeMode?: "test" | "live" };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid payout response");
  return value as Record<string, unknown>;
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

function coinBalance(value: unknown): HashcoinBalance {
  const row = object(value);
  if (!["reservedCoins", "availableCoins"].every((key) => integer(row[key])) ||
      !Number.isSafeInteger(row.balanceCoins) || !Number.isSafeInteger(row.amountCents) ||
      typeof row.held !== "boolean" || row.amountCents !== row.balanceCoins || (Number(row.balanceCoins) < 0 && row.held !== true) ||
      row.availableCoins !== (row.held ? 0 : Math.max(Number(row.balanceCoins) - Number(row.reservedCoins), 0))) {
    throw new Error("Invalid Hussh Coins balance");
  }
  return { balanceCoins: row.balanceCoins as number, reservedCoins: row.reservedCoins as number,
    availableCoins: row.availableCoins as number, amountCents: row.amountCents as number, held: row.held };
}

function redemption(value: unknown): HashcoinRedemption {
  const row = object(value);
  if (typeof row.id !== "string" || !DOCUMENT_REQUEST_UUID.test(row.id) ||
      !integer(row.amountCoins) || row.amountCoins < 1 || row.stripeMode !== "test" ||
      !["pending", "succeeded", "failed", "unknown"].includes(String(row.status)) ||
      (row.createdAt !== undefined && !date(row.createdAt)) ||
      (row.clientRequestId !== undefined && (typeof row.clientRequestId !== "string" || !DOCUMENT_REQUEST_UUID.test(row.clientRequestId)))) {
    throw new Error("Invalid Hussh Coins redemption");
  }
  return { id: row.id, amountCoins: row.amountCoins, status: row.status as HashcoinRedemption["status"],
    stripeMode: "test", ...(row.clientRequestId ? { clientRequestId: row.clientRequestId as string } : {}),
    ...(row.createdAt ? { createdAt: row.createdAt as string } : {}) };
}

export class DocumentPayoutService {
  static async hashcoins(vaultOwnerToken: string): Promise<HashcoinWallet> {
    const body = object(await apiJson<unknown>("/api/one/payouts/hashcoins", {
      headers: authHeaders(vaultOwnerToken), cache: "no-store",
    }));
    if (body.coinName !== "Hussh Coins" || body.coinsPerDollar !== 100 || body.currency !== "USD" ||
        body.payoutMode !== "test" || body.liveRedemptionEnabled !== false ||
        (body.maxRedeemCoins !== undefined && (!integer(body.maxRedeemCoins) || body.maxRedeemCoins < 1)) ||
        (body.redemptionHistory !== undefined && (!Array.isArray(body.redemptionHistory) || body.redemptionHistory.length > 10))) throw new Error("Invalid Hussh Coins wallet");
    return { coinName: "Hussh Coins", coinsPerDollar: 100, currency: "USD", live: coinBalance(body.live),
      sandbox: coinBalance(body.sandbox), payoutMode: "test", liveRedemptionEnabled: false,
      maxRedeemCoins: body.maxRedeemCoins as number ?? 50000,
      redemptionHistory: ((body.redemptionHistory as unknown[]) ?? []).map(redemption),
      latestRedemption: body.latestRedemption == null ? null : redemption(body.latestRedemption) };
  }

  static async redeemTest(vaultOwnerToken: string, amountCoins: number, clientRequestId: string): Promise<HashcoinRedemption> {
    if (!integer(amountCoins) || amountCoins < 1 || !DOCUMENT_REQUEST_UUID.test(clientRequestId)) throw new Error("Invalid test redemption");
    return redemption(await apiJson<unknown>("/api/one/payouts/hashcoins/redeem", {
      method: "POST", headers: { ...authHeaders(vaultOwnerToken), "Content-Type": "application/json" },
      body: JSON.stringify({ amountCoins, clientRequestId, mode: "test" }), cache: "no-store",
    }));
  }

  static async account(vaultOwnerToken: string): Promise<DocumentPayoutAccountResponse> {
    const body = object(await apiJson<unknown>("/api/one/payouts/account", {
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
    return { ...mode, account: {
      ...(bank !== undefined ? { bank } : {}),
      ...(account.bankStatus !== undefined ? { bankStatus: account.bankStatus as DocumentPayoutAccount["bankStatus"] } : {}),
      ...(account.canManageBank !== undefined ? { canManageBank: account.canManageBank as boolean } : {}),
      detailsSubmitted: account.detailsSubmitted as boolean,
      transfersEnabled: account.transfersEnabled as boolean,
      payoutsEnabled: account.payoutsEnabled as boolean,
      ready: account.ready as boolean,
      status: account.status as DocumentPayoutAccount["status"],
    } };
  }

  static async onboard(vaultOwnerToken: string): Promise<{ url: string }> {
    return connectLink(await apiJson<unknown>("/api/one/payouts/account/onboard", {
      method: "POST", headers: authHeaders(vaultOwnerToken), cache: "no-store",
    }), "onboarding");
  }

  static async manage(vaultOwnerToken: string): Promise<{ url: string }> {
    return connectLink(await apiJson<unknown>("/api/one/payouts/account/manage", {
      method: "POST", headers: authHeaders(vaultOwnerToken), cache: "no-store",
    }), "management");
  }

  static async earnings(vaultOwnerToken: string, cursor?: string): Promise<DocumentEarningsResponse> {
    if (cursor !== undefined && !DOCUMENT_REQUEST_UUID.test(cursor)) throw new Error("Invalid earnings cursor");
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const body = object(await apiJson<unknown>(`/api/one/payouts/account/earnings${suffix}`, {
      headers: authHeaders(vaultOwnerToken), cache: "no-store",
    }));
    if (body.currency !== "USD" || !Array.isArray(body.transactions) || body.transactions.length > 20 ||
        !(body.nextCursor === null || (typeof body.nextCursor === "string" && DOCUMENT_REQUEST_UUID.test(body.nextCursor))) ||
        (cursor !== undefined && body.nextCursor === cursor)) throw new Error("Invalid earnings response");
    const mode = stripeMode(body);
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
    return { ...mode, currency: "USD", transactions, nextCursor: body.nextCursor as string | null };
  }

  static async bankPayouts(vaultOwnerToken: string): Promise<DocumentBankPayoutsResponse> {
    const body = object(await apiJson<unknown>("/api/one/payouts/account/bank-payouts", {
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
      return { id: item.id, amountCents: item.amountCents, status: item.status as DocumentBankPayout["status"],
        expectedArrivalAt: item.expectedArrivalAt as string | null, failureCode: item.failureCode as string | null };
    });
    return { ...stripeMode(body), currency: "USD", payouts };
  }
}
