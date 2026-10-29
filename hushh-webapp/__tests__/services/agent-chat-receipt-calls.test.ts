import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { unavailableReceiptAnalysis } from "@/lib/mail/receipt-availability";
import { receiptStoreVersion, writeReceiptSnapshot } from "@/lib/mail/receipt-store";
import { captureReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { receiptCallRequest, receiptCallRunner, settleReceiptCalls } from "@/lib/services/agent-chat-receipt-calls";
import { sendChatTurn } from "@/lib/services/pod-chat-turn-transport";

const connector = vi.hoisted(() => ({ status: null as null | { configured: boolean; connected: boolean; revoked: boolean } }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({ getConnectorView: () => ({ status: connector.status }) }));

const session = { userId: "owner", vaultKey: "12".repeat(32), vaultOwnerToken: "owner-token" };
const list = { from_date: "2026-10-01", to_date: "2026-11-01", timezone: "UTC", limit: 10 };
const disconnected = { configured: true, connected: false, revoked: false };
beforeEach(() => {
  connector.status = null;
  publishValidatedAuthSessionOwner("owner");
  Object.defineProperty(window, "indexedDB", { value: new IDBFactory(), configurable: true });
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

describe("receipt calls on a device with no saved receipts", () => {
  it("tells a disconnected owner to connect Gmail, once per turn", async () => {
    connector.status = disconnected;
    const setup = vi.fn();
    const run = receiptCallRunner(session, setup);
    const results = await Promise.all([run("list_recent_receipts", list), run("receipt_spending", { ...list, group_by: "merchant" })]);
    expect(results).toEqual([0, 1].map(() => expect.objectContaining({ status: "unavailable", code: "gmail_not_connected",
      limitations: ["Gmail isn't connected. Connect Gmail so One can read your receipts."] })));
    expect(setup.mock.calls).toEqual([["connect_required"]]);
  });

  it("asks a connected or unknown owner to sync this device; a locked vault stays generic", async () => {
    for (const status of [{ configured: true, connected: true, revoked: false }, null]) {
      connector.status = status;
      const setup = vi.fn();
      await expect(receiptCallRunner(session, setup)("list_recent_receipts", list)).resolves.toMatchObject({ code: "receipts_not_synced",
        limitations: ["Receipts haven't synced to this device yet. Open Mail receipts to sync, then ask again."] });
      expect(setup.mock.calls).toEqual([["sync_required"]]);
    }
    // Negative control: only the store's typed missing-snapshot error is a setup state, even with Gmail disconnected.
    connector.status = disconnected;
    const setup = vi.fn();
    await expect(receiptCallRunner({ ...session, vaultOwnerToken: "" }, setup)("list_recent_receipts", list))
      .resolves.toMatchObject({ code: "receipt_snapshot_unavailable" });
    expect(setup).not.toHaveBeenCalled();
  });

  it("syncs a connected device once for the turn and answers from what it saved; a failed sync stays not synced", async () => {
    connector.status = { configured: true, connected: true, revoked: false };
    const sync = vi.fn(async (_session: unknown, onStart: () => void) => {
      onStart();
      const snapshot = await captureReceiptSnapshot([], "account", { partial: false, truncated: false, source_count: 0, window_from: null, window_to: null, source: "gmail_live" });
      await writeReceiptSnapshot(session, snapshot, await receiptStoreVersion("owner", "account"));
      return "synced" as const;
    });
    const setup = vi.fn();
    const run = receiptCallRunner(session, setup, sync);
    const results = await Promise.all([run("list_recent_receipts", list), run("receipt_spending", { ...list, group_by: "merchant" })]);
    expect(results).toEqual([expect.objectContaining({ status: "ok" }), expect.objectContaining({ status: "ok" })]);
    expect(sync).toHaveBeenCalledOnce();
    expect(setup.mock.calls).toEqual([["syncing"], ["synced"]]);
    // Negative control: a sync that failed or ran out of time never claims success.
    Object.defineProperty(window, "indexedDB", { value: new IDBFactory(), configurable: true });
    const failedSetup = vi.fn();
    await expect(receiptCallRunner(session, failedSetup, async (_s, onStart) => (onStart(), "failed"))("list_recent_receipts", list))
      .resolves.toMatchObject({ code: "receipts_not_synced" });
    expect(failedSetup.mock.calls).toEqual([["syncing"], ["sync_required"]]);
  });

  it("answers from the pages a sync saved before it ran out of time, saying the sync is incomplete", async () => {
    connector.status = { configured: true, connected: true, revoked: false };
    const setup = vi.fn();
    const result = await receiptCallRunner(session, setup, async (_s, onStart) => {
      onStart();
      const partial = await captureReceiptSnapshot([], "account", { partial: true, truncated: false, source_count: 0, window_from: null, window_to: null, source: "gmail_live" });
      await writeReceiptSnapshot(session, partial, await receiptStoreVersion("owner", "account"));
      return "failed";
    })("list_recent_receipts", list);
    // Negative control: these saved pages were thrown away as "not synced" with an Open receipts card.
    expect(result).toMatchObject({ status: "ok", limitations: expect.arrayContaining(["Receipt sync is incomplete, so some receipts may be missing."]) });
    expect(setup.mock.calls).toEqual([["syncing"], ["sync_incomplete"]]);
  });

  it("never leaves the syncing card on a turn whose receipts can't be read after its sync", async () => {
    connector.status = { configured: true, connected: true, revoked: false };
    const live = { ...session };
    const setup = vi.fn();
    const result = await receiptCallRunner(live, setup, async (_s, onStart) => {
      onStart();
      live.vaultOwnerToken = ""; // The store now refuses the read instead of finding nothing.
      return "synced";
    })("list_recent_receipts", list);
    expect(result).toMatchObject({ code: "receipt_snapshot_unavailable" });
    expect(setup.mock.calls).toEqual([["syncing"], ["sync_incomplete"]]);
  });

  it("reports activity while a long device sync runs, so the turn never reads as a quiet connection", async () => {
    vi.useFakeTimers();
    try {
      const activity: number[] = [];
      const settled = settleReceiptCalls([new Promise(resolve => setTimeout(() => resolve("done"), 40_000))], undefined, () => activity.push(Date.now()));
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(settled).resolves.toEqual(["done"]);
      const gaps = [...activity, Date.now()].map((at, index, all) => index ? at - all[index - 1]! : 0);
      expect(activity.length).toBeGreaterThan(1);
      expect(Math.max(...gaps)).toBeLessThan(35_000);
    } finally { vi.useRealTimers(); }
  });

  it("sends a version 1 owner pod the generic result and still offers setup; the hub gets the exact code", async () => {
    connector.status = disconnected;
    const setup = vi.fn();
    const result = await receiptCallRunner(session, setup)("list_recent_receipts", list);
    expect(setup.mock.calls).toEqual([["connect_required"]]);
    // A hub turn sends the runner's result as it is.
    expect(result).toMatchObject({ code: "gmail_not_connected" });
    const answered = { schema: "receipt_analysis.v1", operation: "list_recent_receipts", status: "ok", results: [] };
    const receiptToolResults = [result, answered].map((value, index) => ({ toolCallId: `call-${index}`, toolName: "list_recent_receipts", request: list, result: value }));
    const posts: string[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => url.endsWith("/capabilities")
      ? Response.json({ identity: { type: "google-adk" }, transport: { streaming: true }, tools: { clientProvided: true }, receiptToolVersion: 1 })
      : (posts.push(String(init.body)), Response.json({})));
    await sendChatTurn("https://pod.example", { method: "POST", body: JSON.stringify({ forwardedProps: { receiptToolResults } }) }, fetch);
    expect(JSON.parse(posts[0]!).forwardedProps.receiptToolResults).toEqual([
      { ...receiptToolResults[0], result: unavailableReceiptAnalysis("list_recent_receipts", list) }, receiptToolResults[1]]);
  });

  it("admits a receipt call only for this owner turn's zone and capacity", () => {
    const streamed = JSON.stringify({ ...list, attention: "needs_attention" });
    expect(receiptCallRequest("list_recent_receipts", streamed, {}, "UTC", true)).toEqual({ kind: "admitted", request: { ...list, attention: "needs_attention" } });
    expect(receiptCallRequest("list_recent_receipts", undefined, list, "Asia/Kolkata", true)).toEqual({ kind: "refused" });
    expect(receiptCallRequest("list_recent_receipts", undefined, list, "UTC", false)).toEqual({ kind: "refused" });
    // Schema-invalid arguments are the hub's to answer; an inadmissible turn is still refused first.
    expect(receiptCallRequest("list_recent_receipts", "!", list, "UTC", true)).toEqual({ kind: "invalid" });
    expect(receiptCallRequest("receipt_spending", undefined, {}, "UTC", false)).toEqual({ kind: "refused" });
  });
});
