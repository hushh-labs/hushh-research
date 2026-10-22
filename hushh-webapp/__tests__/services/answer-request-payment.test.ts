import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch } }));

import { AnswerRequestService } from "@/lib/services/answer-request-service";

const REQUEST = "11111111-2222-4333-8444-555555555555";
const prepared = {
  requestStatus: "approved", orderStatus: "checkout_open", amountCents: 1000,
  currency: "usd", checkoutUrl: null, paidAt: null, refundedAt: null,
  refundReason: null, fulfilment: "owner_device", answerDeadlineAt: null,
  answerDeadlineHours: 72, preparationStatus: "ready", reconciliationRequired: false,
};
const respond = (value: unknown) => new Response(JSON.stringify(value));

beforeEach(() => apiFetch.mockReset());

describe("Request scope payment status through the real client method", () => {
  it("reads its own authenticated payment endpoint without a presentation cache", async () => {
    apiFetch.mockResolvedValueOnce(respond(prepared));
    expect(await AnswerRequestService.payment("requester-token", REQUEST)).toMatchObject(prepared);
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith(`/api/one/answer-requests/${REQUEST}/payment`, {
      method: "GET", cache: "no-store", headers: { Authorization: "Bearer requester-token" },
    });
  });

  it.each([undefined, "unknown", true])("fails closed on unproven preparation (%s)", async (preparationStatus) => {
    apiFetch.mockResolvedValueOnce(respond({ ...prepared, preparationStatus, reconciliationRequired: undefined }));
    const view = await AnswerRequestService.payment("requester-token", REQUEST);
    expect(view.preparationStatus).toBe("preparing");
    expect(view.reconciliationRequired).toBe(true);
  });

  it.each([
    { requestStatus: "success" }, { orderStatus: "success" }, { orderStatus: undefined },
    { orderStatus: "paid", paidAt: null }, { orderStatus: "paid", paidAt: "not-a-date" },
    { orderStatus: "refunded", paidAt: null },
  ])("rejects a status that cannot prove settlement: %o", async (invalid) => {
    apiFetch.mockResolvedValueOnce(respond({ ...prepared, ...invalid }));
    await expect(AnswerRequestService.payment("requester-token", REQUEST)).rejects.toThrow("Invalid payment response");
  });

  it("accepts verified payment separately from completed answer delivery", async () => {
    apiFetch.mockResolvedValueOnce(respond({ ...prepared, orderStatus: "paid", requestStatus: "answering",
      paidAt: "2026-10-13T08:00:00Z" }));
    const view = await AnswerRequestService.payment("requester-token", REQUEST);
    expect(view.orderStatus).toBe("paid");
    expect(view.requestStatus).toBe("answering");
    expect(view.reconciliationRequired).toBe(false);
  });

  it("surfaces unavailable reads and permits a later authoritative retry", async () => {
    apiFetch.mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(respond(prepared));
    await expect(AnswerRequestService.payment("requester-token", REQUEST)).rejects.toThrow("Payment is unavailable");
    await expect(AnswerRequestService.payment("requester-token", REQUEST)).resolves.toMatchObject({ preparationStatus: "ready" });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["", "not-a-request-id"])("refuses an invalid request reference before reading (%s)", async (requestId) => {
    await expect(AnswerRequestService.payment("requester-token", requestId)).rejects.toThrow("Invalid request ID");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
