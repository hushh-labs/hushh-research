import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GmailRecentReceipts,
  ReceiptMerchantLogo,
} from "@/components/gmail/gmail-recent-receipts";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

function detailLoader(receipts: readonly ReceiptListItem[]) {
  return vi.fn(async (sourceId: string) => {
    const item = receipts.find((receipt) => receipt.source_id === sourceId);
    if (!item) throw new Error("Receipt not found.");
    return {
      item,
      email_excerpt: item.preview
        ? {
            kind: "preview",
            label: "Email preview",
            text: item.preview,
            truncated: false,
          }
        : null,
    };
  });
}

describe("receipt merchant logo", () => {
  it("keeps a short document detail without mislabelling it as email content", async () => {
    const item: ReceiptListItem = { id: 8, source_id: "short-source", gmail_message_id: "short-message", category: "Subscription", category_confidence: 0.95, short_detail: "Monthly membership" };
    render(<GmailRecentReceipts accountKey="test" receipts={[item]} loadReceiptDetail={async () => ({ item, email_excerpt: null })} />);
    fireEvent.click(screen.getByRole("button", {name: /Subscription/}));
    const detail = within(await screen.findByTestId("receipt-detail"));
    expect(detail.queryByText("Email preview")).not.toBeInTheDocument();
    expect(detail.getByText("Monthly membership")).toBeVisible();
    expect(detail.getByText("Details")).toBeVisible();
  });
  it("uses the selected backend detail identity instead of a stale generic list label", async () => {
    const item: ReceiptListItem = { id: 9, source_id: "identity-source", gmail_message_id: "identity-message", category: "Other", category_confidence: 0.95 };
    render(<GmailRecentReceipts accountKey="test" receipts={[item]} loadReceiptDetail={async () => ({ item: {...item, category: "Subscription"}, email_excerpt: null })} />);
    fireEvent.click(screen.getByRole("button", {name: /Receipt/}));
    await screen.findByTestId("receipt-detail");
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Subscription");
  });
  it("shows enriched metadata from the selected backend receipt", async () => {
    const receipts: ReceiptListItem[] = [{
      id: 1, source_id: "rich-source", gmail_message_id: "rich-message",
      merchant_name: "Store", category: "Subscription", category_confidence: 0.95,
      short_detail: "Monthly membership", status: "paid", amount: 20, currency: "USD",
      identifier_kind: "invoice", identifier_value: "INV-20",
      receipt_date: "2026-09-18T12:00:00Z", preview: "Monthly membership. Amount paid USD 20.00",
    }];
    render(<GmailRecentReceipts accountKey="test" receipts={receipts} loadReceiptDetail={detailLoader(receipts)} />);
    expect(screen.queryByTitle(/Monthly membership · Paid ·/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Store/ }));
    const detail = within(await screen.findByTestId("receipt-detail"));
    expect(detail.getByText("Paid")).toBeVisible();
    expect(detail.getByText("Invoice")).toBeVisible();
    expect(detail.getByText("INV-20")).toBeVisible();
    expect(detail.getByText("Email preview")).toBeVisible();
  });
  it("filters only on backend status and groups newest receipts by month", () => {
    const receipts: ReceiptListItem[] = [
      {
        id: 1,
        source_id: "paid",
        gmail_message_id: "paid-message",
        merchant_name: "Paid Store",
        category: "Shopping",
        category_confidence: 0.95,
        status: "paid",
        amount: 10,
        currency: "USD",
        receipt_date: "2026-09-18T12:00:00Z",
      },
      {
        id: 2,
        source_id: "overdue",
        gmail_message_id: "overdue-message",
        merchant_name: "Supabase",
        category: "Cloud & Infra",
        category_confidence: 0.95,
        status: "overdue",
        attention_state: "needs_attention",
        attention_reason: "overdue",
        amount: 124.01,
        currency: "USD",
        receipt_date: "2026-10-04T12:00:00Z",
        subject: "Your Supabase invoice is overdue",
      },
      {
        id: 3,
        source_id: "renewal",
        gmail_message_id: "renewal-message",
        merchant_name: "Software Store",
        category: "Software & Subscriptions",
        category_confidence: 0.95,
        status: "renewal_due",
        recurrence: "recurring",
        attention_state: "coming_up",
        attention_reason: "renewal_due",
        attention_is_prediction: true,
        amount: null,
        currency: null,
        receipt_date: "2026-10-01T00:00:00Z",
      },
      {
        id: 4,
        source_id: "trial",
        gmail_message_id: "trial-message",
        merchant_name: "Trial Store",
        category: "Subscription",
        category_confidence: 0.95,
        status: "trial",
        receipt_date: "2026-09-30T12:00:00Z",
      },
      {
        id: 5,
        source_id: "cancelled",
        gmail_message_id: "cancelled-message",
        merchant_name: "Cancelled Store",
        category: "Shopping",
        category_confidence: 0.95,
        status: "cancelled",
        receipt_date: "2026-09-20T12:00:00Z",
      },
      {
        id: 6,
        source_id: "refunded",
        gmail_message_id: "refunded-message",
        merchant_name: "Refunded Store",
        category: "Shopping",
        category_confidence: 0.95,
        status: "refunded",
        receipt_date: "2026-09-19T12:00:00Z",
      },
    ];
    render(
      <GmailRecentReceipts
        accountKey="test"
        receipts={receipts}
        loadReceiptDetail={detailLoader(receipts)}
      />,
    );

    expect(screen.queryByTestId("receipt-summary")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["OCTOBER 2026", "SEPTEMBER 2026"]);
    expect(screen.getAllByTestId("receipt-row")[0]).toHaveAccessibleName(
      /Supabase.*Overdue.*Cloud & Infra.*124\.01/i,
    );
    expect(screen.getAllByTestId("receipt-row")[0]).toHaveClass(
      "bg-[color:var(--app-card-surface-default-solid)]",
    );
    expect(screen.getAllByTestId("receipt-row")[0]).not.toHaveClass(
      "bg-[color:var(--app-warning-tint)]",
    );
    expect(
      screen
        .getByText("Paid", { selector: '[data-slot="badge"]' })
        .closest('[data-slot="badge"]'),
    ).toHaveClass("bg-[color:var(--app-success-tint)]");
    expect(
      screen
        .getByText("Overdue", { selector: '[data-slot="badge"]' })
        .closest('[data-slot="badge"]'),
    ).toHaveClass("bg-[color:var(--app-destructive-tint)]");

    fireEvent.click(screen.getByRole("tab", { name: "Paid" }));
    expect(screen.getAllByTestId("receipt-row")).toHaveLength(1);
    expect(screen.getByText("Paid Store")).toBeVisible();
    expect(screen.queryByText("Supabase")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Due" }));
    expect(screen.queryAllByTestId("receipt-row")).toHaveLength(0);
    expect(screen.getByText("No receipts match this view.")).toBeVisible();
    expect(screen.queryByText("Software Store")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Overdue" }));
    expect(screen.getAllByTestId("receipt-row")).toHaveLength(1);
    expect(screen.getByText("Supabase")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(screen.getByText("Supabase")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Upcoming" }));
    expect(screen.getAllByTestId("receipt-row")).toHaveLength(2);
    expect(screen.getByText("Software Store")).toBeVisible();
    expect(screen.getByText("Trial Store")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Cancelled" }));
    expect(screen.getAllByTestId("receipt-row")).toHaveLength(2);
    expect(screen.getByText("Cancelled Store")).toBeVisible();
    expect(screen.getByText("Refunded Store")).toBeVisible();
  });

  it("labels prediction and shows bounded backend source evidence in details", async () => {
    const item: ReceiptListItem = {
      id: 5,
      source_id: "predicted-source",
      gmail_message_id: "predicted-message",
      merchant_name: "Service",
      category: "Software & Subscriptions",
      category_confidence: 0.95,
      status: "renewal_due",
      recurrence: "recurring",
      attention_state: "coming_up",
      attention_reason: "renewal_due",
      attention_is_prediction: true,
      classification_confidence: 0.93,
    };
    render(
      <GmailRecentReceipts
        accountKey="test"
        receipts={[item]}
        loadReceiptDetail={async () => ({
          item,
          email_excerpt: null,
          source_evidence: [
            { kind: "attention", text: "Your subscription renews October 18" },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Service/ }));
    const detail = within(await screen.findByTestId("receipt-detail"));
    expect(detail.getByText("Renewal due · Predicted")).toBeVisible();
    expect(detail.getByText("Recurring")).toBeVisible();
    expect(detail.getByText("93%")).toBeVisible();
    expect(detail.getByText("Source evidence")).toBeVisible();
    expect(detail.getByText(/subscription renews October 18/)).toBeVisible();
  });
  it("paginates ten filtered rows and preserves filter, page, and focus through details", async () => {
    const receipts = Array.from(
      { length: 23 },
      (_, index): ReceiptListItem => ({
        id: index + 1,
        source_id: `source-${index}`,
        gmail_message_id: `message-${index}`,
        source_kind: "gmail_live",
        merchant_name: `Store ${index}`,
        category: "Shopping",
        category_confidence: 0.95,
        status: index < 12 ? "paid" : "overdue",
        amount: null,
        currency: null,
        receipt_date: `2026-10-${String(23 - index).padStart(2, "0")}T12:00:00Z`,
      }),
    );
    const loadReceiptDetail = detailLoader(receipts);
    render(
      <GmailRecentReceipts
        accountKey="test-account"
        receipts={receipts}
        loadReceiptDetail={loadReceiptDetail}
      />,
    );
    expect(screen.getAllByTestId("receipt-row")).toHaveLength(10);
    expect(screen.getByText("1 / 3")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("2 / 3")).toBeVisible();
    expect(loadReceiptDetail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Paid" }));
    expect(screen.getByText("1 / 2")).toBeVisible();
    expect(screen.getAllByTestId("receipt-row")).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("2 / 2")).toBeVisible();
    expect(screen.getAllByTestId("receipt-row")).toHaveLength(2);
    expect(loadReceiptDetail).not.toHaveBeenCalled();

    const selectedRow = screen.getByRole("button", { name: /Store 11/ });
    fireEvent.click(selectedRow);
    await waitFor(() =>
      expect(loadReceiptDetail).toHaveBeenCalledWith(
        "source-11",
        expect.any(AbortSignal),
      ),
    );
    expect(
      within(await screen.findByRole("dialog")).getAllByText("Not available")
        .length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Close detail panel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("tab", { name: "Paid" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("2 / 2")).toBeVisible();
    await waitFor(() => expect(selectedRow).toHaveFocus());

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Store" },
    });
    expect(screen.getByText("1 / 2")).toBeVisible();
  });
  it("uses the same category title and icon in a row and its selected detail", async () => {
    const receipts: ReceiptListItem[] = [
      {
        id: 901,
        source_id: "category-receipt",
        gmail_message_id: "category-message",
        source_kind: "gmail_live",
        merchant_name: null,
        category: "Food",
        category_confidence: 0.95,
        amount: null,
        currency: null,
      },
    ];
    const loadReceiptDetail = detailLoader(receipts);
    const { container } = render(
      <GmailRecentReceipts
        accountKey="test-account"
        receipts={receipts}
        loadReceiptDetail={loadReceiptDetail}
      />,
    );
    const row = screen.getByRole("button", { name: /Food —/ });
    expect(
      container.querySelector('[data-receipt-category="Food"]'),
    ).toHaveAttribute("data-logo-kind", "category");
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Food" })).toBeVisible();
    await waitFor(() =>
      expect(loadReceiptDetail).toHaveBeenCalledWith(
        "category-receipt",
        expect.any(AbortSignal),
      ),
    );
    expect(screen.queryByText("Unknown merchant")).toBeNull();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the generic receipt icon when the provider is unconfigured", () => {
    const { container } = render(
      <ReceiptMerchantLogo
        merchantName="Myntra"
        logoDomain="myntra.com"
        providerUrlTemplate=""
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector('[data-logo-kind="fallback"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelectorAll('svg[data-canonical-icon="true"]'),
    ).toHaveLength(1);
    expect(container.querySelector('svg [opacity="0.2"]')).not.toBeNull();
  });

  it("uses only the canonical domain and falls back without a layout change after failure", () => {
    const { container } = render(
      <ReceiptMerchantLogo
        merchantName="Myntra"
        logoDomain="myntra.com"
        providerUrlTemplate="https://logos.example.test/{domain}"
      />,
    );

    const frame = container.querySelector(
      '[data-slot="receipt-merchant-logo"]',
    );
    const image = container.querySelector("img");
    expect(frame).toHaveClass("size-9");
    expect(image).toHaveAttribute(
      "src",
      "https://logos.example.test/myntra.com",
    );
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(image).toHaveAttribute("crossorigin", "anonymous");
    expect(image?.getAttribute("src")).not.toContain("ship-confirm");

    fireEvent.error(image!);

    expect(container.querySelector("img")).toBeNull();
    expect(frame).toHaveClass("size-9");
    expect(frame).toHaveAttribute("data-logo-kind", "fallback");
  });

  it("does not request a provider logo while the browser is offline", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);

    const { container } = render(
      <ReceiptMerchantLogo
        merchantName="Myntra"
        logoDomain="myntra.com"
        providerUrlTemplate="https://logos.example.test/{domain}"
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector('[data-logo-kind="fallback"]'),
    ).toBeInTheDocument();
  });

  it("opens only the selected stable receipt and restores row focus on close", async () => {
    const receipts: ReceiptListItem[] = [
      {
        id: 41,
        source_id: "gmail_live_source_41",
        source_kind: "gmail_live",
        gmail_message_id: "message-41",
        from_email: "orders@myntra.com",
        merchant_name: "Myntra",
        merchant_domain: "myntra.com",
        event_type: "purchase",
        order_id: "ORDER-ONE",
        subject: "First order",
        preview: "First receipt preview",
        amount: 100,
        currency: "INR",
      },
      {
        id: 42,
        source_id: "gmail_live_source_42",
        source_kind: "gmail_live",
        gmail_message_id: "message-42",
        from_email: "orders@myntra.com",
        merchant_name: "Myntra",
        merchant_domain: "myntra.com",
        event_type: "purchase",
        order_id: "ORDER-TWO",
        subject: "Second order",
        preview: "Second receipt preview",
        amount: 250,
        currency: "INR",
      },
    ];

    const loadReceiptDetail = detailLoader(receipts);
    render(
      <GmailRecentReceipts
        accountKey="google-account-1"
        loadReceiptDetail={loadReceiptDetail}
        receipts={receipts}
      />,
    );

    const receiptRows = screen.getAllByRole("button", { name: /Myntra/ });
    expect(receiptRows).toHaveLength(2);
    const selectedRow = receiptRows[1];
    fireEvent.click(selectedRow);

    const details = await screen.findByTestId("receipt-detail");
    expect(loadReceiptDetail).toHaveBeenCalledWith(
      "gmail_live_source_42",
      expect.any(AbortSignal),
    );
    expect(within(details).getByText("ORDER-TWO")).toBeVisible();
    expect(within(details).getByText("Second order")).toBeVisible();
    expect(within(details).getByText("Email preview")).toBeVisible();
    expect(within(details).getByText("Second receipt preview")).toBeVisible();
    expect(screen.queryByText("ORDER-ONE")).toBeNull();
    expect(screen.queryByText("First receipt preview")).toBeNull();
    expect(screen.queryByText(/full receipt|invoice/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close detail panel" }));
    await waitFor(() =>
      expect(screen.queryByTestId("receipt-detail")).toBeNull(),
    );
    await waitFor(() => expect(selectedRow).toHaveFocus());
  });

  it("selects by source key when numeric compatibility IDs collide", async () => {
    const receipts: ReceiptListItem[] = [
      {
        id: 77,
        source_id: "gmail_live:source-one",
        receipt_key: "gmail_live:source-one",
        source_kind: "gmail_live",
        gmail_message_id: "source-one",
        merchant_name: "Myntra",
        merchant_domain: "myntra.com",
        event_type: "purchase",
        subject: "First source",
        order_id: "ORDER-ONE",
      },
      {
        id: 77,
        source_id: "gmail_live:source-two",
        receipt_key: "gmail_live:source-two",
        source_kind: "gmail_live",
        gmail_message_id: "source-two",
        merchant_name: "Myntra",
        merchant_domain: "myntra.com",
        event_type: "purchase",
        subject: "Second source",
        order_id: "ORDER-TWO",
      },
    ];

    const loadReceiptDetail = detailLoader(receipts);
    render(
      <GmailRecentReceipts
        accountKey="google-account-1"
        loadReceiptDetail={loadReceiptDetail}
        receipts={receipts}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Myntra/ })[1]);

    const details = await screen.findByTestId("receipt-detail");
    expect(loadReceiptDetail).toHaveBeenCalledWith(
      "gmail_live:source-two",
      expect.any(AbortSignal),
    );
    expect(within(details).getByText("ORDER-TWO")).toBeVisible();
    expect(within(details).getByText("Second source")).toBeVisible();
    expect(screen.queryByText("ORDER-ONE")).toBeNull();
  });

  it("keeps the selected source open when its same-order group gains a better representative", async () => {
    const initialReceipts: ReceiptListItem[] = [
      {
        id: 51,
        source_id: "gmail_live_source_51",
        source_kind: "gmail_live",
        gmail_message_id: "message-51",
        merchant_name: "Myntra",
        merchant_domain: "myntra.com",
        event_type: "purchase",
        order_id: "ORDER-GROUPED",
        subject: "Order confirmed",
        preview: "Original selected source",
        amount: null,
        currency: "INR",
      },
      {
        id: 52,
        source_id: "gmail_live_source_52",
        source_kind: "gmail_live",
        gmail_message_id: "message-52",
        merchant_name: "Myntra",
        merchant_domain: "myntra.com",
        event_type: "fulfillment",
        order_id: "ORDER-GROUPED",
        subject: "Your order has shipped",
        amount: null,
        currency: "INR",
      },
    ];
    const allReceipts = [
      {
        id: 53,
        source_id: "gmail_live_source_53",
        source_kind: "gmail_live" as const,
        gmail_message_id: "message-53",
        merchant_name: "Myntra",
        merchant_domain: "myntra.com",
        event_type: "purchase" as const,
        order_id: "ORDER-GROUPED",
        subject: "Order confirmed",
        preview: "Newer purchase source",
        amount: 899,
        currency: "INR",
      },
      ...initialReceipts,
    ];
    const loadReceiptDetail = detailLoader(allReceipts);
    const { rerender } = render(
      <GmailRecentReceipts
        accountKey="google-account-1"
        loadReceiptDetail={loadReceiptDetail}
        receipts={initialReceipts}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Myntra/ }));
    expect(await screen.findByTestId("receipt-detail")).toBeVisible();

    rerender(
      <GmailRecentReceipts
        accountKey="google-account-1"
        loadReceiptDetail={loadReceiptDetail}
        receipts={allReceipts}
      />,
    );

    expect(screen.getByTestId("receipt-detail")).toBeVisible();
    expect(screen.getByText("Original selected source")).toBeVisible();
    const openDetail = screen.getByRole("dialog");
    expect(within(openDetail).queryByText("Newer purchase source")).toBeNull();
    expect(within(openDetail).queryByText(/899/)).toBeNull();
    expect(
      within(openDetail).getAllByText("Not available").length,
    ).toBeGreaterThan(0);
  });

  it("shows every normalized same-transaction event in the existing detail sheet", async () => {
    const receipts: ReceiptListItem[] = [
      {
        id: 61,
        source_id: "gmail_live_source_61",
        source_kind: "gmail_live",
        gmail_message_id: "message-61",
        merchant_name: "Kyari.co",
        category: "Shopping",
        category_confidence: 0.95,
        document_kind: "order_confirmation",
        event_type: "purchase",
        identifiers: [{ kind: "order", value: "KYARI-1" }],
        amount: 374,
        currency: "INR",
        subject: "Your order is confirmed",
        gmail_internal_date: "2026-09-06T08:00:00Z",
      },
      {
        id: 62,
        source_id: "gmail_live_source_62",
        source_kind: "gmail_live",
        gmail_message_id: "message-62",
        merchant_name: "Kyari.co",
        category: "Shopping",
        category_confidence: 0.95,
        document_kind: "fulfillment",
        event_type: "fulfillment",
        identifiers: [{ kind: "order", value: "KYARI-1" }],
        status: "delivered",
        subject: "Your package was delivered",
        gmail_internal_date: "2026-09-12T08:00:00Z",
      },
    ];
    render(
      <GmailRecentReceipts
        accountKey="google-account-1"
        loadReceiptDetail={detailLoader(receipts)}
        receipts={receipts}
      />,
    );

    expect(screen.getAllByTestId("receipt-row")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Kyari\.co/ }));
    const detail = within(await screen.findByTestId("receipt-detail"));
    expect(detail.getByText("Activity")).toBeVisible();
    expect(detail.getAllByText("Delivered")).toHaveLength(2);
    expect(detail.getAllByText("Order confirmation")).toHaveLength(2);
    expect(detail.getByText("Your package was delivered")).toBeVisible();
    expect(detail.getAllByText("Your order is confirmed")).toHaveLength(2);
  });
});
