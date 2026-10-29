import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { receiptCallRequest, receiptCallRunner } from "@/lib/services/agent-chat-receipt-calls";

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

  it("admits a receipt call only for this owner turn's zone and capacity", () => {
    const streamed = JSON.stringify({ ...list, attention: "needs_attention" });
    expect(receiptCallRequest("list_recent_receipts", streamed, {}, "UTC", true)).toEqual({ ...list, attention: "needs_attention" });
    expect(receiptCallRequest("list_recent_receipts", undefined, list, "Asia/Kolkata", true)).toBeNull();
    expect(receiptCallRequest("list_recent_receipts", undefined, list, "UTC", false)).toBeNull();
    expect(receiptCallRequest("list_recent_receipts", "!", list, "UTC", true)).toBeNull();
  });
});
