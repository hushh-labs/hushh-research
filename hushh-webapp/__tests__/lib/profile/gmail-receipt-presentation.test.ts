import { describe, expect, it } from "vitest";

import {
  buildReceiptLogoUrl,
  buildRecentReceiptRows,
  formatReceiptAmount,
  formatReceiptPassage,
  resolveReceiptMerchant,
  summarizeRecentReceiptRows,
} from "@/lib/profile/gmail-receipt-presentation";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

function receipt(
  id: number,
  overrides: Partial<ReceiptListItem> = {},
): ReceiptListItem {
  return {
    id,
    source_id: `gmail_live_source_${id}`,
    source_kind: "gmail_live",
    gmail_message_id: `message-${id}`,
    from_email: "orders@myntra.com",
    merchant_name: "Myntra",
    merchant_domain: "myntra.com",
    order_id: `ORDER-${id}`,
    subject: "Your order is confirmed",
    event_type: "purchase",
    amount: 49.99,
    currency: "INR",
    ...overrides,
  };
}

describe("Gmail receipt presentation", () => {
  it("selects an invoice over fulfillment and merges typed identifiers without changing sources", () => {
    const records = [
      receipt(1, { document_kind: "fulfillment", event_type: "fulfillment", identifiers: [{ kind: "order", value: "A-10" }] }),
      receipt(2, { document_kind: "invoice", identifiers: [{ kind: "order", value: "A-10" }, { kind: "invoice", value: "INV-8" }] }),
      receipt(3, { document_kind: "receipt", identifiers: [{ kind: "invoice", value: "INV-8" }, { kind: "payment", value: "PAY-1" }] }),
      receipt(4, { document_kind: "invoice", identifiers: [{ kind: "order", value: "B-20" }] }),
      receipt(5, { event_type: "refund", identifiers: [{ kind: "order", value: "A-10" }] }),
      receipt(6, { event_type: "cancellation", identifiers: [{ kind: "order", value: "A-10" }] }),
    ];
    const snapshot = JSON.stringify(records);
    const rows = buildRecentReceiptRows(records, "owner");
    expect(rows).toHaveLength(4);
    expect(rows[0]?.primaryReceiptKey).toBe("gmail_live_source_2");
    expect(rows[0]?.identifiers).toHaveLength(3);
    expect(rows[0]?.sourceReceiptIds).toEqual([1, 2, 3]);
    expect(JSON.stringify(records)).toBe(snapshot);
  });

  it("never bridges two different orders through a shared payment reference", () => {
    const rows = buildRecentReceiptRows([
      receipt(1, { identifiers: [{ kind: "order", value: "A" }, { kind: "payment", value: "P" }] }),
      receipt(2, { identifiers: [{ kind: "order", value: "B" }, { kind: "payment", value: "P" }] }),
      receipt(3, { identifiers: [{ kind: "payment", value: "P" }] }),
    ], "owner");
    expect(rows).toHaveLength(3);
  });

  it("never bridges conflicting invoice identities through a shared payment reference", () => {
    const rows = buildRecentReceiptRows([
      receipt(1, { identifiers: [{ kind: "invoice", value: "INV-A" }, { kind: "payment", value: "PAY-1" }] }),
      receipt(2, { identifiers: [{ kind: "invoice", value: "INV-B" }, { kind: "payment", value: "PAY-1" }] }),
    ], "owner");
    expect(rows).toHaveLength(2);
  });

  it("uses strict financial-document priority for the canonical source", () => {
    const [row] = buildRecentReceiptRows([
      receipt(1, { document_kind: "payment_confirmation", identifiers: [{ kind: "order", value: "A" }] }),
      receipt(2, { document_kind: "receipt", identifiers: [{ kind: "order", value: "A" }] }),
      receipt(3, { document_kind: "invoice", identifiers: [{ kind: "order", value: "A" }] }),
    ], "owner");
    expect(row.primaryReceiptKey).toBe("gmail_live_source_3");
  });

  it("merges canonical status, prioritizes attention and summarizes transactions", () => {
    const rows = buildRecentReceiptRows([
      receipt(1, {
        document_kind: "invoice",
        identifiers: [{ kind: "order", value: "A" }],
        status: "paid",
        gmail_internal_date: "2026-09-01T09:00:00Z",
        category: "Shopping",
        category_confidence: 0.95,
      }),
      receipt(2, {
        document_kind: "fulfillment",
        identifiers: [{ kind: "order", value: "A" }],
        status: "delivered",
        event_type: "fulfillment",
        gmail_internal_date: "2026-09-03T09:00:00Z",
      }),
      receipt(3, {
        order_id: "B",
        status: "payment_failed",
        attention_state: "needs_attention",
        attention_reason: "payment_failed",
        category: "Software & Subscriptions",
        category_confidence: 0.95,
      }),
      receipt(4, {
        order_id: "C",
        status: "renewal_due",
        recurrence: "recurring",
        attention_state: "coming_up",
        attention_reason: "renewal_due",
        attention_is_prediction: true,
      }),
    ], "owner");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      status: "payment_failed",
      attentionState: "needs_attention",
    });
    expect(rows[1].secondaryText).toContain("Predicted");
    expect(rows[2]).toMatchObject({ status: "delivered", sourceReceiptIds: [1, 2] });
    expect(summarizeRecentReceiptRows(rows)).toEqual({
      paid: 0,
      attention: 1,
      upcoming: 1,
      missingAmount: 0,
      hasData: true,
    });
  });

  it("keeps explicit refund/cancellation status separate even with a conflicting purchase event", () => {
    expect(buildRecentReceiptRows([
      receipt(1, { order_id: "SAME" }),
      receipt(2, { order_id: "SAME", status: "refunded" }),
      receipt(3, { order_id: "SAME", status: "cancelled" }),
    ], "owner")).toHaveLength(3);
  });

  it("cleans emphasis without changing quoted amounts or dates", () => {
    expect(formatReceiptPassage("Invoice with **$124.01 due since October 2**."))
      .toBe("Invoice with $124.01 due since October 2.");
  });
  it("presents only backend detail, status and date without inferring paid from purchase", () => {
    const [row] = buildRecentReceiptRows([receipt(1, {
      category: "Subscription", category_confidence: 0.95,
      short_detail: "Monthly software membership", status: "paid",
      receipt_date: "2026-09-18T12:00:00Z",
      identifier_kind: "invoice", identifier_value: "INV-20",
    })], "account");
    expect(row.secondaryText).toContain("Subscription · Paid ·");
    expect(row.searchText).toContain("INV-20");
    const [missing] = buildRecentReceiptRows([receipt(2)], "account");
    expect(missing.secondaryText).not.toContain("Paid");
  });

  it("uses the backend merchant label and resolves branding only from its reviewed merchant domain", () => {
    expect(
      resolveReceiptMerchant({
        from_email: "ship-confirm@updates.myntra.com",
        merchant_name: "Myntra",
        merchant_domain: "myntra.com",
      }),
    ).toEqual({
      merchantId: "myntra.com:myntra",
      displayName: "Myntra",
      logoDomain: "myntra.com",
      category: "Other",
      displayKind: "merchant",
    });

    expect(
      resolveReceiptMerchant({
        from_email: "ship-confirm@updates.myntra.com",
        merchant_name: null,
        merchant_domain: null,
      }),
    ).toEqual({
      merchantId: null,
      displayName: "Receipt",
      logoDomain: null,
      category: "Other",
      displayKind: "generic",
    });
  });

  it("keeps an evidence-backed backend label even when no logo mapping exists", () => {
    expect(
      resolveReceiptMerchant({
        from_email: "orders@local-shop.example",
        from_name: "Local Shop receipts",
        merchant_name: "Local Shop",
        merchant_domain: "local-shop.example",
      }),
    ).toEqual({
      merchantId: "local-shop.example:local shop",
      displayName: "Local Shop",
      logoDomain: null,
      category: "Other",
      displayKind: "merchant",
    });
    expect(
      resolveReceiptMerchant({
        from_email: "ship-confirm@unknown.example",
        from_name: null,
        merchant_name: null,
        merchant_domain: null,
      }).displayName,
    ).toBe("Receipt");
  });

  it.each([
    "Shopping",
    "Food",
    "Travel",
    "Transport",
    "Subscription",
    "Bills",
  ] as const)(
    "uses verified category %s without creating a merchant grouping identity",
    (category) => {
      const records = [
        receipt(1, {
          merchant_name: null,
          category,
          category_confidence: 0.95,
          order_id: "SAME",
        }),
        receipt(2, {
          merchant_name: null,
          category,
          category_confidence: 0.95,
          order_id: "SAME",
          event_type: "fulfillment",
        }),
      ];
      const rows = buildRecentReceiptRows(records, "account");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        merchantName: category,
        category,
        displayKind: "category",
        logoDomain: null,
      });
      expect(
        resolveReceiptMerchant(
          receipt(3, { category, category_confidence: 0.95 }),
        ).displayName,
      ).toBe("Myntra");
    },
  );

  it("does not infer a category from weak text or low confidence", () => {
    const row = receipt(1, {
      merchant_name: null,
      category: "Food",
      category_confidence: 0.4,
      subject: "Food travel shopping offers",
    });
    expect(resolveReceiptMerchant(row)).toMatchObject({
      displayName: "Receipt",
      displayKind: "generic",
      category: "Other",
    });
  });

  it("builds a provider URL from only an allowlisted canonical domain", () => {
    const url = buildReceiptLogoUrl(
      "https://logos.example.test/{domain}?size=72",
      "myntra.com",
    );

    expect(url).toBe("https://logos.example.test/myntra.com?size=72");
    expect(url).not.toContain("ship-confirm");
    expect(url).not.toContain("ORDER-");
    expect(buildReceiptLogoUrl("", "myntra.com")).toBeNull();
    expect(
      buildReceiptLogoUrl("http://logos.example.test/{domain}", "myntra.com"),
    ).toBeNull();
    expect(
      buildReceiptLogoUrl(
        "https://logos.example.test/{domain}/{domain}",
        "myntra.com",
      ),
    ).toBeNull();
    expect(
      buildReceiptLogoUrl(
        "https://logos.example.test/{domain}",
        "unverified.example",
      ),
    ).toBeNull();
  });

  it("keeps missing amounts honest without fabricating a currency value", () => {
    expect(formatReceiptAmount("INR", null)).toBe("—");
    expect(formatReceiptAmount("$", 20)).toBe("$20.00");
    expect(formatReceiptAmount(null, 125)).toBe("—");
    expect(formatReceiptAmount("INR", Number.NaN)).toBe("—");
    expect(formatReceiptAmount("INR", 0)).not.toBe("—");
    expect(formatReceiptAmount("INR", 125.5)).toMatch(/125\.50/);
  });

  it("keeps three distinct Myntra orders as three rows", () => {
    const rows = buildRecentReceiptRows(
      [
        receipt(1, { order_id: "MYNTRA-1" }),
        receipt(2, { order_id: "MYNTRA-2" }),
        receipt(3, { order_id: "MYNTRA-3" }),
      ],
      "owner@example.com",
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.sourceReceiptIds)).toEqual([[1], [2], [3]]);
  });

  it("groups only clear fulfillment updates for one verified order and keeps its refund separate", () => {
    const source = [
      receipt(1, {
        order_id: "MYNTRA-1",
        subject: "Your Myntra order is confirmed",
        amount: 849,
      }),
      receipt(2, {
        order_id: " myntra-1 ",
        subject: "Your order has shipped",
        event_type: "fulfillment",
        amount: null,
      }),
      receipt(3, {
        order_id: "MYNTRA-1",
        subject: "Your order was delivered",
        event_type: "fulfillment",
        amount: null,
      }),
      receipt(4, {
        order_id: "MYNTRA-1",
        subject: "Refund processed for your order",
        event_type: "refund",
        amount: 849,
      }),
      receipt(5, { order_id: "MYNTRA-2" }),
      receipt(6, { order_id: "MYNTRA-3" }),
    ];
    const original = structuredClone(source);

    const rows = buildRecentReceiptRows(source, "owner@example.com");

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      merchantName: "Myntra",
      amount: 849,
      sourceReceiptIds: [1, 2, 3],
    });
    expect(rows[1].sourceReceiptIds).toEqual([4]);
    expect(rows.slice(2).map((row) => row.sourceReceiptIds)).toEqual([
      [5],
      [6],
    ]);
    expect(source).toEqual(original);
  });

  it("collapses one seller purchase with unambiguous carrier fulfillment into a delivered timeline", () => {
    const rows = buildRecentReceiptRows([
      receipt(1, {
        merchant_name: "Kyari.co",
        merchant_domain: null,
        from_email: "orders@kyari.example",
        category: "Shopping",
        category_confidence: 0.96,
        document_kind: "order_confirmation",
        event_type: "purchase",
        order_id: null,
        identifiers: [],
        amount: 374,
        currency: "INR",
        gmail_internal_date: "2026-09-06T08:00:00Z",
      }),
      receipt(2, {
        merchant_name: "KYARI PUNE",
        merchant_domain: null,
        from_email: "no-reply@shipping.amazon.in",
        category: "Shopping",
        category_confidence: 0.96,
        document_kind: "fulfillment",
        event_type: "fulfillment",
        status: "delivered",
        order_id: null,
        identifiers: [],
        amount: null,
        currency: null,
        gmail_internal_date: "2026-09-12T08:00:00Z",
      }),
    ], "owner@example.com");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      merchantName: "Kyari.co",
      amount: 374,
      currency: "INR",
      status: "delivered",
      sourceReceiptIds: [1, 2],
    });
    expect(rows[0].eventTimeline.map((event) => event.status)).toEqual([
      "delivered",
      null,
    ]);
  });

  it("collapses repeated recurring payment lifecycle events into one current timeline", () => {
    const lifecycle = [
      [1, "trial", "2026-09-11T08:00:00Z"],
      [2, "payment_failed", "2026-09-19T08:00:00Z"],
      [3, "payment_failed", "2026-09-24T08:00:00Z"],
      [4, "suspended", "2026-09-25T08:00:00Z"],
    ] as const;
    const rows = buildRecentReceiptRows(lifecycle.map(([id, status, date]) => receipt(id, {
      merchant_name: "Google Play",
      merchant_domain: null,
      category: "Software & Subscriptions",
      category_confidence: 0.96,
      document_kind: "invoice",
      event_type: "unknown",
      recurrence: id === 2 ? "unknown" : "recurring",
      status,
      short_detail: id === 2
        ? "Brave Firewall + VPN - Monthly (Brave Private Web Browser, VPN)"
        : "Brave Firewall + VPN - Monthly",
      amount: status === "trial" ? null : 990,
      currency: status === "trial" ? null : "INR",
      order_id: null,
      identifiers: status === "trial"
        ? [{ kind: "order", value: "GPA.3348-9279-9688-49309" }]
        : [{ kind: "payment", value: `attempt-${id}` }],
      gmail_internal_date: date,
    })), "owner@example.com");

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("suspended");
    expect(rows[0].eventTimeline).toHaveLength(4);
    expect(rows[0].eventTimeline.map((event) => event.status)).toEqual([
      "suspended",
      "payment_failed",
      "payment_failed",
      "trial",
    ]);
  });

  it("never applies identifier-free fallback across explicit different orders", () => {
    const rows = buildRecentReceiptRows([
      receipt(1, {
        merchant_name: "Kyari.co",
        identifiers: [{ kind: "order", value: "ORDER-1" }],
        category: "Shopping",
        category_confidence: 0.95,
      }),
      receipt(2, {
        merchant_name: "Kyari.co",
        identifiers: [{ kind: "order", value: "ORDER-2" }],
        category: "Shopping",
        category_confidence: 0.95,
        document_kind: "fulfillment",
        event_type: "fulfillment",
        status: "delivered",
      }),
    ], "owner@example.com");

    expect(rows).toHaveLength(2);
  });

  it("does not group ambiguous, unverified, or accountless records", () => {
    const ambiguous = [
      receipt(1, { order_id: null, subject: "Order update" }),
      receipt(2, { order_id: null, subject: "Order update" }),
    ];
    expect(buildRecentReceiptRows(ambiguous, "owner@example.com")).toHaveLength(
      2,
    );

    const fulfillment = [
      receipt(3, { order_id: "SAME", subject: "Order confirmation" }),
      receipt(4, {
        order_id: "SAME",
        subject: "Order has shipped",
        event_type: "fulfillment",
      }),
    ];
    expect(buildRecentReceiptRows(fulfillment, null)).toHaveLength(2);
    expect(
      buildRecentReceiptRows(
        [
          receipt(7, { order_id: "SAME", event_type: "unknown" }),
          receipt(8, {
            order_id: "SAME",
            event_type: "fulfillment",
          }),
        ],
        "owner@example.com",
      ),
    ).toHaveLength(2);
    expect(
      buildRecentReceiptRows(
        [
          fulfillment[0],
          {
            ...fulfillment[1],
            subject: "Order update",
            event_type: "purchase",
            preview: "Earlier message: your order has shipped",
          },
        ],
        "owner@example.com",
      ),
    ).toHaveLength(1); // Same verified order can collapse without a fulfillment document.
    expect(
      buildRecentReceiptRows(
        [
          receipt(5, { order_id: "AB 12", subject: "Order confirmation" }),
          receipt(6, { order_id: "A B12", subject: "Order has shipped" }),
        ],
        "owner@example.com",
      ),
    ).toHaveLength(2);
    expect(
      buildRecentReceiptRows(
        fulfillment.map((item) => ({
          ...item,
          merchant_name: null,
          merchant_domain: null,
        })),
        "owner@example.com",
      ),
    ).toHaveLength(2);
  });
});
