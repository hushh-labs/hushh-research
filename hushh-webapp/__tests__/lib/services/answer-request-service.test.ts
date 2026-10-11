import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnswerRequestService,
  isValidAnswerPriceCents,
  validAnswerPeriod,
  validAnswerRequest,
} from "@/lib/services/answer-request-service";

const apiFetch = vi.fn();
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: (...args: unknown[]) => apiFetch(...args) },
}));

const json = (body: unknown, ok = true) =>
  Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });

beforeEach(() => apiFetch.mockReset());

describe("checkout redirect boundary", () => {
  // The requester is sent to this URL with a card in hand. Anything but a
  // Stripe-hosted checkout is a phishing destination.
  it("accepts only a Stripe-hosted checkout URL", async () => {
    apiFetch.mockReturnValue(json({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1" }));
    await expect(AnswerRequestService.checkout("token", crypto.randomUUID())).resolves.toContain(
      "checkout.stripe.com",
    );
  });

  it.each([
    ["an attacker host", "https://checkout.stripe.com.evil.test/c/pay/cs_test_1"],
    ["a lookalike host", "https://checkout-stripe.com/c/pay/cs_test_1"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a relative path", "/c/pay/cs_test_1"],
    ["an empty value", ""],
  ])("refuses %s", async (_label, url) => {
    apiFetch.mockReturnValue(json({ checkoutUrl: url }));
    await expect(AnswerRequestService.checkout("token", crypto.randomUUID())).rejects.toThrow(
      "Invalid checkout response",
    );
  });
});

describe("payment response validation", () => {
  const view = {
    requestStatus: "approved",
    orderStatus: "awaiting_payment",
    amountCents: 1000,
    currency: "usd",
    checkoutUrl: null,
    paidAt: null,
    refundedAt: null,
    refundReason: null,
    fulfilment: "owner_device",
    answerDeadlineAt: null,
    answerDeadlineHours: 72,
  };

  it("surfaces the device-bound wait so it can be shown before checkout", async () => {
    apiFetch.mockReturnValue(json(view));
    const result = await AnswerRequestService.payment("token", crypto.randomUUID());
    expect(result.fulfilment).toBe("owner_device");
    expect(result.answerDeadlineHours).toBe(72);
  });

  it("rejects a response that drops the fulfilment disclosure", async () => {
    // Negative control: without this check the UI could render a checkout
    // that never tells the requester the answer waits on the owner's device.
    apiFetch.mockReturnValue(json({ ...view, fulfilment: undefined }));
    await expect(AnswerRequestService.payment("token", crypto.randomUUID())).rejects.toThrow(
      "Invalid payment response",
    );
  });

  it("rejects an off-grid price", async () => {
    apiFetch.mockReturnValue(json({ ...view, amountCents: 1050 }));
    await expect(AnswerRequestService.payment("token", crypto.randomUUID())).rejects.toThrow(
      "Invalid payment response",
    );
  });
});

describe("request terms", () => {
  it("treats an absent period as valid and a half-filled one as not", () => {
    expect(validAnswerPeriod(null, null)).toBe(true);
    expect(validAnswerPeriod("2026-01-01", null)).toBe(false);
    expect(validAnswerPeriod(null, "2026-01-01")).toBe(false);
    expect(validAnswerPeriod("2026-02-01", "2026-01-01")).toBe(false);
    expect(validAnswerPeriod("2026-01-01", "2026-02-01")).toBe(true);
  });

  it("requires a question long enough for the owner to judge", () => {
    const terms = (question: string) => ({ question, periodStart: null, periodEnd: null });
    expect(validAnswerRequest(terms("hi"))).toBe(false);
    expect(validAnswerRequest(terms("   "))).toBe(false);
    expect(validAnswerRequest(terms("What are your food preferences?"))).toBe(true);
    expect(validAnswerRequest(terms("x".repeat(2001)))).toBe(false);
  });

  it("enforces the same whole-dollar price grid as the backend", () => {
    expect(isValidAnswerPriceCents(1000)).toBe(true);
    expect(isValidAnswerPriceCents(100)).toBe(true);
    expect(isValidAnswerPriceCents(50_000)).toBe(true);
    expect(isValidAnswerPriceCents(1050)).toBe(false);
    expect(isValidAnswerPriceCents(99)).toBe(false);
    expect(isValidAnswerPriceCents(50_100)).toBe(false);
  });
});
