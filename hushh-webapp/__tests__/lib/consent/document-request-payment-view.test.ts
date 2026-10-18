import { describe, expect, it } from "vitest";

import {
  effectiveRequesterPaymentState,
  parseRequesterPaymentView,
  parseRequesterPriceView,
  presentRequesterPayment,
  requesterPaymentTickMs,
  requesterPaymentWithdrawable,
  type RequesterPaymentView,
} from "@/lib/consent/document-request-payment-view";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import {
  describeFeedDrivePayment,
  formatPaymentRemaining,
  projectFeedDrivePayments,
} from "@/lib/feed/drive-request-payment";

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
    [{ state: "awaiting_owner" as const, nextAction: "wait_owner" as const }, "Waiting for owner setup", "You can pay once they finish setup.", null, "withdraw"],
    [{ state: "preparing" as const, nextAction: "wait_owner" as const }, "No payment due yet", "You pay only if files are found.", null, "withdraw"],
    [{ state: "link_expired" as const, nextAction: "new_request" as const }, "Payment link expired", "Ask the owner again from their profile.", null, "new_request"],
    [{ state: "request_expired" as const, nextAction: "new_request" as const }, "Document request expired", "Ask the owner again from their profile.", null, "new_request"],
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
    expect(presentRequesterPayment(payable, NOW + 1_000).title).toBe("Payment link expired");
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

  it("names the owner in the next step once a request can't be paid", () => {
    const expired = view({ state: "link_expired", nextAction: "new_request" });
    expect(presentRequesterPayment(expired, NOW, { ownerName: "Alex" }).line).toBe("Ask Alex again from their profile.");
    expect(presentRequesterPayment(expired, NOW, { ownerName: "  " }).line).toBe("Ask the owner again from their profile.");
  });

  it("ticks per second only for a countdown, and never for a settled view", () => {
    expect(requesterPaymentTickMs(view())).toBe(1_000);
    expect(requesterPaymentTickMs(view({ state: "awaiting_owner" }))).toBe(30_000);
    expect(requesterPaymentTickMs(view({ state: "link_expired" }))).toBe(30_000);
    expect(requesterPaymentTickMs(view({ state: "preparing", requestExpiresAt: null }))).toBeNull();
    for (const state of ["paid", "refund_pending", "refunded", "partially_refunded", "closed", "none"] as const)
      expect(requesterPaymentTickMs(view({ state }))).toBeNull();
  });

  it("uses the Feed's one countdown formatter", () => {
    expect(presentRequesterPayment(view({ checkoutExpiresAt: at(299_000) }), NOW).remaining)
      .toBe(formatPaymentRemaining(299_000));
  });
});

// 2026-10-18: an autoshare requester read "You pay only if files are found"
// while their order waited for its link. Autoshare asks for payment at Allow
// and refunds what is not sent, so its copy says that, and only that.
describe("presentRequesterPayment for an autoshare request", () => {
  const refund = (status: "queued" | "pending" | "manual_review" | "succeeded", amountCents: number) =>
    ({ status, amountCents });
  it.each([
    [{ state: "preparing" as const, nextAction: "wait_owner" as const, checkoutPending: true },
      "Getting your payment ready", "If nothing matches, you get a full refund.", null, "withdraw"],
    [{ state: "preparing" as const, nextAction: "wait_owner" as const },
      "No payment due yet", "You pay before files are sent. If nothing matches, you get a full refund.", null, "withdraw"],
    [{}, "Payment due", "Files start arriving right after you pay. If nothing matches, you get a full refund.", "29m left", "pay"],
    [{ state: "paid" as const, nextAction: "none" as const }, "Paid $25", null, null, null],
    [{ state: "refund_pending" as const, nextAction: "none" as const, refund: refund("queued", 2500) },
      "Refund of $25 pending", "No files were sent.", null, null],
    [{ state: "refund_pending" as const, nextAction: "none" as const, refund: refund("pending", 833) },
      "Refund of $8.33 pending", "For files not sent.", null, null],
    [{ state: "refund_pending" as const, nextAction: "none" as const, refund: refund("manual_review", 833) },
      "Refund of $8.33 pending", "This is taking longer than usual.", null, null],
    [{ state: "refund_pending" as const, nextAction: "none" as const, withdrawn: true, refund: refund("queued", 2500) },
      "Payment received after you withdrew", "Refund of $25 pending", null, null],
    [{ state: "refunded" as const, nextAction: "none" as const, refund: refund("succeeded", 2500) },
      "Refunded $25", "No files were sent.", null, null],
    [{ state: "partially_refunded" as const, nextAction: "none" as const, refund: refund("succeeded", 833) },
      "Paid $25", "$8.33 refunded for files not sent.", null, null],
    [{ state: "awaiting_owner" as const, nextAction: "wait_owner" as const },
      "Waiting for owner setup", "You can pay once they finish setup.", null, "withdraw"],
    [{ state: "link_expired" as const, nextAction: "new_request" as const },
      "Payment link expired", "Ask the owner again from their profile.", null, "new_request"],
    [{ state: "closed" as const, nextAction: "none" as const }, "Request closed", "Nothing to pay.", null, null],
  ])("presents %o", (overrides, title, line, remaining, action) => {
    expect(presentRequesterPayment(view({ autoshare: true, ...overrides }), NOW))
      .toEqual({ title, line, remaining, action });
  });

  it("gives a refund reason only beside a refund the server reports", () => {
    for (const state of ["paid", "partially_refunded", "refunded", "refund_pending"] as const) {
      const shown = presentRequesterPayment(view({ autoshare: true, state, nextAction: "none", refund: null }), NOW);
      expect(shown.line ?? "").not.toMatch(/sent|refunded/);
    }
  });

  it("keeps an older request's copy, even beside a stray pending link (negative control)", () => {
    expect(presentRequesterPayment(view({ state: "preparing", nextAction: "wait_owner", checkoutPending: true }), NOW))
      .toEqual({ title: "No payment due yet", line: "You pay only if files are found.", remaining: null, action: "withdraw" });
    expect(presentRequesterPayment(view(), NOW).line).toBe("Sharing starts after payment.");
    expect(presentRequesterPayment(view({ state: "refunded", nextAction: "none", refund: refund("succeeded", 2500) }), NOW).line)
      .toBeNull();
    expect(presentRequesterPayment(view({ state: "partially_refunded", nextAction: "none", refund: refund("succeeded", 833) }), NOW).line)
      .toBe("$8.33 refunded");
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

  it("keeps the autoshare marker, and a pending link only while preparing", () => {
    expect(parseRequesterPaymentView({ ...wire, autoshare: true })).toEqual({ ...wire, autoshare: true });
    const preparing = { ...wire, state: "preparing", nextAction: "wait_owner", checkoutExpiresAt: null };
    expect(parseRequesterPaymentView({ ...preparing, autoshare: true, checkoutPending: true }))
      .toMatchObject({ autoshare: true, checkoutPending: true });
    // Without the flow, or outside preparing, a pending link means nothing.
    expect(parseRequesterPaymentView({ ...preparing, checkoutPending: true })).not.toHaveProperty("checkoutPending");
    expect(parseRequesterPaymentView({ ...wire, autoshare: true, checkoutPending: true })).not.toHaveProperty("checkoutPending");
    expect(parseRequesterPaymentView({ ...wire, autoshare: false })).not.toHaveProperty("autoshare");
  });

  it.each([
    ["unknown state", { state: "deposited" }],
    ["sub-cent price", { amountCents: 2550.5 }],
    ["Pay without a deadline", { checkoutExpiresAt: null }],
    ["Pay without a price", { amountCents: null }],
    ["unreadable deadline", { requestExpiresAt: "soon" }],
    ["other currency", { currency: "eur" }],
    ["unknown refund status", { refund: { status: "refunded", amountCents: 100 } }],
    ["oversized refund", { refund: { status: "pending", amountCents: 60_000 } }],
    ["unreadable autoshare marker", { autoshare: "yes" }],
    ["unreadable pending link", { checkoutPending: 1 }],
  ])("fails closed on %s", (_label, change) => {
    expect(parseRequesterPaymentView({ ...wire, ...change })).toBeNull();
  });

  it("parses the price view and rejects other amounts", () => {
    const price = { estimateCents: 1000, currentCents: 2500, finalCents: null, state: "owner_set" };
    expect(parseRequesterPriceView(price)).toEqual(price);
    expect(parseRequesterPriceView({ ...price, currentCents: 9 })).toBeNull();
    expect(parseRequesterPriceView({ ...price, state: "locked" })).toBeNull();
  });
});

describe("Feed and request details", () => {
  function entry(paymentView: RequesterPaymentView): ConsentCenterEntry {
    return {
      id: "document_share_request:11111111-1111-4111-8111-111111111111",
      kind: "outgoing_request",
      status: "pending",
      issued_at: NOW - 60_000,
      counterpart_label: "Alex",
      metadata: {
        direction: "outgoing",
        paymentStatus: "checkout_open",
        paymentAmountCents: 2500,
        paymentCurrency: "usd",
        paymentView,
      },
    } as unknown as ConsentCenterEntry;
  }

  it("ends Pay in the Feed when the request expires inside an open Checkout window", () => {
    const shared = view({ checkoutExpiresAt: at(29 * 60_000), requestExpiresAt: at(7 * 60_000) });
    const [row] = projectFeedDrivePayments([entry(shared)], NOW);
    expect(row).toMatchObject({ status: "ready", requestExpiresAt: NOW + 7 * 60_000 });
    const later = NOW + 7 * 60_000;
    // The Feed's per-second recompute and the details agree on the same tick.
    expect(effectiveRequesterPaymentState(shared, later)).toBe("request_expired");
    expect(describeFeedDrivePayment(row!, later)).toMatchObject({
      status: "expired",
      title: presentRequesterPayment(shared, later).title,
    });
    expect(describeFeedDrivePayment(row!, later - 1).status).toBe("ready");
  });

  it("uses the same words for the same state", () => {
    const states = [
      ["waiting_owner_setup", view({ state: "awaiting_owner", checkoutExpiresAt: null, nextAction: "wait_owner" })],
      ["link_expired", view({ state: "link_expired", checkoutExpiresAt: null, nextAction: "new_request" })],
      ["expired", view({ state: "request_expired", checkoutExpiresAt: null, nextAction: "new_request" })],
    ] as const;
    for (const [status, shared] of states) {
      const [row] = projectFeedDrivePayments([entry(shared)], NOW);
      expect(row?.status).toBe(status);
      expect(row?.title).toBe(presentRequesterPayment(shared, NOW).title);
    }
  });
});
