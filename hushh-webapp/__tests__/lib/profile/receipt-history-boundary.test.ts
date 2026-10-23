import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { SecureDurableResourceService as Durable } from "@/lib/services/secure-durable-resource-service";
import { GmailReceiptsService, type ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { MailReceiptHistoryService as History } from "@/lib/services/mail-receipt-history-service";
import { MailReceiptResourceService as Resource } from "@/lib/services/mail-receipt-resource-service";
import { captureReceiptHistory, receiptHistoryItems, RECEIPT_HISTORY_KEY } from "@/lib/mail/receipt-history";
import { buildRecentReceiptRows } from "@/lib/profile/gmail-receipt-presentation";

const session = { userId: "owner", vaultKey: "12".repeat(32), vaultOwnerToken: "synthetic-owner-token" };
const item = (id: number): ReceiptListItem => ({ id, gmail_message_id: `RAW_MESSAGE_${id}`, subject: "RAW_SUBJECT", snippet: "RAW_BODY",
  from_email: "raw@example.com", merchant_name: "Saved merchant", order_id: "SAME-ORDER", amount_decimal: "1.2345", currency: "USD", receipt_date: "2026-10-01" });
const page = (items: ReceiptListItem[], number = 1, more = false) => ({ items, page: number, per_page: 100, total: more ? 120 : number === 2 ? 120 : items.length,
  has_more: more, provenance: { source: "legacy_server_read_only" as const, account_binding: "unknown" as const } });
beforeEach(() => {
  Resource.clear("owner"); vi.restoreAllMocks(); publishValidatedAuthSessionOwner("owner");
  Object.defineProperty(window, "indexedDB", { value: new IDBFactory(), configurable: true });
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});
afterEach(() => { Resource.clear("owner"); vi.useRealTimers(); });

describe("owner receipt history continuity", () => {
  it("preserves four-decimal values and unknown account provenance without collapsing equal orders", async () => {
    const saved = await captureReceiptHistory([item(1), { ...item(2), amount_decimal: "-2.3400" }], null, false);
    expect(saved.account_binding).toBe("unknown");
    expect(saved.rows.map(row => row.amount)).toEqual(["1.2345", "-2.3400"]);
    const restored = receiptHistoryItems(saved);
    expect(buildRecentReceiptRows(restored, null)).toHaveLength(2);
    for (const raw of ["RAW_", "raw@example.com", "checkpoint", "durable_source_ref", "gmail_message_id"])
      expect(JSON.stringify(saved)).not.toContain(raw);
    await expect(captureReceiptHistory([{ ...item(1), amount_decimal: "1.23456" }], saved, false)).rejects.toThrow(/preserved/);
  });

  it("shares a multi-page recovery and restores its encrypted owner archive without a private hub read", async () => {
    let finish!: (value: ReturnType<typeof page>) => void;
    const read = vi.spyOn(GmailReceiptsService, "getSavedHistory").mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, i) => item(i + 1)), 1, true))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = History.open(session, async () => "synthetic", true);
    expect(History.open(session, async () => "synthetic", true)).toBe(first);
    await vi.waitFor(() => expect(History.peek("owner").items).toHaveLength(100));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    finish(page(Array.from({ length: 20 }, (_, i) => item(i + 101)), 2));
    await first;
    expect(History.peek("owner").items).toHaveLength(120);
    expect(History.peek("owner").partial).toBe(false);
    expect(Resource.peek("owner", "current-google-account").snapshot).toBeNull();
    const stored = await Durable.read(session.userId, RECEIPT_HISTORY_KEY, session.vaultKey);
    expect(JSON.stringify(stored)).not.toContain("RAW_");
    Resource.clear("owner");
    await History.open(session, async () => { throw new Error("Private restoration cannot need a token"); }, false);
    expect(History.peek("owner").items).toHaveLength(120);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await Durable.read("other-owner", RECEIPT_HISTORY_KEY, session.vaultKey)).toBeNull();
  });

  it("resumes an interrupted archive after its last encrypted page", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const read = vi.spyOn(GmailReceiptsService, "getSavedHistory")
      .mockResolvedValueOnce(page([item(1)], 1, true))
      .mockImplementationOnce(() => new Promise(() => {}));
    const opening = History.open(session, async () => "synthetic", true).catch(error => error);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(History.peek("owner").items).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_001); await opening;
    expect(History.peek("owner").refreshing).toBe(false);
    Resource.clear("owner");
    read.mockResolvedValueOnce(page([item(2)], 2));
    await History.open(session, async () => "synthetic", true, true);
    expect(read.mock.calls.map(([request]) => request.page)).toEqual([1, 2, 2]);
    expect(History.peek("owner").items).toHaveLength(2);
    expect(History.peek("owner").partial).toBe(false);
    expect((await Durable.read<{ next_page: number | null }>("owner", RECEIPT_HISTORY_KEY, session.vaultKey))?.value.next_page).toBeNull();
  });

  it("never republishes or writes a late conversion after Reset clears the owner", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(GmailReceiptsService, "getSavedHistory").mockResolvedValue(page([item(1)]));
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async () => {
      await gate; return new Uint8Array(32).fill(3).buffer;
    });
    const write = vi.spyOn(Durable, "write");
    const opening = History.open(session, async () => "synthetic", true).catch(error => error);
    await vi.waitFor(() => expect(digest).toHaveBeenCalled());
    await Durable.purgeUser("owner");
    release(); await opening;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(History.peek("owner").items).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(await Durable.read("owner", RECEIPT_HISTORY_KEY, session.vaultKey)).toBeNull();
  });

  it("bounds the complete recovery and rejects a token arriving after its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: (token: string) => void;
    const token = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const read = vi.spyOn(GmailReceiptsService, "getSavedHistory");
    const opening = History.open(session, token, true).catch(error => error);
    await vi.waitFor(() => expect(token).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(120_001);
    await opening;
    expect(History.peek("owner").refreshing).toBe(false);
    expect(History.peek("owner").error).toBeTruthy();
    release("late-synthetic"); await Promise.resolve(); await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    expect(History.peek("owner").items).toEqual([]);
  });
});
