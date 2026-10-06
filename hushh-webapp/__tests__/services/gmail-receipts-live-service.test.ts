import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: apiFetchMock },
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getCurrentUser: vi.fn(() => ({ uid: "owner-uid" })) },
}));

import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import { GMAIL_RECEIPTS_API_TEMPLATES } from "@/lib/services/kai-profile-api-paths";

const liveItem = {
  id: -101,
  source_id: "gmail_live_bXNnLTE.signature",
  receipt_key: "gmail_live_bXNnLTE.signature",
  source_kind: "gmail_live",
  gmail_message_id: "msg-1",
  gmail_thread_id: "thread-1",
  merchant_name: "Myntra",
  merchant_domain: "myntra.com",
  sender_domain: "myntra.com",
  from_name: "ship-confirm",
  from_email: "ship-confirm@myntra.com",
  order_id: "ORDER-1",
  amount: 2499,
  currency: "INR",
  receipt_date: "2026-10-04T04:00:00+00:00",
  gmail_internal_date: "2026-10-04T04:00:00+00:00",
  subject: "Your order receipt",
  preview: "Order total available in this email.",
  snippet: "Order total available in this email.",
  classification_confidence: 0.97,
  classification_source: "agent",
  event_type: "purchase",
  category: "Software & Subscriptions",
  category_confidence: 0.95,
  status: "renewal_due",
  recurrence: "recurring",
  attention_state: "coming_up",
  attention_reason: "renewal_due",
  attention_is_prediction: true,
  attention_date: "October 18",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function scanPayload(overrides: Record<string, unknown> = {}) {
  return {
    items: [liveItem],
    page: 1,
    per_page: 6,
    returned_count: 1,
    has_more: false,
    coverage: {
      source: "gmail_live",
      listed_count: 1,
      candidate_count: 1,
      matched_count: 1,
      pages_scanned: 1,
      max_messages: 6,
      max_pages: 10,
      reached_limit: false,
      query_scope: "receipt_signals_all_mail_except_spam_trash",
      rejection_counts: {
        missing_receipt_signal: 0,
        extractor_not_receipt: 0,
      },
      evidence_counts: {
        gmail_category: 1,
        subject_signal: 1,
        body_signal: 1,
        verified_merchant: 1,
        order_candidate: 1,
        total_candidate: 1,
      },
    },
    ...overrides,
  };
}

describe("GmailReceiptsService live backend receipt contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a sealed no-store scan request and accepts evidence-backed nullable fields", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(
        scanPayload({
          items: [
            {
              ...liveItem,
              merchant_name: null,
              merchant_domain: null,
              category: "Food",
              category_confidence: 0.95,
              amount: null,
              currency: null,
            },
          ],
        }),
      ),
    );

    const result = await GmailReceiptsService.scanReceipts({
      idToken: "firebase-id-token",
      vaultOwnerToken: "vault-owner-token",
      userId: "owner-uid",
      page: 1,
      perPage: 6,
    });

    expect(result.items[0]).toMatchObject({
      source_id: liveItem.source_id,
      merchant_name: null,
      category: "Food",
      category_confidence: 0.95,
      amount: null,
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiFetchMock.mock.calls[0] ?? [];
    expect(path).toBe(GMAIL_RECEIPTS_API_TEMPLATES.receiptsScan);
    expect(options).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: "Bearer firebase-id-token",
        "X-Hushh-Consent": "Bearer vault-owner-token",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      user_id: "owner-uid",
      page: 1,
      per_page: 6,
    });
  });

  it("rejects malformed live items and inconsistent scan counts", async () => {
    apiFetchMock
      .mockResolvedValueOnce(
        jsonResponse(scanPayload({ items: [{ ...liveItem, amount: "2499" }] })),
      )
      .mockResolvedValueOnce(jsonResponse(scanPayload({ returned_count: 2 })))
      .mockResolvedValueOnce(
        jsonResponse(
          scanPayload({
            items: [
              {
                ...liveItem,
                // Scan evidence is held to the detail read's passage contract.
                source_evidence: [
                  { kind: "amount", text: "Pay at https://example.test/pay" },
                ],
              },
            ],
          }),
        ),
      );

    const request = {
      idToken: "firebase-id-token",
      vaultOwnerToken: "vault-owner-token",
      userId: "owner-uid",
    };
    await expect(GmailReceiptsService.scanReceipts(request)).rejects.toThrow(
      "invalid response",
    );
    await expect(GmailReceiptsService.scanReceipts(request)).rejects.toThrow(
      "invalid response",
    );
    await expect(GmailReceiptsService.scanReceipts(request)).rejects.toThrow(
      "invalid response",
    );
  });

  it("fetches only the selected source and requires a matching detail identity", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        item: liveItem,
        email_excerpt: {
          kind: "email_excerpt",
          label: "Email preview",
          text: "A bounded authorized excerpt.",
          truncated: true,
        },
        source_evidence: [
          { kind: "attention", text: "Your subscription renews October 18" },
        ],
      }),
    );

    const result = await GmailReceiptsService.getReceiptDetail({
      idToken: "firebase-id-token",
      vaultOwnerToken: "vault-owner-token",
      userId: "owner-uid",
      sourceId: liveItem.source_id,
    });

    expect(result.email_excerpt?.label).toBe("Email preview");
    expect(result.source_evidence).toEqual([
      { kind: "attention", text: "Your subscription renews October 18" },
    ]);
    const [path, options] = apiFetchMock.mock.calls[0] ?? [];
    expect(path).toBe(GMAIL_RECEIPTS_API_TEMPLATES.receiptDetail);
    expect(options.cache).toBe("no-store");
    expect(JSON.parse(String(options.body))).toEqual({
      user_id: "owner-uid",
      source_id: liveItem.source_id,
    });

    apiFetchMock.mockResolvedValue(
      jsonResponse({
        item: {
          ...liveItem,
          source_id: "gmail_live_b3RoZXI.signature",
          receipt_key: "gmail_live_b3RoZXI.signature",
        },
        email_excerpt: null,
      }),
    );
    await expect(
      GmailReceiptsService.getReceiptDetail({
        idToken: "firebase-id-token",
        vaultOwnerToken: "vault-owner-token",
        userId: "owner-uid",
        sourceId: liveItem.source_id,
      }),
    ).rejects.toThrow("invalid response");
  });

  it("uses the explicit live scan method without a client reader or legacy list", async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(scanPayload()));

    await GmailReceiptsService.scanReceipts({
      idToken: "firebase-id-token",
      vaultOwnerToken: "vault-owner-token",
      userId: "owner-uid",
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(
      GMAIL_RECEIPTS_API_TEMPLATES.receiptsScan,
    );
  });

  it("preserves the receipt-only in-progress code for bounded UI recovery", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(
        {
          detail: {
            code: "GMAIL_RECEIPT_SCAN_IN_PROGRESS",
            message: "A receipt scan is already running for this account.",
          },
        },
        409,
      ),
    );

    await expect(
      GmailReceiptsService.scanReceipts({
        idToken: "firebase-id-token",
        vaultOwnerToken: "vault-owner-token",
        userId: "owner-uid",
      }),
    ).rejects.toMatchObject({
      name: "GmailReceiptRequestError",
      status: 409,
      code: "GMAIL_RECEIPT_SCAN_IN_PROGRESS",
    });
  });

  it("treats page ten as terminal while preserving bounded-limit evidence", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(
        scanPayload({
          page: 10,
          has_more: false,
          coverage: {
            ...scanPayload().coverage,
            pages_scanned: 10,
            reached_limit: true,
          },
        }),
      ),
    );

    const result = await GmailReceiptsService.scanReceipts({
      idToken: "firebase-id-token",
      vaultOwnerToken: "vault-owner-token",
      userId: "owner-uid",
      page: 10,
    });

    expect(result.has_more).toBe(false);
    expect(result.coverage.reached_limit).toBe(true);
  });
});
