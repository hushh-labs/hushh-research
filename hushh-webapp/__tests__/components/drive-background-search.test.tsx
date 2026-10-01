import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { DriveSearchError, type DriveSearchStatus, type DriveSearchResults } from "@/lib/services/drive-search-service";
import type { DriveBulkShareView } from "@/lib/services/drive-sharing-service";
const state = vi.hoisted(() => ({
  uid: "owner-a", unlocked: true, token: "token-a", epoch: 1,
  getToken: vi.fn(), tick: null as null | (() => unknown),
  service: { recent: vi.fn(), create: vi.fn(), get: vi.fn(), results: vi.fn(), stop: vi.fn() },
  bulk: { recentBulkShares: vi.fn(), bulkSharesForSearch: vi.fn(), bulkShareFiles: vi.fn(),
    prepareBulkShare: vi.fn(), approveBulkShare: vi.fn(), stopBulkShare: vi.fn(), bulkShareStatus: vi.fn(), retryBulkShare: vi.fn() },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid } }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({
  isVaultUnlocked: state.unlocked, getVaultOwnerToken: state.getToken,
}) }));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch, isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
vi.mock("@/lib/perf/use-periodic-task", () => ({
  useCoarseClock: () => Date.now(),
  usePeriodicTask: (_id: string, _interval: number, tick: () => unknown, options: { enabled: boolean }) => {
    state.tick = options.enabled ? tick : null;
  },
}));
vi.mock("@/lib/services/drive-search-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-search-service")>()), DriveSearchService: state.service,
}));
vi.mock("@/lib/services/drive-sharing-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-sharing-service")>()), DriveSharingService: state.bulk,
}));
import { ContinueDriveSearch, DriveBackgroundSearchCard, DriveBackgroundSearches, DriveRecentSharing } from "@/components/agent/drive-background-search";
import { ConnectorReadReceipt } from "@/components/agent/connector-read-receipt";
const jobId = "11111111-1111-4111-8111-111111111111";
const job = (overrides: Partial<DriveSearchStatus> = {}): DriveSearchStatus => ({
  jobId, status: "running", revision: 1, matched: 125, pagesScanned: 5, incompleteSearch: true,
  canStop: true, createdAt: new Date(Date.now() - 25_000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), updatedAt: new Date().toISOString(),
  errorCode: null, ...overrides,
});
const page = (overrides: Partial<DriveSearchResults> = {}): DriveSearchResults => ({
  jobId, revision: 1, matched: 125, nextCursor: "page-two",
  files: [{ position: 1, id: "file-one", name: "Explain For Product", mimeType: "application/vnd.google-apps.document",
    modifiedTime: null, openUrl: "https://docs.google.com/document/d/file-one/edit" }], ...overrides,
});
const bulkReview = (): DriveBulkShareView => ({
  shareId: "22222222-2222-4222-8222-222222222222", searchJobId: jobId, status: "review_ready", revision: 1,
  reviewDigest: "a".repeat(64), fileCount: 125, recipientCount: 1,
  recipients: [{ name: "Alex", email: "alex@example.com" }], excluded: [],
  counts: { total: 125, processed: 0, shared: 0, alreadyShared: 0, skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 125 },
  notifications: { settled: 0, pending: 0, unavailable: 0 },
  canApprove: true, canStop: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  window.localStorage.clear();
  state.uid = "owner-a"; state.unlocked = true; state.token = "token-a"; state.epoch = 1;
  state.getToken.mockImplementation(() => state.token);
  state.service.recent.mockResolvedValue([job()]); state.service.get.mockResolvedValue(job());
  state.service.results.mockResolvedValue(page()); state.service.create.mockResolvedValue(job());
  state.service.stop.mockResolvedValue(job({ status: "stopped", revision: 3, canStop: false }));
  state.bulk.recentBulkShares.mockResolvedValue([]); state.bulk.bulkSharesForSearch.mockResolvedValue([]);
  state.bulk.bulkShareFiles.mockResolvedValue({ shareId: bulkReview().shareId, files: [{ position: 1,
    name: "Explain For Product", mimeType: "application/vnd.google-apps.document", modifiedTime: null, openUrl: null }], nextCursor: null });
  state.bulk.prepareBulkShare.mockResolvedValue(bulkReview());
  state.bulk.bulkShareStatus.mockResolvedValue(bulkReview());
  state.bulk.approveBulkShare.mockResolvedValue({ ...bulkReview(), status: "queued", canApprove: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("durable Drive search UI", () => {
  it("does not read or poll Drive sharing while the chat drawer is closed", async () => {
    const view = render(<DriveRecentSharing presentation="sidebar" active={false} />);
    expect(state.bulk.recentBulkShares).not.toHaveBeenCalled();
    expect(state.tick).toBeNull();

    view.rerender(<DriveRecentSharing presentation="sidebar" active />);
    await waitFor(() => expect(state.bulk.recentBulkShares).toHaveBeenCalledTimes(1));
    expect(state.tick).not.toBeNull();

    view.rerender(<DriveRecentSharing presentation="sidebar" active={false} />);
    expect(state.tick).toBeNull();
  });

  it("keeps completed Drive batches in Feed-style sidebar rows and opens details only on request", async () => {
    const seven: DriveBulkShareView = { ...bulkReview(), status: "completed", canApprove: false, canStop: false,
      counts: { total: 7, processed: 7, shared: 4, alreadyShared: 3, skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 0 } };
    const twentyFive: DriveBulkShareView = { ...seven, shareId: "33333333-3333-4333-8333-333333333333",
      counts: { total: 25, processed: 25, shared: 11, alreadyShared: 14, skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 0 } };
    state.bulk.recentBulkShares.mockResolvedValue([seven, twentyFive]);
    state.bulk.bulkShareStatus.mockImplementation(async (_token: string, shareId: string) =>
      shareId === seven.shareId ? seven : twentyFive);
    render(<DriveRecentSharing presentation="sidebar" />);

    const first = await screen.findByRole("button", { name: "Files are ready. 7 of 7 available. View details" });
    expect(screen.getByRole("button", { name: "Files are ready. 25 of 25 available. View details" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Drive sharing activity" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Drive sharing", exact: true })).toBeNull();
    expect(state.bulk.bulkShareStatus).not.toHaveBeenCalled();

    fireEvent.click(first);
    await screen.findByRole("dialog", { name: "Drive sharing" });
    await screen.findByText("7 of 7 files available");
    expect(screen.getByRole("button", { name: "Hide this update" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Close Drive sharing card" })).toBeNull();
    expect(screen.queryByLabelText("Sharing complete")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide this update" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Files are ready. 7 of 7 available. View details" })).toBeNull());
    expect(screen.getByRole("button", { name: "Files are ready. 25 of 25 available. View details" })).toBeVisible();
    expect(state.bulk.stopBulkShare).not.toHaveBeenCalled();
    await waitFor(() => expect(window.localStorage.length).toBe(1));
  });

  it("keeps a manual Drive review available from the sidebar without approving on open", async () => {
    state.bulk.recentBulkShares.mockResolvedValue([bulkReview()]);
    const onNeedsReviewChange = vi.fn();
    render(<DriveRecentSharing presentation="sidebar" onNeedsReviewChange={onNeedsReviewChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review files. 125 files to review. View details" }));
    await screen.findByRole("button", { name: "Share 125 files with 1 person" });
    expect(onNeedsReviewChange).toHaveBeenCalledWith(1);
    expect(state.bulk.approveBulkShare).not.toHaveBeenCalled();
  });

  it("keeps a pending review visible while limiting old updates above chat history", async () => {
    const completed = { ...bulkReview(), status: "completed" as const, canApprove: false,
      counts: { total: 1, processed: 1, shared: 1, alreadyShared: 0, skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 0 } };
    state.bulk.recentBulkShares.mockResolvedValue([
      ...[1, 2, 3, 4].map(index => ({ ...completed, shareId: `33333333-3333-4333-8333-33333333333${index}` })),
      bulkReview(),
    ]);
    render(<DriveRecentSharing presentation="sidebar" />);
    await screen.findByRole("button", { name: "Review files. 125 files to review. View details" });
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Show all 5 updates" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer updates" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("does not offer a background search without a visible results surface", () => {
    render(<ConnectorReadReceipt experience={{
      type: "one.connector_read.v1", connector: "drive", status: "response_too_large",
      sourceRefs: [], truncated: false, metadataOnly: true,
      backgroundSearchAvailable: true, backgroundSearchQuery: "Find product documents",
    }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Try a narrower Drive search");
    expect(screen.queryByRole("button", { name: "Continue in background" })).toBeNull();
  });

  it("keeps an existing sharing review visible without recent Drive searches", async () => {
    state.bulk.recentBulkShares.mockResolvedValueOnce([bulkReview()]);
    state.bulk.bulkSharesForSearch.mockResolvedValue([bulkReview()]);
    render(<DriveRecentSharing />);

    await screen.findByText("Review 125 files with 1 person");
    await screen.findByRole("button", { name: "Share 125 files with 1 person" });
    expect(screen.getByText("Review Drive sharing")).toBeTruthy();
    expect(screen.queryByLabelText("Drive searches")).toBeNull();
    expect(state.service.recent).not.toHaveBeenCalled();
    expect(state.bulk.approveBulkShare).not.toHaveBeenCalled();
  });

  it("closes an active card without stopping and remembers only an owner-scoped UI dismissal after reload", async () => {
    const active = { ...bulkReview(), status: "running" as const, canApprove: false };
    state.bulk.recentBulkShares.mockResolvedValue([active]); state.bulk.bulkShareStatus.mockResolvedValue(active);
    const first = render(<DriveRecentSharing />);
    await screen.findByText("Sharing files");
    fireEvent.click(screen.getByRole("button", { name: "Close Drive sharing card" }));
    expect(screen.queryByRole("region", { name: "Drive sharing" })).toBeNull();
    expect(state.bulk.stopBulkShare).not.toHaveBeenCalled();
    await waitFor(() => expect(window.localStorage.length).toBe(1));
    const stored = window.localStorage.getItem("hushh:drive-sharing-dismissals:v1")!;
    for (const privateValue of [state.uid, state.token, active.shareId, active.searchJobId, "alex@example.com", "Explain For Product"])
      expect(stored).not.toContain(privateValue);
    first.unmount();
    const second = render(<DriveRecentSharing />);
    await waitFor(() => expect(state.bulk.recentBulkShares).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise(done => setTimeout(done, 20)); });
    expect(screen.queryByRole("region", { name: "Drive sharing" })).toBeNull();
    state.uid = "owner-b"; state.token = "token-b"; state.epoch += 1;
    second.rerender(<DriveRecentSharing />);
    await screen.findByText("Sharing files");
    expect(state.bulk.stopBulkShare).not.toHaveBeenCalled();
  });

  it("still closes when browser preferences cannot be written", async () => {
    const active = { ...bulkReview(), status: "queued" as const, canApprove: false };
    state.bulk.recentBulkShares.mockResolvedValue([active]); state.bulk.bulkShareStatus.mockResolvedValue(active);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
    render(<DriveRecentSharing />);
    await screen.findByText("Sharing files");
    fireEvent.click(screen.getByRole("button", { name: "Close Drive sharing card" }));
    expect(screen.queryByText("Sharing files")).toBeNull();
    expect(state.bulk.stopBulkShare).not.toHaveBeenCalled();
  });

  it("shows available files and the actual reason, and retries only the server-approved unshared selection", async () => {
    const partial: DriveBulkShareView = { ...bulkReview(), status: "partial", fileCount: 72, canApprove: false, canStop: false,
      canRetry: true, retryableCount: 1, counts: { total: 72, processed: 72, shared: 62, alreadyShared: 9, skipped: 1,
        failed: 0, needsReview: 0, unknown: 0, pending: 0 }, issues: [{ reasonCode: "provider_unavailable", count: 1 }] };
    state.bulk.recentBulkShares.mockResolvedValue([partial]); state.bulk.bulkShareStatus.mockResolvedValue(partial);
    state.bulk.retryBulkShare.mockResolvedValue({ ...partial, status: "queued", canRetry: false, canStop: true,
      counts: { ...partial.counts, processed: 71, skipped: 0, pending: 1 }, issues: [] });
    render(<DriveRecentSharing />);
    await screen.findByText("71 of 72 files available");
    expect(screen.getByText("Sharing incomplete")).toBeTruthy();
    expect(screen.getByText("62 newly shared")).toBeTruthy();
    expect(screen.getByText("9 already had access")).toBeTruthy();
    expect(screen.getByText(/Google Drive was unavailable/)).toBeTruthy();
    expect(screen.queryByText(/Notifications:|0 failed|file access checks|Sharing partial/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry 1 unshared file" }));
    await screen.findByText("Sharing files");
    expect(state.bulk.retryBulkShare).toHaveBeenCalledWith(state.token, partial, expect.any(Function));
    expect(state.bulk.approveBulkShare).not.toHaveBeenCalled();
  });

  it("stops remaining work with an acknowledged receipt and rejects an older running poll", async () => {
    const active: DriveBulkShareView = { ...bulkReview(), status: "running", canApprove: false };
    const stopped: DriveBulkShareView = { ...active, status: "stopped", revision: 3, canStop: false,
      counts: { ...active.counts, processed: 125, pending: 0, skipped: 125 } };
    state.bulk.recentBulkShares.mockResolvedValue([active]); state.bulk.bulkShareStatus.mockResolvedValue(active);
    state.bulk.stopBulkShare.mockResolvedValue(stopped);
    render(<DriveRecentSharing />); await screen.findByText("Sharing files");
    const old = deferred<DriveBulkShareView>(); state.bulk.bulkShareStatus.mockReturnValueOnce(old.promise);
    act(() => { void state.tick?.(); });
    fireEvent.click(screen.getByRole("button", { name: "Stop remaining" }));
    await screen.findByText("Sharing stopped");
    expect(screen.getByText("Files already shared stay available.")).toBeTruthy();
    await act(async () => { old.resolve(active); });
    expect(screen.queryByText("Sharing files")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop remaining" })).toBeNull();
    expect(state.bulk.stopBulkShare).toHaveBeenCalledWith(state.token, active.shareId, expect.any(Function));
  });

  it("labels multiple-recipient effects accurately and does not show an issue for fully delivered shares", async () => {
    const completed: DriveBulkShareView = { ...bulkReview(), status: "completed", recipientCount: 2, canApprove: false, canStop: false,
      counts: { total: 250, processed: 250, shared: 248, alreadyShared: 2, skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 0 } };
    state.bulk.recentBulkShares.mockResolvedValue([completed]); state.bulk.bulkShareStatus.mockResolvedValue(completed);
    render(<DriveRecentSharing />);
    await screen.findByText("250 of 250 file shares complete");
    expect(screen.getByText("Files are ready")).toBeTruthy();
    expect(screen.queryByText(/needs attention|Sharing partial|0 failed/)).toBeNull();
    // The card paints from the recent-shares row on its first commit and only
    // then refreshes by id from a passive effect, so the text above is no proof
    // the refresh ran. Wait for the call itself; under CI load React can yield
    // before flushing that effect (reproduced 1 in 240 locally).
    await waitFor(() => expect(state.bulk.bulkShareStatus).toHaveBeenCalledWith(state.token, completed.shareId, expect.any(Function)));
    expect(state.bulk.bulkSharesForSearch).not.toHaveBeenCalled();
  });

  it("requires a scoped tap and reuses the create key after an uncertain response", async () => {
    state.service.create.mockRejectedValueOnce(new Error("network"));
    render(<ContinueDriveSearch query="Find product documents" />);
    expect(state.service.create).not.toHaveBeenCalled();
    expect(screen.getByText("Matches keep loading after you leave. Stop anytime.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue in background" }));
    await screen.findByText("Couldn’t load this search. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Continue in background" }));
    await screen.findByText("Searching in the background. See Drive searches.");
    expect(state.service.create.mock.calls[0].slice(0, 3)).toEqual(state.service.create.mock.calls[1].slice(0, 3));
    expect(state.service.create.mock.calls[0][1]).toBe("Find product documents");
  });

  it("restores after reopening, pages results, and never stops on tab unmount", async () => {
    const rendered = render(<DriveBackgroundSearches />);
    await screen.findByRole("link", { name: "Explain For Product" });
    expect(screen.getByText("Recent Drive searches · 1")).toBeTruthy();
    expect(screen.getByText("Searching · 125 found")).toBeTruthy();
    expect(screen.getByText(/elapsed · Expires in/)).toBeTruthy();
    state.service.results.mockResolvedValueOnce(page({ files: [{ ...page().files[0], position: 26, id: "next", name: "Next match" }], nextCursor: null }));
    fireEvent.click(screen.getByRole("button", { name: "Next 25" }));
    await screen.findByRole("link", { name: "Next match" });
    expect(state.service.results.mock.calls.at(-1)?.[3]).toBe("page-two");
    rendered.unmount();
    expect(state.service.stop).not.toHaveBeenCalled();
    render(<DriveBackgroundSearches />);
    await screen.findByRole("link", { name: "Explain For Product" });
    expect(state.service.recent).toHaveBeenCalledTimes(2);
  });

  it("hands a selected saved result to chat without sending its file ID or link", async () => {
    const onUseInChat = vi.fn();
    render(<DriveBackgroundSearches onUseInChat={onUseInChat} />);
    await screen.findByRole("link", { name: "Explain For Product" });
    fireEvent.click(screen.getByRole("button", { name: "Use Explain For Product in chat" }));
    expect(onUseInChat).toHaveBeenCalledWith({ jobId, position: 1, name: "Explain For Product" });
  });

  it("reviews a complete frozen search before any bulk grant and blocks incomplete sets", async () => {
    const completed = job({ status: "completed", canStop: false, incompleteSearch: false });
    state.service.get.mockResolvedValue(completed);
    render(<DriveBackgroundSearchCard initial={completed} getToken={state.getToken} />);
    const review = await screen.findByRole("button", { name: "Review sharing" });
    expect(state.bulk.prepareBulkShare).not.toHaveBeenCalled();
    fireEvent.click(review);
    await screen.findByRole("button", { name: "Share 125 files with 1 person" });
    expect(state.bulk.prepareBulkShare).toHaveBeenCalledWith(state.token, jobId, expect.any(Function), jobId);
    expect(state.bulk.approveBulkShare).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Share 125 files with 1 person" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Share 125 files with 1 person" }));
    await waitFor(() => expect(state.bulk.approveBulkShare).toHaveBeenCalledTimes(1));
    await screen.findByText("0 of 125 files available");
    cleanup();
    state.service.get.mockResolvedValue(job({ status: "limited", canStop: false, incompleteSearch: true }));
    render(<DriveBackgroundSearchCard initial={job({ status: "limited", canStop: false, incompleteSearch: true })}
      getToken={state.getToken} />);
    await screen.findByRole("link", { name: "Explain For Product" });
    expect(screen.queryByRole("button", { name: "Review sharing" })).toBeNull();
  });

  it("hides results when their saved search expires", async () => {
    const expiresAt = new Date(Date.now() + 5_000).toISOString();
    state.service.recent.mockResolvedValueOnce([job({ expiresAt })]);
    const rendered = render(<DriveBackgroundSearches />);
    await screen.findByRole("link", { name: "Explain For Product" });
    expect(screen.getByText(/Expires in/)).toBeTruthy();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiresAt) + 1);
    rendered.rerender(<DriveBackgroundSearches />);
    expect(screen.queryByRole("link", { name: "Explain For Product" })).toBeNull();
  });

  it("Stop supersedes an in-flight poll so late running state cannot resume the card", async () => {
    render(<DriveBackgroundSearchCard initial={job()} getToken={state.getToken} />);
    await screen.findByRole("link", { name: "Explain For Product" });
    const pending = deferred<DriveSearchStatus>();
    state.service.get.mockReturnValueOnce(pending.promise);
    let poll: unknown;
    act(() => { poll = state.tick?.(); });
    state.service.results.mockResolvedValue(page({ revision: 3 }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped · 125 found");
    await act(async () => { pending.resolve(job({ revision: 2 })); await poll; });
    expect(screen.getByText("Stopped · 125 found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("status"));
  });

  it("Stop during page navigation keeps the selected page and rejects its late response", async () => {
    render(<DriveBackgroundSearchCard initial={job()} getToken={state.getToken} />);
    await screen.findByRole("link", { name: "Explain For Product" });
    const pending = deferred<DriveSearchResults>();
    state.service.results.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Next 25" }));
    await waitFor(() => expect(state.service.results).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "Explain For Product" })).toBeNull();
    state.service.results.mockResolvedValueOnce(page({ revision: 3,
      files: [{ ...page().files[0], position: 26, id: "second", name: "Second page result" }] }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped · 125 found");
    await screen.findByRole("link", { name: "Second page result" });
    expect(state.service.results.mock.calls.at(-1)?.[3]).toBe("page-two");
    await act(async () => { pending.resolve(page({ revision: 2 })); await pending.promise; });
    expect(screen.queryByRole("link", { name: "Explain For Product" })).toBeNull();
    expect(screen.getByRole("link", { name: "Second page result" })).toBeTruthy();
  });

  it("clears links on a failed status read and on owner/vault change", async () => {
    const rendered = render(<DriveBackgroundSearches />);
    await screen.findByRole("link", { name: "Explain For Product" });
    state.service.get.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => { await state.tick?.(); });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Couldn’t load this search. Try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("link", { name: "Explain For Product" });
    state.unlocked = false; ++state.epoch;
    rendered.rerender(<DriveBackgroundSearches />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Searching · 125 found")).toBeNull();
  });

  it("keeps Stop available after connection loss and preserves its confirmation without private results", async () => {
    render(<DriveBackgroundSearchCard initial={job()} getToken={state.getToken} />);
    await screen.findByRole("link", { name: "Explain For Product" });
    state.service.results.mockRejectedValue(new DriveSearchError("connection_changed"));
    await act(async () => { await state.tick?.(); });
    expect(screen.queryByRole("link")).toBeNull();
    expect(state.tick).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped · 125 found");
    await screen.findByText("Couldn’t load saved results.");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(state.tick).toBeNull();
    expect(state.service.stop).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("status"));
  });

  it("rejects a former owner's late recovery response", async () => {
    const pending = deferred<DriveSearchStatus[]>();
    state.service.recent.mockReturnValueOnce(pending.promise);
    const rendered = render(<DriveBackgroundSearches />);
    state.uid = "owner-b"; state.token = "token-b"; ++state.epoch;
    state.service.recent.mockResolvedValueOnce([]);
    rendered.rerender(<DriveBackgroundSearches />);
    await act(async () => { pending.resolve([job()]); await pending.promise; });
    await waitFor(() => expect(state.service.recent).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByLabelText("Drive searches")).toBeNull();
  });
});
