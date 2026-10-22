import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveReceiptCanonicalIndexToMemory = vi.fn();
vi.mock("@/lib/profile/gmail-receipt-memory-save", () => ({
  saveReceiptCanonicalIndexToMemory: (...args: unknown[]) =>
    saveReceiptCanonicalIndexToMemory(...args),
}));

const toast = vi.fn();
vi.mock("sonner", () => ({ toast: (...args: unknown[]) => toast(...args) }));

const vault = { vaultKey: "vault-key", vaultOwnerToken: "owner-token", isVaultUnlocked: true };
const auth = { user: { uid: "user-1" } };
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));

import {
  GmailReceiptMemorySave,
  RECEIPT_MEMORY_AUTO_SAVE_RETRY_DELAYS_MS,
} from "@/components/gmail/gmail-receipt-memory-save";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

const receipts = [{ id: 1, gmail_message_id: "m1", source_id: "s1" } as ReceiptListItem];
const longer = [
  ...receipts,
  { id: 2, gmail_message_id: "m2", source_id: "s2" } as ReceiptListItem,
];

const view = (
  list: ReceiptListItem[],
  completion: number,
  ledger: { current: number },
  autoSave?: boolean,
) => (
  <GmailReceiptMemorySave
    receipts={list}
    accountKey="owner@example.com"
    syncCompletion={completion}
    savedCompletionRef={ledger}
    autoSave={autoSave}
  />
);

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}

describe("GmailReceiptMemorySave (headless, after a finished sync)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vault.isVaultUnlocked = true;
    auth.user.uid = "user-1";
    vault.vaultOwnerToken = "owner-token";
    saveReceiptCanonicalIndexToMemory.mockResolvedValue({ count: 1 });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows nothing and never asks the owner to save", () => {
    const { container } = render(view(receipts, 0, { current: 0 }));
    expect(container.innerHTML).toBe("");
  });

  it("saves once per finished sync, never on mount or a partly loaded list", async () => {
    const ledger = { current: 0 };
    const { rerender } = render(view(receipts, 0, ledger));
    rerender(view(longer, 0, ledger));
    await settle();
    expect(saveReceiptCanonicalIndexToMemory).not.toHaveBeenCalled();

    rerender(view(longer, 1, ledger));
    await settle();
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledOnce();
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      receipts: longer,
      accountKey: "owner@example.com",
      partialScan: true, isCurrent: expect.any(Function), now: expect.any(Date),
    }));

    // The same finished sync is never saved twice, even after a remount.
    rerender(view([...longer], 1, ledger));
    cleanup();
    render(view(longer, 1, ledger));
    await settle();
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledOnce();

    // The next finished sync saves again.
    render(view(longer, 2, ledger));
    await settle();
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledTimes(2);
  });

  it("saves a sync that finished before the saver mounted, once", async () => {
    const ledger = { current: 0 };
    render(view(receipts, 1, ledger));
    await settle();
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledOnce();
    expect(ledger.current).toBe(1);
  });

  it("retries a failed save quietly, then says so once and waits for the next sync", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    saveReceiptCanonicalIndexToMemory.mockRejectedValue(new Error("Failed to save receipt memory."));
    render(view(receipts, 1, { current: 0 }));
    await settle();
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();

    for (const delay of RECEIPT_MEMORY_AUTO_SAVE_RETRY_DELAYS_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay + 10);
      });
    }
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledTimes(
      1 + RECEIPT_MEMORY_AUTO_SAVE_RETRY_DELAYS_MS.length,
    );
    expect(toast).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledTimes(
      1 + RECEIPT_MEMORY_AUTO_SAVE_RETRY_DELAYS_MS.length,
    );
    consoleError.mockRestore();
  });

  it("recovers when a retry succeeds, without telling the owner", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    saveReceiptCanonicalIndexToMemory
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue({ count: 1 });
    render(view(receipts, 1, { current: 0 }));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECEIPT_MEMORY_AUTO_SAVE_RETRY_DELAYS_MS[0] + 10);
    });
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledTimes(2);
    expect(toast).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("writes nothing when auto-save is off, the list is empty, or the vault is locked", async () => {
    render(view(receipts, 1, { current: 0 }, false));
    render(view([], 1, { current: 0 }));
    vault.isVaultUnlocked = false;
    render(view(receipts, 1, { current: 0 }));
    await settle();
    expect(saveReceiptCanonicalIndexToMemory).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("cancels an old owner's pending assessment and retries instead of using the next owner's authority", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    saveReceiptCanonicalIndexToMemory.mockRejectedValue(new Error("Temporary"));
    const ledger = { current: 0 };
    const { rerender } = render(view(receipts, 1, ledger));
    await settle();
    const originatingGuard = saveReceiptCanonicalIndexToMemory.mock.calls[0]![0].isCurrent;
    expect(originatingGuard()).toBe(true);
    auth.user.uid = "user-2";
    // The page exposes no completed scan until the new account finishes one.
    rerender(view([], 0, ledger));
    expect(originatingGuard()).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("captures coverage and cancels old account work before a newer completed scan", async () => {
    saveReceiptCanonicalIndexToMemory.mockResolvedValue({ count: 1 });
    const ledger = { current: 0 };
    const { rerender } = render(view(receipts, 1, ledger));
    await settle();
    const oldGuard = saveReceiptCanonicalIndexToMemory.mock.calls[0]![0].isCurrent;
    rerender(<GmailReceiptMemorySave receipts={longer} accountKey="other@example.com" partialScan={false}
      syncCompletion={2} savedCompletionRef={ledger} />);
    await settle();
    expect(oldGuard()).toBe(false);
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenLastCalledWith(expect.objectContaining({
      accountKey: "other@example.com", receipts: longer, partialScan: false,
    }));
  });

  it("retries the same completed scan after a vault-token renewal cancels pending assessment", async () => {
    let failOld!: (error: Error) => void;
    saveReceiptCanonicalIndexToMemory.mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject; }));
    const ledger = { current: 0 };
    const { rerender } = render(view(receipts, 1, ledger));
    await settle();
    expect(ledger.current).toBe(0);
    vault.vaultOwnerToken = "renewed-token";
    rerender(view(receipts, 1, ledger));
    await settle();
    expect(saveReceiptCanonicalIndexToMemory).toHaveBeenLastCalledWith(expect.objectContaining({ vaultOwnerToken: "renewed-token" }));
    expect(ledger.current).toBe(1);
    await act(async () => { failOld(new Error("Old authority cancelled")); });
    expect(toast).not.toHaveBeenCalled();
    vault.vaultOwnerToken = "owner-token";
  });
});
