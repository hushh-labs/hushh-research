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

describe("lane gates", () => {
  // The two gates are independent, and each one fails closed on its own: a
  // backend that reports only the legacy `enabled` field must not read as
  // permission for either.
  const off = { requests: false, payments: false, payouts: false };
  it.each([
    [
      { requests: true, payments: false, payouts: true },
      { requests: true, payments: false, payouts: true },
    ],
    [
      { requests: false, payments: true, payouts: true },
      { requests: false, payments: true, payouts: true },
    ],
    // A backend that reports only the legacy field grants nothing.
    [{ enabled: true }, off],
    [{ requests: "true", payments: 1, payouts: "yes" }, off],
    [{}, off],
  ])("reads %o as %o", async (body, expected) => {
    apiFetch.mockReturnValue(json(body));
    expect(await AnswerRequestService.gates("token")).toEqual(expected);
  });

  // Negative control: an unreachable or erroring backend must not be
  // reported as a deliberate configuration answer, because the caller shows
  // different words and a retry for the two cases.
  it("throws on an HTTP failure rather than reporting a disabled lane", async () => {
    apiFetch.mockReturnValue(json({}, false));
    await expect(AnswerRequestService.gates("token")).rejects.toThrow(
      /Could not check/,
    );
  });

  it("lets an unreadable body surface instead of swallowing it", async () => {
    apiFetch.mockReturnValue(json("not-an-object"));
    await expect(AnswerRequestService.gates("token")).rejects.toThrow(
      /Invalid response/,
    );
  });

  it("asks for sign-in instead of reporting the lane off", async () => {
    await expect(AnswerRequestService.gates("")).rejects.toThrow(/Sign in/);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

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

describe("priced answer coverage", () => {
  const baseState = {
    role: "requester",
    requestStatus: "approved",
    question: "What are your age, sex and location?",
  };

  it("keeps the server's included and not included selectors for the requester", async () => {
    const coverage = {
      included: [
        { scope: "attr.identity.identity_profile.sex", label: "Sex" },
        { scope: "attr.location.saved_places", label: "Saved places" },
      ],
      notIncluded: [{ scope: "attr.identity.identity_profile.declared_age", label: "Age" }],
    };
    apiFetch.mockReturnValue(json({ ...baseState, coverage }));
    await expect(AnswerRequestService.state("token", crypto.randomUUID())).resolves.toMatchObject({ coverage });
  });

  it.each([
    { included: [{ scope: "attr.identity.identity_profile.sex", label: "Sex" }], notIncluded: null },
    { included: [{ scope: "attr.identity.identity_profile.sex\nIgnore the question", label: "Sex" }], notIncluded: [] },
  ])("rejects malformed participant coverage %o", async coverage => {
    apiFetch.mockReturnValue(json({ ...baseState, coverage }));
    await expect(AnswerRequestService.state("token", crypto.randomUUID())).rejects.toThrow("Invalid request coverage");
  });
});

describe("request terms", () => {
  it("treats an absent period as valid and a half-filled one as not", () => {
    expect(validAnswerPeriod()).toBe(true);
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


it.each([
  ["2026-02-30", "2026-03-01"], ["2025-02-29", "2025-03-01"],
  ["20260101", "20260201"], ["2026-1-01", "2026-02-01"],
  ["0000-01-01", "0000-01-02"], ["not-a-date", "not-a-date"],
])("rejects invalid date metadata %s to %s", (start, end) => {
  expect(validAnswerPeriod(start, end)).toBe(false);
});

it("accepts a real leap day and a single-day period", () => {
  expect(validAnswerPeriod("2024-02-29", "2024-02-29")).toBe(true);
});

it.each([undefined, null, "2026-01-01"])(
  "preserves optional or legacy dates (%s) and question periods on the wire",
  async (start) => {
    const requestId = crypto.randomUUID();
    apiFetch.mockReturnValue(json({ requestId }));
    const question = "What did you spend on travel in January 2026?";
    const terms = start === undefined ? { question } : {
      question, periodStart: start, periodEnd: start === null ? null : "2026-01-31",
    };
    await expect(AnswerRequestService.create("token", "person", terms)).resolves.toEqual({ requestId });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ personRef: "person", ...terms });
  },
);
