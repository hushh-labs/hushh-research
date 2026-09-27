import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveSearchError, type DriveSearchStatus, type DriveSearchResults } from "@/lib/services/drive-search-service";
const state = vi.hoisted(() => ({
  uid: "owner-a", unlocked: true, token: "token-a", epoch: 1,
  getToken: vi.fn(), tick: null as null | (() => unknown),
  service: { recent: vi.fn(), create: vi.fn(), get: vi.fn(), results: vi.fn(), stop: vi.fn() },
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
  files: [{ id: "file-one", name: "Explain For Product", mimeType: "application/vnd.google-apps.document",
    modifiedTime: null, openUrl: "https://docs.google.com/document/d/file-one/edit" }], ...overrides,
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
beforeEach(() => {
  vi.clearAllMocks();
  state.uid = "owner-a"; state.unlocked = true; state.token = "token-a"; state.epoch = 1;
  state.getToken.mockImplementation(() => state.token);
  state.service.recent.mockResolvedValue([job()]); state.service.get.mockResolvedValue(job());
  state.service.results.mockResolvedValue(page()); state.service.create.mockResolvedValue(job());
  state.service.stop.mockResolvedValue(job({ status: "stopped", revision: 3, canStop: false }));
});
afterEach(cleanup);

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
    expect(screen.getByText("Searching · 125 found")).toBeTruthy();
    state.service.results.mockResolvedValueOnce(page({ files: [{ ...page().files[0], id: "next", name: "Next match" }], nextCursor: null }));
    fireEvent.click(screen.getByRole("button", { name: "Next 25" }));
    await screen.findByRole("link", { name: "Next match" });
    expect(state.service.results.mock.calls.at(-1)?.[3]).toBe("page-two");
    rendered.unmount();
    expect(state.service.stop).not.toHaveBeenCalled();
    render(<DriveBackgroundSearches />);
    await screen.findByRole("link", { name: "Explain For Product" });
    expect(state.service.recent).toHaveBeenCalledTimes(2);
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
      files: [{ ...page().files[0], id: "second", name: "Second page result" }] }));
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
