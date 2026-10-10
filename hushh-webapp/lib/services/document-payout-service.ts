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
export type DocumentBankPayoutsResponse = { currency: "USD"; payouts: DocumentBankPayout[] };

const EARNING_STATUSES = ["awaiting_delivery", "awaiting_refund", "awaiting_fee", "awaiting_account",
  "due", "dispatching", "unknown", "manual_review", "transferred", "reversal_due",
  "reversal_unknown", "reversed", "void"] as const;
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
function connectLink(value: unknown): { url: string } {
  const body = object(value);
  if (typeof body.url !== "string") throw new Error("Invalid payout link");
  const url = new URL(body.url);
  if (url.protocol !== "https:" || url.hostname !== "connect.stripe.com" ||
      url.username || url.password || url.port) throw new Error("Invalid payout link");
  return { url: url.href };
}

export class DocumentPayoutService {
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
    }));
  }

  static async manage(vaultOwnerToken: string): Promise<{ url: string }> {
    return connectLink(await apiJson<unknown>("/api/one/payouts/account/manage", {
      method: "POST", headers: authHeaders(vaultOwnerToken), cache: "no-store",
    }));
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
    return { currency: "USD", payouts };
  }
}
