import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveSearchError, type DriveSearchStatus, type DriveSearchResults } from "@/lib/services/drive-search-service";
import type { DriveBulkShareView } from "@/lib/services/drive-sharing-service";
const state = vi.hoisted(() => ({
  uid: "owner-a", unlocked: true, token: "token-a", epoch: 1,
  getToken: vi.fn(), tick: null as null | (() => unknown),
  service: { recent: vi.fn(), create: vi.fn(), get: vi.fn(), results: vi.fn(), stop: vi.fn() },
  bulk: { recentBulkShares: vi.fn(), bulkSharesForSearch: vi.fn(), bulkShareFiles: vi.fn(),
    prepareBulkShare: vi.fn(), approveBulkShare: vi.fn(), stopBulkShare: vi.fn() },
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
import { ContinueDriveSearch, DriveBackgroundSearchCard, DriveBackgroundSearches } from "@/components/agent/drive-background-search";
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
  state.uid = "owner-a"; state.unlocked = true; state.token = "token-a"; state.epoch = 1;
  state.getToken.mockImplementation(() => state.token);
  state.service.recent.mockResolvedValue([job()]); state.service.get.mockResolvedValue(job());
  state.service.results.mockResolvedValue(page()); state.service.create.mockResolvedValue(job());
  state.service.stop.mockResolvedValue(job({ status: "stopped", revision: 3, canStop: false }));
  state.bulk.recentBulkShares.mockResolvedValue([]); state.bulk.bulkSharesForSearch.mockResolvedValue([]);
  state.bulk.bulkShareFiles.mockResolvedValue({ shareId: bulkReview().shareId, files: [{ position: 1,
    name: "Explain For Product", mimeType: "application/vnd.google-apps.document", modifiedTime: null, openUrl: null }], nextCursor: null });
  state.bulk.prepareBulkShare.mockResolvedValue(bulkReview());
  state.bulk.approveBulkShare.mockResolvedValue({ ...bulkReview(), status: "queued", canApprove: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("durable Drive search UI", () => {
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
    await screen.findByText(/Sharing · 0 of 125 file access checks/);
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
