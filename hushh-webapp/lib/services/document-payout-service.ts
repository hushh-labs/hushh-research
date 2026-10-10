import { apiJson } from "@/lib/services/api-client";

/** Stripe Connect readiness for a US document owner. */
export type DocumentPayoutAccount = {
  detailsSubmitted: boolean;
  transfersEnabled: boolean;
  payoutsEnabled: boolean;
  ready: boolean;
  status: "ready" | "onboarding_required" | "restricted";
};

export type DocumentPayoutAccountResponse = {
  account: DocumentPayoutAccount | null;
};

export type DocumentBankPayout = {
  id: string;
  amountCents: number;
  status: "pending" | "in_transit" | "paid" | "canceled" | "failed";
  expectedArrivalAt: string | null;
  failureCode: string | null;
};

export type DocumentBankPayoutsResponse = {
  currency: "USD";
  payouts: DocumentBankPayout[];
};

const authHeaders = (vaultOwnerToken: string) => ({
  Authorization: `Bearer ${vaultOwnerToken}`,
});

export class DocumentPayoutService {
  static account(vaultOwnerToken: string): Promise<DocumentPayoutAccountResponse> {
    return apiJson("/api/one/payouts/account", {
      headers: authHeaders(vaultOwnerToken),
      cache: "no-store",
    });
  }

  static onboard(vaultOwnerToken: string): Promise<{ url: string }> {
    return apiJson("/api/one/payouts/account/onboard", {
      method: "POST",
      headers: authHeaders(vaultOwnerToken),
    });
  }

  static async bankPayouts(vaultOwnerToken: string): Promise<DocumentBankPayoutsResponse> {
    if (!vaultOwnerToken) throw new Error("Unlock your vault to check bank payouts");
    const response = await apiJson<unknown>("/api/one/payouts/account/bank-payouts", {
      headers: authHeaders(vaultOwnerToken),
      cache: "no-store",
    });
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Invalid bank payout response");
    }
    const body = response as Record<string, unknown>;
    if (body.currency !== "USD" || !Array.isArray(body.payouts) || body.payouts.length > 20) {
      throw new Error("Invalid bank payout response");
    }
    const payouts = body.payouts.map((value): DocumentBankPayout => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid bank payout response");
      }
      const item = value as Record<string, unknown>;
      if (typeof item.id !== "string" || !item.id ||
          typeof item.amountCents !== "number" || !Number.isSafeInteger(item.amountCents) || item.amountCents < 0 ||
          !["pending", "in_transit", "paid", "canceled", "failed"].includes(String(item.status)) ||
          !(item.expectedArrivalAt === null || typeof item.expectedArrivalAt === "string") ||
          !(item.failureCode === null || typeof item.failureCode === "string")) {
        throw new Error("Invalid bank payout response");
      }
      return item as DocumentBankPayout;
    });
    return { currency: "USD", payouts };
  }
}
