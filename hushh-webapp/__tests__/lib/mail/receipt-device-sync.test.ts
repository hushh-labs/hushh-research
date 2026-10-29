import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { registerReceiptSyncAuth, startBackgroundReceiptSync, syncReceiptsOnDevice } from "@/lib/mail/receipt-device-sync";
import { loadReceiptSnapshot } from "@/lib/mail/receipt-store";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { GmailReceiptsService, type GmailConnectionStatus, type GmailLiveReceiptScanResponse } from "@/lib/services/gmail-receipts-service";
import { MailReceiptResourceService as Resource } from "@/lib/services/mail-receipt-resource-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

const connector = vi.hoisted(() => ({ status: null as null | Record<string, unknown> }));
vi.mock("@/lib/profile/gmail-connector-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/profile/gmail-connector-store")>(), getConnectorView: () => ({ status: connector.status }) }));

const session = { userId: "owner", vaultKey: "12".repeat(32), vaultOwnerToken: "owner-token" };
const emptyPage = (): GmailLiveReceiptScanResponse => ({ items: [], page: 1, per_page: 6, returned_count: 0, sync_mode: "bootstrap",
  checkpoint: "grc1_" + "a".repeat(64), has_more: false,
  coverage: { source: "gmail_live", listed_count: 0, candidate_count: 0, matched_count: 0, pages_scanned: 1, max_messages: 6, max_pages: 50,
    reached_limit: false, query_scope: "receipt_signals_all_mail_except_spam_trash", rejection_counts: { missing_receipt_signal: 0, extractor_not_receipt: 0 },
    evidence_counts: { gmail_category: 0, subject_signal: 0, body_signal: 0, verified_merchant: 0, order_candidate: 0, total_candidate: 0 } } });
beforeEach(() => {
  Resource.clear("owner"); vi.restoreAllMocks(); publishValidatedAuthSessionOwner("owner"); advanceVaultSessionEpoch();
  connector.status = { configured: true, connected: true, revoked: false, google_sub: "account", receipt_sync_available: true };
  Object.defineProperty(window, "indexedDB", { value: new IDBFactory(), configurable: true });
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

describe("receipt sync on by default", () => {
  it("syncs a device with no saved receipts once per owner vault session, and skips a fresh one", async () => {
    const release = registerReceiptSyncAuth("owner", async () => "id-token");
    const scan = vi.spyOn(GmailReceiptsService, "scanReceipts").mockResolvedValue(emptyPage());
    await expect(startBackgroundReceiptSync(session)).resolves.toBe("synced");
    // Negative control: a remount or second trigger in the same vault session must not scan again.
    await expect(startBackgroundReceiptSync(session)).resolves.toBe("skipped");
    advanceVaultSessionEpoch();
    await expect(startBackgroundReceiptSync(session)).resolves.toBe("skipped");
    expect(scan).toHaveBeenCalledOnce();
    expect(scan.mock.calls[0][0]).toMatchObject({ idToken: "id-token", userId: "owner", accountKey: "account" });
    release();
    await expect(syncReceiptsOnDevice(session)).resolves.toBe("unavailable");
    registerReceiptSyncAuth("owner", async () => "id-token");
    connector.status = { ...connector.status, receipt_sync_available: false };
    await expect(syncReceiptsOnDevice(session)).resolves.toBe("unavailable");
    expect(scan).toHaveBeenCalledOnce();
  });

  it("leaves the vault session free when a credential renewal ends a run before it finished", async () => {
    registerReceiptSyncAuth("owner", async () => "id-token");
    let active = true;
    let finish!: (page: GmailLiveReceiptScanResponse) => void;
    const scan = vi.spyOn(GmailReceiptsService, "scanReceipts")
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(emptyPage());
    const first = startBackgroundReceiptSync({ ...session, isCurrent: () => active });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    active = false; // The bridge re-ran for a renewed owner token.
    finish(emptyPage());
    await first;
    await expect(startBackgroundReceiptSync(session)).resolves.toBe("synced");
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("discards a sync the vault locked under and never reports it as synced", async () => {
    registerReceiptSyncAuth("owner", async () => "id-token");
    let finish!: (page: GmailLiveReceiptScanResponse) => void;
    vi.spyOn(GmailReceiptsService, "scanReceipts").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = startBackgroundReceiptSync(session);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    advanceVaultSessionEpoch();
    finish(emptyPage());
    await expect(pending).resolves.toBe("failed");
    await expect(loadReceiptSnapshot(session, "account")).resolves.toBeNull();
  });

  it("resumes an interrupted sync from its saved page in the next vault session instead of treating it as fresh", async () => {
    registerReceiptSyncAuth("owner", async () => "id-token");
    let active = true;
    const scan = vi.spyOn(GmailReceiptsService, "scanReceipts")
      .mockResolvedValueOnce({ ...emptyPage(), has_more: true, next_cursor: "page-2-cursor" }).mockImplementationOnce(() => new Promise(() => undefined));
    const first = startBackgroundReceiptSync({ ...session, isCurrent: () => active });
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    active = false; Resource.retireObsolete("owner"); advanceVaultSessionEpoch();
    await expect(first).resolves.toBe("failed");
    scan.mockResolvedValueOnce(emptyPage());
    // Negative control: the first test shows a finished snapshot under a day old still skips.
    await expect(startBackgroundReceiptSync(session)).resolves.toBe("synced");
    expect(scan.mock.calls[2]![0]).toMatchObject({ cursor: "page-2-cursor", page: 2 });
  });

  it("stops a running receipt sync before Mail disconnects, so its late page never saves", async () => {
    registerReceiptSyncAuth("owner", async () => "id-token");
    let finish!: (page: GmailLiveReceiptScanResponse) => void;
    vi.spyOn(GmailReceiptsService, "scanReceipts").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const connected = { configured: true, connected: true, status: "connected", revoked: false, scope_csv: "", auto_sync_enabled: false } as GmailConnectionStatus;
    vi.spyOn(GmailReceiptsService, "getStatus").mockResolvedValue(connected);
    const pending = startBackgroundReceiptSync(session);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    let outcome: unknown;
    vi.spyOn(GmailReceiptsService, "disconnect").mockImplementation(async () => {
      finish(emptyPage()); // The provider answers while the disconnect request is in flight.
      outcome = await pending;
      return { ...connected, connected: false, status: "disconnected" };
    });
    const { result } = renderHook(() => useGmailConnectorStatus({ userId: "owner", idTokenProvider: async () => "id-token" }));
    await act(async () => { await result.current.disconnectGmail(); });
    expect(outcome).toBe("failed");
    await expect(loadReceiptSnapshot(session, "account")).resolves.toBeNull();
  });
});
