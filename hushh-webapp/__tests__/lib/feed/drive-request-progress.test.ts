import { describe, expect, it } from "vitest";

import { projectFeedDriveProgress } from "@/lib/feed/drive-request-progress";
import {
  describeFeedDrivePayment,
  formatPaymentRemaining,
  projectFeedDrivePayments,
} from "@/lib/feed/drive-request-payment";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

const requestId = "document_share_request:123e4567-e89b-12d3-a456-426614174000";

function entry(overrides: Partial<ConsentCenterEntry> = {}): ConsentCenterEntry {
  return {
    id: requestId,
    kind: "incoming_request",
    status: "pending",
    action: "read",
    counterpart_type: "person",
    issued_at: "2026-09-29T10:00:00Z",
    metadata: {
      request_source: "drive_document_share_request",
      direction: "incoming",
      automatic_progress_active: true,
      automatic_progress_stage: "finding",
    },
    ...overrides,
  };
}

describe("projectFeedDriveProgress", () => {
  it("shows a received automatic request without exposing unconfirmed file details", () => {
    const rows = projectFeedDriveProgress([entry({ metadata: {
      ...entry().metadata,
      file_names: ["unconfirmed.pdf"],
      candidate_count: 7,
    } })]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("One is finding documents");
    expect(rows[0]?.href).toContain("requestId=document_share_request");
    expect(rows[0]?.href).not.toContain("requestView=sent");
    expect(JSON.stringify(rows)).not.toMatch(/unconfirmed\.pdf|candidate_count|7 files/i);
  });

  it("routes sent pending requests through the sent view", () => {
    const rows = projectFeedDriveProgress([entry({
      kind: "outgoing_request",
      metadata: { ...entry().metadata, direction: "outgoing", automatic_progress_stage: "preparing" },
    })]);

    expect(rows[0]?.href).toContain("requestView=sent");
    expect(rows[0]?.description).toContain("your Trusted Circle request");
  });

  it("keeps one row after a confirmed grant and opens the active detail", () => {
    const pending = entry();
    const active = entry({ kind: "active_grant", status: "active", metadata: {
      ...entry().metadata,
      automatic_progress_stage: "sharing",
    } });
    const rows = projectFeedDriveProgress([pending, active]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("One is sharing documents");
    expect(rows[0]?.href).toContain("tab=active");
  });

  it("ignores inactive, nonparticipant, malformed and settled entries", () => {
    const rows = projectFeedDriveProgress([
      entry({ metadata: { ...entry().metadata, automatic_progress_active: false } }),
      entry({ metadata: { ...entry().metadata, direction: "unknown" } }),
      entry({ id: "document_share_request:bad-id" }),
      entry({ status: "denied" }),
      entry({ kind: "history", status: "active" }),
    ]);
    expect(rows).toEqual([]);
  });

  it("moves only the requester payment into Needs you, with no sharing progress claim", () => {
    const payment = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "awaiting_payment",
      paymentAmountCents: 1000, paymentCurrency: "usd", file_names: ["private.pdf"],
    } });
    expect(projectFeedDriveProgress([payment])).toEqual([]);
    const rows = projectFeedDrivePayments([payment]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "ready",
      title: "Pay $10 for your document request",
      description: expect.stringContaining("Requested "),
    });
    expect(JSON.stringify(rows)).not.toContain("private.pdf");
    expect(projectFeedDrivePayments([entry({ metadata: payment.metadata })])).toEqual([]);
    expect(projectFeedDrivePayments([entry({ kind: "outgoing_request", metadata: {
      ...payment.metadata, paymentStatus: "paid",
    } })])).toEqual([]);
  });

  it("keeps an abandoned Checkout actionable without claiming sharing progress", () => {
    const payment = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "checkout_open",
      paymentAmountCents: 1000, paymentCurrency: "usd",
    } });
    expect(projectFeedDrivePayments([payment])).toHaveLength(1);
    expect(projectFeedDriveProgress([payment])).toEqual([]);
  });

  it("shows the live payment deadline in compact copy", () => {
    const now = Date.parse("2026-09-29T10:00:00Z");
    const payment = entry({ kind: "outgoing_request", counterpart_label: "V", metadata: {
      ...entry().metadata,
      direction: "outgoing",
      paymentStatus: "checkout_open",
      checkoutExpiresAt: new Date(now + 299_000).toISOString(),
      paymentAmountCents: 1000,
      paymentCurrency: "usd",
    } });
    const row = projectFeedDrivePayments([payment], now)[0];
    expect(row).toMatchObject({
      status: "ready",
      expiresAt: now + 299_000,
      description: expect.stringMatching(/Requested .+ · 5m left/),
    });
    expect(describeFeedDrivePayment(row!, now + 298_500).description).toMatch(/ · 1s left$/);
    expect(formatPaymentRemaining(0)).toBe("0s left");
  });

  it("switches to a renewable link immediately when the local deadline passes", () => {
    const now = Date.parse("2026-09-29T10:00:00Z");
    const payment = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata,
      direction: "outgoing",
      paymentStatus: "checkout_open",
      checkoutExpiresAt: new Date(now + 1_000).toISOString(),
      paymentAmountCents: 1000,
      paymentCurrency: "usd",
    } });
    const row = projectFeedDrivePayments([payment], now)[0]!;
    expect(describeFeedDrivePayment(row, now + 1_001)).toMatchObject({
      status: "link_expired",
      title: "Payment link expired",
    });
  });

  it("names the file owner without exposing file names", () => {
    const payment = entry({ kind: "outgoing_request", counterpart_label: "V", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "awaiting_payment",
      paymentAmountCents: 1000, paymentCurrency: "usd", file_names: ["private.pdf"],
    } });
    const row = projectFeedDrivePayments([payment])[0];
    expect(row).toMatchObject({
      title: "Pay $10 for files from V",
      description: expect.stringContaining("Requested "),
    });
    expect(JSON.stringify(row)).not.toContain("private.pdf");
  });

  it("falls back to concise generic copy for technical identity labels", () => {
    const payment = entry({ kind: "outgoing_request", counterpart_label: "123e4567-e89b-12d3-a456-426614174000", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "awaiting_payment",
      paymentAmountCents: 1000, paymentCurrency: "usd",
    } });
    expect(projectFeedDrivePayments([payment])[0]?.title).toBe("Pay $10 for your document request");
  });

  it("keeps an expired request visible without offering a stale payment action", () => {
    const expired = entry({
      kind: "history",
      status: "expired",
      counterpart_label: "V",
      metadata: {
        ...entry().metadata,
        direction: "outgoing",
        paymentStatus: "awaiting_payment",
        paymentAmountCents: 1000,
        paymentCurrency: "usd",
      },
    });
    const row = projectFeedDrivePayments([expired])[0];
    expect(row).toMatchObject({
      status: "expired",
      title: "Document request expired",
      description: expect.stringMatching(/From V · Requested /),
    });
    expect(row?.href).toContain("tab=previous");
  });

  it("marks an expired Stripe link separately so it can be recreated", () => {
    const payment = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata,
      direction: "outgoing",
      paymentStatus: "checkout_open",
      paymentLinkExpired: true,
      paymentAmountCents: 1000,
      paymentCurrency: "usd",
    } });
    expect(projectFeedDrivePayments([payment])[0]).toMatchObject({
      status: "link_expired",
      title: "Payment link expired",
      description: expect.stringContaining("Requested "),
    });
  });

  it("treats a legacy expired payment status as a renewable link while pending", () => {
    const payment = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata,
      direction: "outgoing",
      paymentStatus: "expired",
      paymentAmountCents: 1000,
      paymentCurrency: "usd",
    } });
    expect(projectFeedDrivePayments([payment])[0]?.status).toBe("link_expired");
  });

  it("does not resurrect a paid order from its historical Checkout deadline", () => {
    const payment = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata,
      direction: "outgoing",
      paymentStatus: "paid",
      paymentLinkExpired: true,
      checkoutExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      paymentAmountCents: 1000,
      paymentCurrency: "usd",
    } });
    expect(projectFeedDrivePayments([payment])).toEqual([]);
  });

  it("does not resurrect an older payment row beside a settled duplicate", () => {
    const awaiting = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "awaiting_payment",
      paymentAmountCents: 1000, paymentCurrency: "usd",
    } });
    const paid = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "paid",
      paymentAmountCents: 1000, paymentCurrency: "usd",
    } });
    expect(projectFeedDrivePayments([awaiting, paid])).toEqual([]);
    expect(projectFeedDrivePayments([paid, awaiting])).toEqual([]);
  });

  it("keeps one concise payment row per request", () => {
    const first = entry({ id: "document_share_request:11111111-1111-4111-8111-111111111111", kind: "outgoing_request", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "awaiting_payment",
      paymentAmountCents: 1000, paymentCurrency: "usd",
    } });
    const second = entry({ id: "document_share_request:22222222-2222-4222-8222-222222222222", kind: "outgoing_request", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "awaiting_payment",
      paymentAmountCents: 1000, paymentCurrency: "usd",
    } });
    expect(projectFeedDrivePayments([first, second])).toHaveLength(2);
  });

  it("distinguishes two same-owner payments with only the requester-authored purpose", () => {
    const now = Date.parse("2026-09-29T10:00:00Z");
    const payment = projectFeedDrivePayments([entry({
      kind: "outgoing_request", counterpart_label: "V", metadata: {
        ...entry().metadata, direction: "outgoing", paymentStatus: "checkout_open",
        paymentAmountCents: 1000, paymentCurrency: "usd",
        checkoutExpiresAt: new Date(now + 300_000).toISOString(),
        purpose: "Untrusted projection text", file_names: ["private.pdf"],
      },
    })], now)[0]!;
    const context = { requestId: payment.requestId, purpose: {
      purpose: "Standup notes", periodStart: "2026-09-01", periodEnd: "2026-09-08",
    } };
    const first = describeFeedDrivePayment(payment, now, context);
    const second = describeFeedDrivePayment(payment, now, {
      ...context, purpose: { ...context.purpose, purpose: "Project budget" },
    });
    expect(first.title).toBe("Pay $10 · Standup notes");
    expect(second.title).toBe("Pay $10 · Project budget");
    expect(first.description).toMatch(/^From V · .+2026.+ · 5m left$/);
    const expired = describeFeedDrivePayment(payment, now + 300_001, context);
    expect(expired.title).toBe("Payment link expired");
    expect(expired.description).toContain("Standup notes · From V");
    expect(JSON.stringify([first, second, expired])).not.toMatch(/private.pdf|Untrusted projection/);
    const long = describeFeedDrivePayment(payment, now, {
      ...context, purpose: { ...context.purpose, purpose: "long ".repeat(80) },
    });
    expect(long.title.length).toBeLessThanOrEqual(82);
    expect(long.title).toMatch(/…$/);
  });

  it("does not claim sharing progress during paid payment reconciliation", () => {
    const payment = entry({ kind: "outgoing_request", metadata: {
      ...entry().metadata, direction: "outgoing", paymentStatus: "paid",
      paymentReconciliationRequired: true,
    } });
    expect(projectFeedDriveProgress([payment])).toEqual([]);
  });
});
