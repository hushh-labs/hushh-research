import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

const STORAGE_KEY = "kai_gmail_receipts_cache_v1";

function receipt(
  messageId: string,
  sourceKind?: ReceiptListItem["source_kind"],
): ReceiptListItem {
  return {
    id: messageId.length,
    source_id:
      sourceKind === "gmail_live" ? `gmail_live_${messageId}.signature` : undefined,
    receipt_key: `key:${messageId}`,
    source_kind: sourceKind,
    gmail_message_id: messageId,
    subject: `Receipt ${messageId}`,
  };
}

describe("gmail receipts cache ownership", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.resetModules();
  });

  it("ignores the retired persisted receipt cache without deleting it", async () => {
    const retiredPayload = JSON.stringify({
      version: 2,
      entries: {
        "owner-1\u0000mail@example.com": {
          items: [receipt("legacy-1", "legacy_read_only")],
          page: 1,
          per_page: 20,
          total: 1,
          has_more: false,
          fetched_at: Date.now(),
        },
      },
    });
    window.sessionStorage.setItem(STORAGE_KEY, retiredPayload);

    const { getCachedGmailReceipts } = await import(
      "@/lib/profile/gmail-receipts-cache"
    );

    expect(getCachedGmailReceipts("owner-1", "mail@example.com")).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(retiredPayload);
  });

  it("keeps account caches isolated in memory", async () => {
    const { getCachedGmailReceipts, primeCachedGmailReceipts } = await import(
      "@/lib/profile/gmail-receipts-cache"
    );
    primeCachedGmailReceipts({
      userId: "owner-1",
      accountKey: "first@example.com",
      response: {
        items: [receipt("first", "gmail_live")],
        page: 1,
        per_page: 20,
        total: 1,
        has_more: false,
      },
    });

    expect(
      getCachedGmailReceipts("owner-1", "first@example.com")?.items[0]
        ?.gmail_message_id,
    ).toBe("first");
    expect(
      getCachedGmailReceipts("owner-1", "second@example.com"),
    ).toBeNull();
  });

  it("keeps live receipt rows in memory without writing browser storage", async () => {
    const { primeCachedGmailReceipts } = await import(
      "@/lib/profile/gmail-receipts-cache"
    );
    primeCachedGmailReceipts({
      userId: "owner-1",
      accountKey: "mail@example.com",
      response: {
        items: [receipt("live-1", "gmail_live")],
        page: 1,
        per_page: 20,
        total: 50,
        has_more: true,
      },
    });

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("drops legacy and device projections from live cache merges", async () => {
    const { mergeCachedReceiptItems } = await import(
      "@/lib/profile/gmail-receipts-cache"
    );
    const legacy = receipt("same-source", "legacy_read_only");
    const device = {
      ...receipt("same-source", "gmail_device"),
      receipt_key: "device-receipt:same-source",
    };
    const live = receipt("live-source", "gmail_live");

    expect(
      mergeCachedReceiptItems({
        existing: [legacy],
        incoming: [device, live],
        mode: "prepend_refresh",
      }),
    ).toEqual([live]);
  });

  it("lets a fresh backend projection replace the same live source", async () => {
    const { mergeCachedReceiptItems } = await import(
      "@/lib/profile/gmail-receipts-cache"
    );
    const stale = receipt("same", "gmail_live");
    const refreshed = { ...stale, status: "overdue" as const };

    expect(
      mergeCachedReceiptItems({
        existing: [stale],
        incoming: [refreshed],
        mode: "append",
      }),
    ).toEqual([refreshed]);
  });
});
