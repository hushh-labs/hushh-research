import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const save = vi.hoisted(() => vi.fn().mockResolvedValue({ count: 0 }));
vi.mock("@/lib/profile/gmail-receipt-memory-save", () => ({ saveReceiptCanonicalIndexToMemory: save }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "synthetic-owner" } }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-token", isVaultUnlocked: true }) }));

import { GmailReceiptMemorySave } from "@/components/gmail/gmail-receipt-memory-save";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("passes an impossible fence for a legacy caller instead of reading a newer Reset generation", async () => {
  render(<GmailReceiptMemorySave receipts={[{ id: 1 } as ReceiptListItem]}
    accountKey="synthetic-mail-account" syncCompletion={1} savedCompletionRef={{ current: 0 }} />);
  await act(async () => {});
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ ownerGeneration: -1, snapshotRevision: -1 }));
});

it("clears a completed empty scan only after the page supplies its verified snapshot fence", async () => {
  const ledger = { current: 0 };
  const view = (ownerGeneration?: number, snapshotRevision?: number) => <GmailReceiptMemorySave
    receipts={[]} accountKey="synthetic-mail-account" syncCompletion={1} savedCompletionRef={ledger}
    ownerGeneration={ownerGeneration} snapshotRevision={snapshotRevision} />;
  const { rerender } = render(view());
  await act(async () => {});
  expect(save).not.toHaveBeenCalled();
  expect(ledger.current).toBe(0);
  rerender(view(0, 1));
  await act(async () => {});
  expect(save).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ receipts: [], ownerGeneration: 0, snapshotRevision: 1 }));
  expect(ledger.current).toBe(1);
});
