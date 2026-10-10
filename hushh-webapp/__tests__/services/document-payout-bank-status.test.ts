import { beforeEach, describe, expect, it, vi } from "vitest";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-client", () => ({ apiJson }));

import { DocumentPayoutService } from "@/lib/services/document-payout-service";

describe("aggregate bank payout status", () => {
  beforeEach(() => apiJson.mockReset());

  it("reads signed Stripe payout projections with vault auth", async () => {
    const response = { currency: "USD", payouts: [{
      id: "po_1", amountCents: 911, status: "paid", expectedArrivalAt: null, failureCode: null,
    }] };
    apiJson.mockResolvedValueOnce(response);
    expect(await DocumentPayoutService.bankPayouts("vault")).toEqual(response);
    expect(apiJson).toHaveBeenCalledWith("/api/one/payouts/account/bank-payouts", {
      headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
  });

  it("rejects malformed payout claims", async () => {
    apiJson.mockResolvedValueOnce({ currency: "USD", payouts: [{
      id: "po_1", amountCents: 911, status: "deposited", expectedArrivalAt: null, failureCode: null,
    }] });
    await expect(DocumentPayoutService.bankPayouts("vault")).rejects.toThrow("Invalid bank payout response");
    apiJson.mockResolvedValueOnce({ currency: "USD", payouts: [{
      id: "po_1", amountCents: -1, status: "paid", expectedArrivalAt: null, failureCode: null,
    }] });
    await expect(DocumentPayoutService.bankPayouts("vault")).rejects.toThrow("Invalid bank payout response");
  });
});
