import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
const privateOwnerMock = vi.hoisted(() => vi.fn().mockResolvedValue(false));

vi.mock("@/lib/services/private-agent-specialist-chat", () => ({
  ownerContentIsPrivate: privateOwnerMock,
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: apiFetchMock },
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getCurrentUser: vi.fn(() => ({ uid: "owner-uid" })) },
}));

import { GmailReceiptsService, GmailReceiptRequestError, isRetryableReceiptScanPageError, isReceiptScanInProgressError } from "@/lib/services/gmail-receipts-service";
import { GMAIL_RECEIPTS_API_TEMPLATES } from "@/lib/services/kai-profile-api-paths";

const liveItem = {
  id: -101,
  source_id: "gmail_live_bXNnLTE.signature",
  durable_source_ref: "grs1_" + "a".repeat(39),
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
  amount_decimal: "2499.00",
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
  it.each(["GMAIL_RECEIPT_EXTRACTION_INVALID", "GMAIL_RECEIPT_EXTRACTION_UNVERIFIED",
    "GMAIL_RECEIPT_CONTRACT_MISMATCH"])("never retries permanent error %s", code => {
    expect(isRetryableReceiptScanPageError(new GmailReceiptRequestError("invalid", 500, code, true))).toBe(false);
  });

  it("honors the server's retryability veto and types malformed responses", async () => {
    expect(isReceiptScanInProgressError(new GmailReceiptRequestError("busy", 409, "GMAIL_RECEIPT_SCAN_IN_PROGRESS"))).toBe(true);
    expect(isReceiptScanInProgressError(new GmailReceiptRequestError("busy", 409, "GMAIL_RECEIPT_SCAN_IN_PROGRESS", false))).toBe(false);
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ detail: {
      code: "GMAIL_PROVIDER_UNAVAILABLE", message: "temporarily unavailable", retryable: false,
    } }, 503));
    const request = { idToken: "synthetic", vaultOwnerToken: "synthetic", userId: "owner-uid" };
    const error = await GmailReceiptsService.scanReceipts(request).catch(error => error);
    expect(error).toBeInstanceOf(GmailReceiptRequestError);
    expect(isRetryableReceiptScanPageError(error)).toBe(false);
    apiFetchMock.mockResolvedValueOnce(jsonResponse(scanPayload({ returned_count: 99 })));
    await expect(GmailReceiptsService.scanReceipts(request)).rejects.toMatchObject({
      code: "GMAIL_RECEIPT_INVALID_RESPONSE", retryable: false,
    });
    apiFetchMock.mockResolvedValueOnce(new Response("invalid JSON", { status: 200 }));
    await expect(GmailReceiptsService.scanReceipts(request)).rejects.toMatchObject({
      code: "GMAIL_RECEIPT_INVALID_RESPONSE", retryable: false,
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    privateOwnerMock.mockResolvedValue(false);
  });

  it("refuses private receipt reads before any shared request", async () => {
    privateOwnerMock.mockResolvedValue(true);
    const authority = { idToken: "synthetic", vaultOwnerToken: "synthetic", userId: "owner-uid" };
    await expect(GmailReceiptsService.scanReceipts(authority)).rejects.toMatchObject({ code: "PRIVATE_GOOGLE_OPERATION_UNAVAILABLE" });
    await expect(GmailReceiptsService.getReceiptDetail({ ...authority, sourceId: liveItem.source_id })).rejects.toMatchObject({ code: "PRIVATE_GOOGLE_OPERATION_UNAVAILABLE" });
    expect(apiFetchMock).not.toHaveBeenCalled();
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
              amount_decimal: null,
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
      durable_source_ref: liveItem.durable_source_ref,
      amount_decimal: null,
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
    expect(result.items[0]?.durable_source_ref).toBe(liveItem.durable_source_ref);
    expect(result.items[0]?.amount_decimal).toBe(liveItem.amount_decimal);
  });
});


it("admits only an explicit bounded incremental rollover continuation", async () => {
  const payload = scanPayload({ page: 50, has_more: true, sync_mode: "delta", checkpoint: null, next_cursor: "grc1_" + "a".repeat(40), coverage: { ...scanPayload().coverage, pages_scanned: 1, max_pages: 50, reached_limit: true } });
  apiFetchMock.mockResolvedValueOnce(jsonResponse(payload));
  const request = { idToken: "synthetic", vaultOwnerToken: "synthetic", userId: "owner-uid", page: 50, incremental: true };
  expect(await GmailReceiptsService.scanReceipts(request)).toMatchObject({ has_more: true, next_cursor: payload.next_cursor, coverage: { reached_limit: true } });
  apiFetchMock.mockResolvedValueOnce(jsonResponse({ ...payload, sync_mode: undefined }));
  await expect(GmailReceiptsService.scanReceipts(request)).rejects.toMatchObject({ code: "GMAIL_RECEIPT_INVALID_RESPONSE" });
});
