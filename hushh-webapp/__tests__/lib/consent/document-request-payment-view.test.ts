import { describe, expect, it } from "vitest";

import {
  effectiveRequesterPaymentState,
  parseRequesterPaymentView,
  parseRequesterPriceView,
  presentRequesterPayment,
  requesterPaymentWithdrawable,
  type RequesterPaymentView,
} from "@/lib/consent/document-request-payment-view";
import { formatPaymentRemaining } from "@/lib/feed/drive-request-payment";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function view(overrides: Partial<RequesterPaymentView> = {}): RequesterPaymentView {
  return {
    state: "payable",
    amountCents: 2500,
    currency: "usd",
    checkoutExpiresAt: at(29 * 60_000),
    requestExpiresAt: at(3 * 86_400_000),
    refund: null,
    nextAction: "pay",
    withdrawn: false,
    ...overrides,
  };
}

describe("presentRequesterPayment", () => {
  it.each([
    [{}, "Payment due", "Sharing starts after payment.", "29m left", "pay"],
    [{ state: "awaiting_owner" as const, nextAction: "wait_owner" as const }, "Waiting for the owner", "You can pay once they finish setup.", null, "withdraw"],
    [{ state: "preparing" as const, nextAction: "wait_owner" as const }, "No payment due yet", "You pay only if files are found.", null, "withdraw"],
    [{ state: "link_expired" as const, nextAction: "new_request" as const }, "Payment window closed", "Send a new request to try again.", null, "new_request"],
    [{ state: "request_expired" as const, nextAction: "new_request" as const }, "Request expired", "Send a new request to try again.", null, "new_request"],
    [{ state: "paid" as const, nextAction: "none" as const }, "Paid $25", null, null, null],
    [
      { state: "refund_pending" as const, nextAction: "none" as const, withdrawn: true, refund: { status: "queued" as const, amountCents: 2500 } },
      "Payment received after you withdrew", "Refund of $25 pending", null, null,
    ],
    [
      { state: "refund_pending" as const, nextAction: "none" as const, refund: { status: "manual_review" as const, amountCents: 833 } },
      "Refund of $8.33 pending", "This is taking longer than usual.", null, null,
    ],
    [{ state: "refunded" as const, nextAction: "none" as const, refund: { status: "succeeded" as const, amountCents: 2500 } }, "Refunded $25", null, null, null],
    [
      { state: "partially_refunded" as const, nextAction: "none" as const, refund: { status: "succeeded" as const, amountCents: 833 } },
      "Paid $25", "$8.33 refunded", null, null,
    ],
    [{ state: "closed" as const, nextAction: "none" as const, withdrawn: true }, "Request withdrawn", null, null, null],
    [{ state: "closed" as const, nextAction: "none" as const }, "Request closed", "Nothing to pay.", null, null],
    [{ state: "none" as const, nextAction: "none" as const, amountCents: null }, "", null, null, null],
  ])("presents %o", (overrides, title, line, remaining, action) => {
    const shown = presentRequesterPayment(view(overrides), NOW);
    expect(shown).toEqual({ title, line, remaining, action });
    // Copy rules: a changeable price is never "locked"; unknown is never refunded.
    expect(JSON.stringify(shown)).not.toMatch(/locked|deposit/i);
  });

  it("closes the payment window at its exact deadline, on the device clock", () => {
    const payable = view({ checkoutExpiresAt: at(1_000) });
    expect(presentRequesterPayment(payable, NOW + 999).remaining).toBe("1s left");
    expect(effectiveRequesterPaymentState(payable, NOW + 1_000)).toBe("link_expired");
    expect(presentRequesterPayment(payable, NOW + 1_000).title).toBe("Payment window closed");
    // A payable view without a deadline never offers Pay.
    expect(effectiveRequesterPaymentState(view({ checkoutExpiresAt: null }), NOW)).toBe("link_expired");
  });

  it("lets the request deadline win over an open payment window", () => {
    const expiring = view({ requestExpiresAt: at(60_000) });
    expect(effectiveRequesterPaymentState(expiring, NOW + 59_999)).toBe("payable");
    expect(effectiveRequesterPaymentState(expiring, NOW + 60_000)).toBe("request_expired");
    expect(effectiveRequesterPaymentState(view({ state: "link_expired", requestExpiresAt: at(0) }), NOW))
      .toBe("request_expired");
    // A settled payment keeps its state past any deadline.
    expect(effectiveRequesterPaymentState(view({ state: "paid", requestExpiresAt: at(-1) }), NOW)).toBe("paid");
  });

  it("offers Withdraw only before payment and while the request is open", () => {
    expect(requesterPaymentWithdrawable(view(), NOW)).toBe(true);
    expect(requesterPaymentWithdrawable(view({ state: "link_expired" }), NOW)).toBe(true);
    expect(requesterPaymentWithdrawable(view({ state: "paid" }), NOW)).toBe(false);
    expect(requesterPaymentWithdrawable(view({ state: "closed", withdrawn: true }), NOW)).toBe(false);
    expect(requesterPaymentWithdrawable(view({ requestExpiresAt: at(-1) }), NOW)).toBe(false);
  });

  it("uses the Feed's one countdown formatter", () => {
    expect(presentRequesterPayment(view({ checkoutExpiresAt: at(299_000) }), NOW).remaining)
      .toBe(formatPaymentRemaining(299_000));
  });
});

describe("parseRequesterPaymentView", () => {
  const wire = {
    state: "payable",
    amountCents: 2500,
    currency: "usd",
    checkoutExpiresAt: at(60_000),
    requestExpiresAt: at(86_400_000),
    refund: null,
    nextAction: "pay",
    withdrawn: false,
  };

  it("keeps a valid view and drops a deadline that is not for paying", () => {
    expect(parseRequesterPaymentView(wire)).toEqual(wire);
    expect(parseRequesterPaymentView({ ...wire, state: "paid", nextAction: "none" })?.checkoutExpiresAt).toBeNull();
    // Older servers omit the withdrawal flag.
    const { withdrawn: _omitted, ...legacy } = wire;
    expect(parseRequesterPaymentView(legacy)?.withdrawn).toBe(false);
  });

  it.each([
    ["unknown state", { state: "deposited" }],
    ["fractional price", { amountCents: 2550 }],
    ["Pay without a deadline", { checkoutExpiresAt: null }],
    ["Pay without a price", { amountCents: null }],
    ["unreadable deadline", { requestExpiresAt: "soon" }],
    ["other currency", { currency: "eur" }],
    ["unknown refund status", { refund: { status: "refunded", amountCents: 100 } }],
    ["oversized refund", { refund: { status: "pending", amountCents: 60_000 } }],
  ])("fails closed on %s", (_label, change) => {
    expect(parseRequesterPaymentView({ ...wire, ...change })).toBeNull();
  });

  it("parses the price view and rejects other amounts", () => {
    const price = { estimateCents: 1000, currentCents: 2500, finalCents: null, state: "owner_set" };
    expect(parseRequesterPriceView(price)).toEqual(price);
    expect(parseRequesterPriceView({ ...price, currentCents: 2550 })).toBeNull();
    expect(parseRequesterPriceView({ ...price, state: "locked" })).toBeNull();
  });
});
