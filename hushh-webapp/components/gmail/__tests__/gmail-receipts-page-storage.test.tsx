import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { clearCachedGmailReceipts } from "@/lib/profile/gmail-receipts-cache";
import { loadReceiptSnapshot } from "@/lib/mail/receipt-store";
import { SecureDurableResourceService as Durable } from "@/lib/services/secure-durable-resource-service";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { GmailReceiptRequestError } from "@/lib/services/gmail-receipts-service";

const fixture = vi.hoisted(() => ({
  user: { uid: "synthetic-owner", getIdToken: vi.fn().mockResolvedValue("synthetic-id-token") },
  scan: vi.fn(), success: vi.fn(), clearMemory: vi.fn(), completion: 0,
  gmail: { status: { connected: true, configured: true, google_sub: "synthetic-account", receipt_sync_available: true, connection_state: "connected", last_sync_status: "completed" },
    loadingStatus: false, statusError: null, syncRun: null, sync: vi.fn(), refreshStatus: vi.fn(),
    presentation: { isConnected: true, state: "connected", badgeLabel: "Connected" } },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/gmail", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: fixture.user, loading: false }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: "12".repeat(32), vaultOwnerToken: "synthetic-owner-token", isVaultUnlocked: true }) }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({ useGmailConnectorStatus: () => fixture.gmail }));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({ usePublishVoiceSurfaceMetadata: () => undefined, useVoiceSurfaceControlTracking: () => ({ activeControlId: null, lastInteractedControlId: null }) }));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({ useLocalOnboardingActionHandler: () => undefined }));
vi.mock("@/lib/capacitor", () => ({ HushhAuth: {} }));
vi.mock("@/lib/pkm/markdown-memory", () => ({ clearMarkdownMemory: fixture.clearMemory }));
vi.mock("sonner", () => ({ toast: { success: fixture.success, error: vi.fn() } }));
vi.mock("@/components/gmail/gmail-receipt-memory-save", () => ({ GmailReceiptMemorySave: (props: { syncCompletion: number }) => { fixture.completion = props.syncCompletion; return null; } }));
vi.mock("@/components/gmail/gmail-information-requests-section", () => ({ default: () => null }));
vi.mock("@/components/gmail/gmail-verification-onboarding", () => ({ GmailVerificationOnboarding: () => null }));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({ VaultUnlockDialog: () => null }));
vi.mock("@/lib/services/gmail-receipts-service", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/services/gmail-receipts-service")>();
  return { ...original, GmailReceiptsService: { ...original.GmailReceiptsService, scanReceipts: fixture.scan } };
});
import GmailReceiptsPage from "@/components/gmail/gmail-receipts-page";
const session = { userId: "synthetic-owner", vaultKey: "12".repeat(32), vaultOwnerToken: "synthetic-owner-token" };
const account = "synthetic-account";
const receipt: ReceiptListItem = { id: 1, source_id: "synthetic-source", receipt_key: "synthetic-source", source_kind: "gmail_live", gmail_message_id: "synthetic-message", merchant_name: "Plaid", merchant_domain: "plaid.com", category: "Software & Subscriptions", category_confidence: 1,
  transaction_date: "October 9, 2026", attention_date: "October 18", attention_state: "coming_up", attention_reason: "renewal_due", amount: 10, amount_decimal: "10.00", currency: "USD", status: "paid", document_kind: "receipt", event_type: "purchase" };
const response = (items: ReceiptListItem[]) => ({ items, page: 1, has_more: false, next_cursor: null, coverage: { max_pages: 50, reached_limit: false } });
const open = () => render(<GmailReceiptsPage initialWorkspace="receipts" forceWorkspace="receipts" />);
const sync = async () => { await waitFor(() => expect(screen.getByRole("button", { name: /Start sync|Sync again/ })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: /Start sync|Sync again/ })); };
// Real encrypted IndexedDB writes need a bounded wait on shared CI runners.
beforeEach(() => {
  configure({ asyncUtilTimeout: 10000 });
  vi.restoreAllMocks(); fixture.scan.mockReset(); fixture.success.mockClear(); fixture.clearMemory.mockClear(); fixture.completion = 0;
  publishValidatedAuthSessionOwner(session.userId); clearCachedGmailReceipts(session.userId);
  Object.defineProperty(window, "indexedDB", { value: new IDBFactory(), configurable: true });
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  window.sessionStorage.clear();
});
afterEach(async () => {
  cleanup();
  // Reset lazily clears markdown memory; let that real import finish before
  // Vitest tears down this file's environment and restores its dependencies.
  await vi.dynamicImportSettled();
  vi.restoreAllMocks();
  configure({ asyncUtilTimeout: 1000 });
});

describe("receipt sync durable completion", () => {
  it.each([false, true])("shows each restored-refresh page immediately, dedupes saved groups and keeps the durable snapshot on failure (new saved event=%s)", async newSavedEvent => {
    const purchase = { ...receipt, order_id: "SHARED-ORDER" };
    const fulfillment = { ...purchase, id: 2, source_id: "saved-shipping", receipt_key: "saved-shipping",
      gmail_message_id: "saved-shipping", event_type: "fulfillment" as const, document_kind: "fulfillment" as const };
    const old = { ...receipt, id: 3, source_id: "old-udemy", receipt_key: "old-udemy", merchant_name: "Udemy", merchant_domain: "udemy.com" };
    fixture.scan.mockResolvedValueOnce(response([purchase, fulfillment, old]));
    let view = open(); await sync(); await waitFor(() => expect(fixture.completion).toBe(1));
    const baseline = await loadReceiptSnapshot(session, account);
    view.unmount(); clearCachedGmailReceipts(session.userId); view = open();
    await waitFor(() => expect(screen.getByText("Plaid")).toBeVisible());
    const completion = fixture.completion;
    let rejectPage!: (reason: unknown) => void;
    const second = new Promise((_, reject) => { rejectPage = reject; });
    const fresh = { ...receipt, id: 4, source_id: "new-amazon", receipt_key: "new-amazon", merchant_name: "Amazon", merchant_domain: "amazon.com" };
    fixture.scan.mockReset();
    const savedEvent = newSavedEvent ? { ...fulfillment, id: 5, source_id: "new-shipping", receipt_key: "new-shipping", gmail_message_id: "new-shipping" } : purchase;
    const refund = { ...purchase, id: 6, source_id: "new-refund", receipt_key: "new-refund", gmail_message_id: "new-refund", event_type: "refund" as const, status: "refunded" as const };
    fixture.scan.mockResolvedValueOnce({ ...response([savedEvent, fresh, ...(newSavedEvent ? [refund] : [])]), has_more: true, next_cursor: "synthetic-next-page" })
      .mockReturnValueOnce(second);
    await sync();
    await waitFor(() => expect(screen.getByText("Amazon")).toBeVisible());
    expect(screen.getAllByText("Plaid")).toHaveLength(newSavedEvent ? 2 : 1);
    expect(screen.getByText("Udemy")).toBeVisible();
    expect(screen.getAllByTestId("receipt-row")).toHaveLength(newSavedEvent ? 4 : 3);
    expect(screen.queryByLabelText("Loading receipts")).toBeNull();
    expect(screen.getByRole("button", { name: "Start sync" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start sync" })).toHaveAttribute("aria-busy", "true");
    expect(fixture.completion).toBe(completion);
    expect(await loadReceiptSnapshot(session, account)).toEqual(baseline);
    await act(async () => { rejectPage(new GmailReceiptRequestError("expired", 409, "GMAIL_RECEIPT_CURSOR_EXPIRED", false)); });
    await waitFor(() => expect(screen.getByText("Couldn’t finish scanning your receipts.")).toBeVisible());
    expect(fixture.scan).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Amazon")).toBeVisible();
    expect(screen.getAllByText("Plaid")).toHaveLength(newSavedEvent ? 2 : 1);
    expect(await loadReceiptSnapshot(session, account)).toEqual(baseline);
    view.unmount(); clearCachedGmailReceipts(session.userId); open();
    await waitFor(() => expect(screen.getByText("Plaid")).toBeVisible());
    expect(screen.getByText("Udemy")).toBeVisible();
    expect(screen.queryByText("Amazon")).toBeNull();
  }, 30000);

  it("reproduces printed-date UAT failure and waits for real encrypted read-back before completing, then restores on remount", async () => {
    fixture.scan.mockResolvedValue(response([receipt]));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => { await gate; return original(...args); });
    const view = open(); await sync();
    await waitFor(() => expect(decrypt).toHaveBeenCalled());
    expect(fixture.completion).toBe(0); expect(fixture.success).not.toHaveBeenCalled();
    expect(screen.getByText("Plaid")).toBeVisible();
    await act(async () => { release(); });
    await waitFor(() => expect(fixture.completion).toBe(1));
    expect(screen.queryByText(/couldn't be saved/)).not.toBeInTheDocument();
    expect(await loadReceiptSnapshot(session, account)).toMatchObject({ revision: 1, value: { rows: [{ merchant: "Plaid", transaction_date: "October 9, 2026", attention_date: "October 18" }] } });
    view.unmount(); clearCachedGmailReceipts(session.userId); open();
    await waitFor(() => expect(screen.getByText("Plaid")).toBeVisible());
    expect(fixture.scan).toHaveBeenCalledOnce();
  }, 30000);
  it.each(["GMAIL_RECEIPT_CONTRACT_MISMATCH", "GMAIL_RECEIPT_EXTRACTION_INVALID",
    "GMAIL_RECEIPT_EXTRACTION_UNVERIFIED"])("permanent %s refresh makes one attempt and keeps saved rows", async code => {
    fixture.scan.mockResolvedValueOnce(response([receipt]));
    const view = open(); await sync(); await waitFor(() => expect(fixture.completion).toBe(1));
    const baseline = await loadReceiptSnapshot(session, account);
    fixture.scan.mockClear();
    fixture.scan.mockRejectedValue(new GmailReceiptRequestError("invalid", 500, code, false));
    await sync();
    await waitFor(() => expect(screen.getByText("Couldn’t finish scanning your receipts.")).toBeVisible());
    expect(fixture.scan).toHaveBeenCalledOnce();
    expect(screen.getByText("Plaid")).toBeVisible();
    expect(screen.queryByLabelText("Loading receipts")).toBeNull();
    expect(screen.getByRole("button", { name: "Start sync" })).toHaveAttribute("aria-busy", "false");
    expect(await loadReceiptSnapshot(session, account)).toEqual(baseline);
    view.unmount(); clearCachedGmailReceipts(session.userId); open();
    await waitFor(() => expect(screen.getByText("Plaid")).toBeVisible());
    expect(fixture.scan).toHaveBeenCalledOnce();
  }, 30000);

  it.each([false, true])("failed refresh preserves rows and the previous snapshot (restored=%s)", async restored => {
    fixture.scan.mockResolvedValue(response([receipt]));
    let view = open(); await sync(); await waitFor(() => expect(fixture.completion).toBe(1));
    const baseline = await loadReceiptSnapshot(session, account);
    if (restored) { view.unmount(); clearCachedGmailReceipts(session.userId); view = open(); await waitFor(() => expect(screen.getByText("Plaid")).toBeVisible()); }
    const completion = fixture.completion; fixture.success.mockClear();
    fixture.scan.mockResolvedValue(response([{ ...receipt, source_id: "new-source", receipt_key: "new-source", merchant_name: "Udemy", amount: 99 }]));
    vi.spyOn(crypto.subtle, "decrypt").mockRejectedValueOnce(new DOMException("synthetic", "OperationError"));
    await sync();
    await waitFor(() => expect(screen.getByText(/couldn't be saved/)).toBeVisible());
    expect(fixture.completion).toBe(completion); expect(fixture.success).not.toHaveBeenCalled();
    if (restored) expect(screen.getByText("Plaid")).toBeVisible();
    expect(await loadReceiptSnapshot(session, account)).toEqual(baseline);
    view.unmount(); clearCachedGmailReceipts(session.userId); open();
    await waitFor(() => expect(screen.getByText("Plaid")).toBeVisible());
  }, 30000);
  it.each([false, true])("an empty successful scan keeps good rows and their verified snapshot (restored=%s)", async restored => {
    fixture.scan.mockResolvedValue(response([receipt]));
    let view = open(); await sync(); await waitFor(() => expect(fixture.completion).toBe(1));
    const baseline = await loadReceiptSnapshot(session, account);
    if (restored) { view.unmount(); clearCachedGmailReceipts(session.userId); view = open(); await waitFor(() => expect(screen.getByText("Plaid")).toBeVisible()); }
    const completion = fixture.completion; fixture.success.mockClear();
    fixture.scan.mockResolvedValue(response([]));
    await sync();
    await waitFor(() => expect(screen.getByText(/couldn't be saved/)).toBeVisible());
    expect(screen.getByText("Plaid")).toBeVisible();
    expect(fixture.completion).toBe(completion); expect(fixture.success).not.toHaveBeenCalled();
    expect(await loadReceiptSnapshot(session, account)).toEqual(baseline);
    view.unmount(); clearCachedGmailReceipts(session.userId); open();
    await waitFor(() => expect(screen.getByText("Plaid")).toBeVisible());
    expect(fixture.scan).toHaveBeenCalledTimes(2);
  }, 30000);
  it("a provider failure after a partial refresh keeps the previous verified snapshot", async () => {
    fixture.scan.mockResolvedValueOnce(response([receipt]));
    open(); await sync(); await waitFor(() => expect(fixture.completion).toBe(1));
    const baseline = await loadReceiptSnapshot(session, account);
    fixture.scan.mockResolvedValueOnce({ ...response([{ ...receipt, source_id: "partial-source", receipt_key: "partial-source" }]), has_more: true, next_cursor: "synthetic-cursor" });
    fixture.scan.mockRejectedValueOnce(new Error("synthetic provider unavailable"));
    await sync();
    await waitFor(() => expect(screen.getByText("Couldn’t finish scanning your receipts.")).toBeVisible());
    expect(fixture.completion).toBe(1);
    expect(await loadReceiptSnapshot(session, account)).toEqual(baseline);
  }, 30000);
  it("a stale pre-Reset read-back failure cannot mark the next scan as failed", async () => {
    fixture.scan.mockResolvedValueOnce(response([receipt]));
    let releaseOld!: () => void;
    const gate = new Promise<void>(resolve => { releaseOld = resolve; });
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => { await gate; return originalDecrypt(...args); });
    open(); await sync(); await waitFor(() => expect(decrypt).toHaveBeenCalled());
    await act(async () => { await Durable.purgeUser(session.userId); });
    await waitFor(() => expect(fixture.clearMemory).toHaveBeenCalledExactlyOnceWith(session.userId));
    await act(async () => { releaseOld(); });
    await waitFor(() => expect(screen.getByRole("button", { name: /Start sync/ })).toBeEnabled());
    expect(screen.queryByText(/couldn't be saved/)).not.toBeInTheDocument();
    let finishNew!: (value: ReturnType<typeof response>) => void;
    fixture.scan.mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    await sync(); await waitFor(() => expect(fixture.scan).toHaveBeenCalledTimes(2));
    await act(async () => { finishNew(response([receipt])); });
    await waitFor(() => expect(fixture.completion).toBe(1));
    expect(fixture.success).toHaveBeenCalledOnce();
    expect(screen.queryByText(/couldn't be saved/)).not.toBeInTheDocument();
    expect(await loadReceiptSnapshot(session, account)).toMatchObject({ generation: 1, revision: 1 });
  }, 30000);
  it("Reset fences a scan already waiting on the provider", async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    fixture.scan.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    open(); await sync(); await waitFor(() => expect(fixture.scan).toHaveBeenCalled());
    await act(async () => { await Durable.purgeUser(session.userId); finish(response([receipt])); });
    await waitFor(() => expect(fixture.clearMemory).toHaveBeenCalledExactlyOnceWith(session.userId));
    await waitFor(() => expect(screen.getByRole("button", { name: /Start sync/ })).toBeEnabled());
    expect(screen.queryByText("Plaid")).not.toBeInTheDocument(); expect(fixture.completion).toBe(0);
    expect(await loadReceiptSnapshot(session, account)).toBeNull();
  }, 30000);
});
