import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  uid: "a",
  providers: [] as { providerId: string; email: string | null }[],
  unlocked: true,
  token: "owner-a",
  epoch: 1,
  getToken: vi.fn(),
  status: vi.fn(),
  review: vi.fn(),
  delivery: vi.fn(),
  approve: vi.fn(),
  decide: vi.fn(),
  prepareRevocation: vi.fn(),
  prepare: vi.fn(),
  prepareStream: vi.fn(),
  startRequestSearch: vi.fn(),
  requestSearchFiles: vi.fn(),
  prepareRequestBulk: vi.fn(),
  prepareRequestBatch: vi.fn(),
  setLiveBackground: vi.fn(),
  bulkShareFiles: vi.fn(),
  approveBulkShare: vi.fn(),
  retryBulkShare: vi.fn(),
  deliveryFiles: vi.fn(),
  revoke: vi.fn(),
  periodic: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: state.uid, providerData: state.providers } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: state.unlocked,
    getVaultOwnerToken: state.getToken,
  }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
vi.mock("@/lib/perf/use-periodic-task", () => ({
  useCoarseClock: () => Date.now(),
  usePeriodicTask: state.periodic,
}));
vi.mock("@/lib/services/drive-sharing-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-sharing-service")>()),
  DriveSharingService: state,
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { setLiveBackground: state.setLiveBackground },
}));
import { DocumentShareReview } from "@/components/consent/document-share-review";
import {
  DriveSharingError,
  StreamUnavailable,
} from "@/lib/services/drive-sharing-service";
const requestId = "11111111-1111-4111-8111-111111111111";
const review = () => ({
  revision: 3,
  status: "review_ready",
  recipientEmail: "b@example.invalid",
  purpose: {
    purpose: "Statements",
    periodStart: "2026-01-01",
    periodEnd: "2026-06-30",
  },
  files: [
    { documentId: "document-one", name: "<script>Untrusted.pdf</script>" },
  ],
  coverage: {
    summary: "January only",
    status: "partial",
    gaps: ["February to June"],
    truncated: true,
  },
  canApprove: true,
  reviewDigest: "a".repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const initial = () => ({
  requestId,
  direction: "incoming",
  revision: 3,
  status: "review_ready",
});
const delivery = () => ({
  status: "completed",
  files: [
    {
      name: "Approved.pdf",
      status: "succeeded",
      managed: true,
      grantId: "grant",
      revocationStatus: null,
      openUrl: "https://drive.google.com/file/d/approved/view",
    },
  ],
});
const pending = (revision = 0) => ({
  requestId,
  direction: "incoming",
  revision,
  status: "pending",
});
// What GET /review returns before preparation has published anything.
const partial = (overrides: Record<string, unknown> = {}) => ({
  ...review(),
  revision: 0,
  status: "pending",
  files: [],
  coverage: null,
  canApprove: false,
  reviewDigest: null,
  expiresAt: null,
  preparationError: null,
  ...overrides,
});
const searchJobId = "33333333-3333-4333-8333-333333333333";
const bulkShareId = "44444444-4444-4444-8444-444444444444";
const durableSearch = (overrides: Record<string, unknown> = {}) => ({
  jobId: searchJobId,
  status: "running",
  revision: 3,
  matched: 250,
  pagesScanned: 2,
  incompleteSearch: false,
  canStop: false,
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:01:00Z",
  expiresAt: "2026-09-29T00:00:00Z",
  errorCode: null,
  ...(overrides.status === "completed" && !("coverage" in overrides) ? { coverage: {
    corpora: ["user"], fileKind: "document", requestedPeriod: null,
    dateBasis: "title_date_then_created_or_modified", contentPeriodVerified: false,
    providerRowsScanned: 525, excludedByDateCount: 0, deduplicatedCount: 0,
    unavailableShortcutCount: 0, providerPagesExhausted: true, shareabilityVerified: true,
  } } : {}),
  ...overrides,
});
const durableBulk = (overrides: Record<string, unknown> = {}) => ({
  shareId: bulkShareId,
  searchJobId,
  status: "review_ready",
  revision: 1,
  reviewDigest: "b".repeat(64),
  fileCount: 499,
  recipientCount: 1,
  recipients: [{ name: "B", email: "b@example.invalid" }],
  excluded: [],
  counts: { total: 499, processed: 0, shared: 0, alreadyShared: 0, skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 499 },
  notifications: { settled: 0, pending: 0, unavailable: 0 },
  canApprove: true,
  canStop: false,
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:01:00Z",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function poll() {
  await act(async () => {
    await state.periodic.mock.lastCall?.[2]();
  });
}
describe("exact-file document review", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.uid = "a";
    state.token = "owner-a";
    state.unlocked = true;
    state.epoch = 1;
    state.getToken.mockImplementation(() => state.token);
    state.status.mockResolvedValue(initial());
    state.review.mockImplementation(async () => review());
    state.delivery.mockResolvedValue(delivery());
    state.approve.mockResolvedValue({ status: "approved" });
    state.decide.mockResolvedValue({});
    state.revoke.mockResolvedValue({});
    state.prepare.mockResolvedValue({ status: "review_ready" });
    // Default: this route can't stream here, so preparation falls back to POST.
    state.prepareStream.mockRejectedValue(new StreamUnavailable());
    state.startRequestSearch.mockResolvedValue(durableSearch());
    state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 4, matched: 500,
      files: [{ position: 1, id: "drive-1", name: "Standup 1", mimeType: "application/vnd.google-apps.document", modifiedTime: null, openUrl: null }], nextCursor: null });
    state.prepareRequestBulk.mockResolvedValue(durableBulk());
    state.prepareRequestBatch.mockResolvedValue(durableBulk());
    state.setLiveBackground.mockResolvedValue(undefined);
    state.bulkShareFiles.mockResolvedValue({ shareId: bulkShareId,
      files: [{ position: 1, name: "Standup 1", mimeType: "application/vnd.google-apps.document", modifiedTime: null, openUrl: null }], nextCursor: null });
    state.approveBulkShare.mockResolvedValue(durableBulk({ status: "queued", canApprove: false }));
    state.deliveryFiles.mockResolvedValue({ files: [], nextCursor: null });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it("opens for review only, renders untrusted names as text and requires explicit sharing", async () => {
    const changed = vi.fn();
    render(<DocumentShareReview requestId={requestId} onChanged={changed} />);
    const share = await screen.findByRole("button", { name: "Share files" });
    expect(screen.getByText("b@example.invalid")).toBeVisible();
    expect(screen.getByText("February to June")).toBeVisible();
    expect(screen.getByText("<script>Untrusted.pdf</script>")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect(state.approve).not.toHaveBeenCalled();
    state.status.mockResolvedValue({ ...initial(), status: "approved" });
    state.delivery.mockResolvedValue({
      status: "approved",
      files: [{ ...delivery().files[0], status: "queued" }],
    });
    fireEvent.click(share);
    fireEvent.click(share);
    await screen.findByText("Waiting to share");
    expect(state.approve).toHaveBeenCalledTimes(1);
    expect(state.approve).toHaveBeenCalledWith(
      "owner-a",
      requestId,
      expect.objectContaining({ revision: 3, files: review().files }),
      expect.any(Function),
      ["document-one"],
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveFocus();
  });
  it("reconciles accepted work even if the follow-up GET fails; never retries the POST", async () => {
    const changed = vi.fn();
    render(<DocumentShareReview requestId={requestId} onChanged={changed} />);
    const share = await screen.findByRole("button", { name: "Share files" });
    state.status.mockRejectedValue(new Error("offline"));
    fireEvent.click(share);
    await screen.findByRole("alert");
    expect(changed).toHaveBeenCalledOnce();
    expect(state.approve).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Share files" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(state.status).toHaveBeenCalledTimes(3));
    expect(state.approve).toHaveBeenCalledOnce();
  });
  it("does not chain a private read after the vault epoch changed", async () => {
    let finish!: (value: unknown) => void;
    state.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    state.epoch++;
    await act(async () => finish(initial()));
    expect(state.review).not.toHaveBeenCalled();
    expect(state.delivery).not.toHaveBeenCalled();
    expect(screen.queryByText("b@example.invalid")).toBeNull();
  });
  it("does not chain a read or reconcile after an approval settles for an old session", async () => {
    let finish!: (value: unknown) => void;
    state.approve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const changed = vi.fn();
    render(<DocumentShareReview requestId={requestId} onChanged={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: "Share files" }));
    state.epoch++;
    await act(async () => finish({ status: "approved" }));
    expect(state.status).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });
  it("does not load private details while locked and removes them on locking", async () => {
    state.unlocked = false;
    const changed = vi.fn();
    const view = render(
      <DocumentShareReview requestId={requestId} onChanged={changed} />,
    );
    expect(state.status).not.toHaveBeenCalled();
    state.unlocked = true;
    view.rerender(
      <DocumentShareReview requestId={requestId} onChanged={changed} />,
    );
    await screen.findByText("b@example.invalid");
    state.unlocked = false;
    view.rerender(
      <DocumentShareReview requestId={requestId} onChanged={changed} />,
    );
    expect(screen.queryByText("b@example.invalid")).toBeNull();
  });
  it("opens B's originals as the Google account that received Viewer access", async () => {
    // A browser signed into several Google accounts otherwise opens the link
    // as its default account (on UAT, A's), which has no access.
    state.providers = [{ providerId: "google.com", email: "b@gmail.test" }];
    state.status.mockResolvedValue({
      ...initial(),
      direction: "outgoing",
      status: "completed",
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByRole("link", { name: "Open in Google Drive" }),
    ).toHaveAttribute(
      "href",
      "https://drive.google.com/file/d/approved/view?authuser=b%40gmail.test",
    );
    expect(state.review).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Share files" })).toBeNull();
    expect(
      screen.getByText("Shared with b@gmail.test. Open while signed in to that Google account."),
    ).toBeVisible();
    expect(screen.queryByText(/connect your own Drive/)).toBeNull();
    state.providers = [];
  });

  it("keeps the plain link when B has no linked Google account in this session", async () => {
    state.providers = [{ providerId: "phone", email: null }];
    state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "completed" });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByRole("link", { name: "Open in Google Drive" }),
    ).toHaveAttribute("href", "https://drive.google.com/file/d/approved/view");
    expect(
      screen.getByText("Open while signed in to your linked Google account."),
    ).toBeVisible();
    state.providers = [];
  });
  it("prepares removal only on click, requires a second decision and polls its recorded outcome", async () => {
    state.status.mockResolvedValue({ ...initial(), status: "completed" });
    state.prepareRevocation.mockResolvedValue({
      revision: 4,
      directiveId: "d",
      reviewDigest: "b".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      files: [
        {
          grantId: "grant",
          name: "Approved.pdf",
          recipientEmail: "b@example.invalid",
        },
      ],
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const prepare = await screen.findByRole("button", {
      name: "Review removal",
    });
    expect(state.prepareRevocation).not.toHaveBeenCalled();
    fireEvent.click(prepare);
    const remove = await screen.findByRole("button", { name: "Remove access" });
    expect(state.revoke).not.toHaveBeenCalled();
    state.delivery.mockResolvedValue({
      ...delivery(),
      files: [{ ...delivery().files[0], revocationStatus: "queued" }],
    });
    fireEvent.click(remove);
    await screen.findByText("Removal: pending");
    expect(state.revoke).toHaveBeenCalledOnce();
    expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: true });
  });
  it("keeps the request on screen through a transient preparation failure and recovers by polling", async () => {
    state.status.mockResolvedValue(pending());
    state.review.mockResolvedValue(partial());
    state.prepare.mockRejectedValueOnce(new Error("temporary"));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    await screen.findByText("b@example.invalid");
    await waitFor(() => expect(state.prepare).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Finding files…");
    state.status.mockResolvedValue(initial());
    state.review.mockImplementation(async () => review());
    await poll();
    await screen.findByText("<script>Untrusted.pdf</script>");
    // A transport failure is re-read, never re-posted by the poll.
    expect(state.prepare).toHaveBeenCalledTimes(1);
  });

  it("requires explicit broad trust and sends its scope with approval", async () => {
    state.review.mockResolvedValue({ ...review(), canTrustFutureRequests: true });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const trust = await screen.findByRole("checkbox", { name: /^Trust b@example\.invalid/ });
    expect(trust).not.toBeChecked();
    fireEvent.click(trust);
    fireEvent.click(screen.getByRole("button", { name: "Share files" }));
    await waitFor(() => expect(state.approve).toHaveBeenCalledWith(
      "owner-a", requestId, expect.anything(), expect.any(Function), ["document-one"], true, "any_requested_drive_file"));
  });

  it("shares only the files A keeps selected, and never an empty selection", async () => {
    const files = [
      { documentId: "document-one", name: "March statement.pdf" },
      { documentId: "document-two", name: "Meeting notes" },
    ];
    state.review.mockResolvedValue({ ...review(), files, canTrustFutureRequests: true });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const notes = await screen.findByRole("checkbox", { name: "Meeting notes" });
    const all = screen.getByRole("checkbox", { name: "Select all" });
    expect(notes).toBeChecked();
    expect(all).toBeChecked();
    fireEvent.click(all);
    expect(notes).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Share 0 of 2 files" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "March statement.pdf" }));
    // Trust for future requests follows a review accepted in full.
    expect(screen.getByRole("checkbox", { name: /^Trust b@example\.invalid/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Share 1 of 2 files" }));
    await waitFor(() => expect(state.approve).toHaveBeenCalledWith(
      "owner-a", requestId, expect.anything(), expect.any(Function), ["document-one"]));
  });

  it("tells A plainly when no file looks like what was asked for", async () => {
    state.review.mockResolvedValue({
      ...review(),
      files: [],
      coverage: null,
      canApprove: false,
      preparationError: "no_relevant_files",
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByText("Your private agent found no matching files."),
    ).toBeVisible();
    expect(screen.getByText("Add them to Drive, then refresh.")).toBeVisible();
    expect(screen.queryByText("Suggestions are not ready yet.")).toBeNull();
    expect(screen.queryByText("Refresh suggestions before sharing.")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Refresh suggestions" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Decline" })).toBeVisible();
  });

  it("tells A when matching files couldn't be read", async () => {
    state.review.mockResolvedValue({
      ...review(),
      files: [],
      coverage: null,
      canApprove: false,
      preparationError: "no_ready_files",
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByText(
        "Matching files couldn't be read, for example password-protected or scanned PDFs.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Suggestions are not ready yet.")).toBeNull();
  });

  it("still says suggestions are not ready for any other result", async () => {
    state.review.mockResolvedValue({
      ...review(),
      files: [],
      coverage: null,
      canApprove: false,
      preparationError: null,
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByText("Suggestions are not ready yet."),
    ).toBeVisible();
    // With nothing to share, the hint about sharing is noise.
    expect(screen.queryByText("Refresh suggestions before sharing.")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh suggestions" })).toBeEnabled();
  });


  describe("progressive preparation", () => {
    function streaming() {
      const result = deferred<string>();
      const seen: {
        onStage?: (stage: string) => void;
        signal?: AbortSignal;
      } = {};
      state.prepareStream.mockImplementation(
        (_token: string, _id: string, _guard: () => void, options: {
          onStage: (stage: string) => void;
          signal: AbortSignal;
        }) => {
          seen.onStage = options.onStage;
          seen.signal = options.signal;
          return result.promise;
        },
      );
      return { result, seen };
    }

    it("shows who asked and why before files are found, with one status line", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial());
      const { result, seen } = streaming();
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await screen.findByText("b@example.invalid");
      expect(screen.getByText("“Statements”")).toBeVisible();
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toHaveTextContent("Finding files…");
      expect(screen.getByRole("button", { name: "Share files" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
      expect(screen.queryByText("Suggestions are not ready yet.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Refresh suggestions" })).toBeNull();
      // Screen readers still hear stage changes: nothing above the status is busy.
      expect(
        screen.getByTestId("document-share-review").getAttribute("aria-busy"),
      ).toBeNull();
      await act(async () => seen.onStage?.("searching"));
      expect(screen.getByRole("status")).toHaveTextContent("Searching Drive…");
      await act(async () => seen.onStage?.("checking"));
      expect(screen.getByRole("status")).toHaveTextContent("Checking coverage…");
      state.status.mockResolvedValue(initial());
      state.review.mockImplementation(async () => review());
      await act(async () => result.resolve("review_ready"));
      expect(
        await screen.findByRole("button", { name: "Share files" }),
      ).toBeEnabled();
      expect(state.prepareStream).toHaveBeenCalledTimes(1);
      expect(state.prepare).not.toHaveBeenCalled();
      expect(state.status).toHaveBeenCalledTimes(2);
      expect(state.review).toHaveBeenCalledTimes(2);
    });

    it("says a long search can take a minute", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial());
      streaming();
      const view = render(
        <DocumentShareReview requestId={requestId} onChanged={vi.fn()} />,
      );
      await screen.findByText("b@example.invalid");
      expect(screen.queryByText("This can take a minute.")).toBeNull();
      const start = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(start + 16_000);
      view.rerender(
        <DocumentShareReview requestId={requestId} onChanged={vi.fn()} />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "This can take a minute.",
      );
    });

    it("polls quietly while a worker holds the search", async () => {
      state.status.mockResolvedValue({ ...pending(), status: "preparing" });
      state.review.mockResolvedValue(partial({ status: "preparing" }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await screen.findByText("b@example.invalid");
      const line = screen.getByRole("status").textContent;
      const read = deferred<unknown>();
      state.status.mockReturnValueOnce(read.promise);
      const tick = act(async () => {
        await state.periodic.mock.lastCall?.[2]();
      });
      await waitFor(() => expect(state.status).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("status").textContent).toBe(line);
      expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
      expect(screen.queryByRole("alert")).toBeNull();
      read.resolve({ ...pending(), status: "preparing" });
      await tick;
      // Someone else is searching: this sheet never starts a second search.
      expect(state.prepareStream).not.toHaveBeenCalled();
      expect(state.prepare).not.toHaveBeenCalled();
    });

    it.each([
      ["a shareable review", review],
      ["request details only", () => partial({ status: "preparing" })],
    ])("clears %s when a poll fails", async (_label, shown) => {
      state.status.mockResolvedValue({ ...pending(), status: "preparing" });
      state.review.mockImplementation(async () => shown());
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await screen.findByText("b@example.invalid");
      state.status.mockRejectedValueOnce(new Error("offline"));
      await poll();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Refresh to try again.",
      );
      expect(screen.queryByText("b@example.invalid")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Share/ })).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Couldn't load request",
      );
    });

    it("keeps checking a long search without requiring the owner to wait in the sheet", async () => {
      state.status.mockResolvedValue({ ...pending(), status: "preparing" });
      state.review.mockResolvedValue(partial({ status: "preparing" }));
      const view = render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await screen.findByText("b@example.invalid");
      expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: true });
      const started = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(started + 121_000);
      view.rerender(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      for (let tick = 0; tick < 25; tick += 1) await poll();
      expect(screen.getByRole("status")).toHaveTextContent("Still finding files");
      expect(screen.getByRole("status")).toHaveTextContent(
        "You can come back later.",
      );
      expect(state.status).toHaveBeenCalledTimes(26);
      expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: true });
      expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
    });

    it("lets Decline interrupt a search; the late result changes nothing", async () => {
      state.status.mockResolvedValue(pending(1));
      state.review.mockResolvedValue(partial({ revision: 1 }));
      const { result, seen } = streaming();
      const changed = vi.fn();
      render(<DocumentShareReview requestId={requestId} onChanged={changed} />);
      fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
      state.status.mockResolvedValue({ ...pending(1), status: "declined" });
      state.delivery.mockResolvedValue({ status: "declined", files: [] });
      await waitFor(() =>
        expect(state.decide).toHaveBeenCalledWith(
          "owner-a",
          requestId,
          "decline",
          1,
          expect.any(Function),
        ),
      );
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Request declined"),
      );
      expect(changed).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toHaveFocus();
      expect(seen.signal?.aborted).toBe(true);
      const reviews = state.review.mock.calls.length;
      await act(async () => result.resolve("review_ready"));
      expect(state.review).toHaveBeenCalledTimes(reviews);
      expect(screen.getByRole("status")).toHaveTextContent("Request declined");
    });

    it("never shows a lost Decline as declined", async () => {
      state.status.mockResolvedValue(pending(1));
      state.review.mockResolvedValue(partial({ revision: 1 }));
      streaming();
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      state.decide.mockRejectedValueOnce(new DriveSharingError("review_changed"));
      fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This review changed. Refresh and review it again.",
      );
      expect(screen.queryByText("Request declined")).toBeNull();
      expect(screen.queryByText("b@example.invalid")).toBeNull();
    });

    it.each([
      [new DriveSharingError("reconnect_required"), "Reconnect Drive in Connections, then retry."],
      [new DriveSharingError("request_failed", 401), "Refresh to try again."],
    ])("treats a refused search as a real error", async (cause, copy) => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial());
      state.prepareStream.mockRejectedValue(cause);
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(copy);
      expect(screen.queryByText("b@example.invalid")).toBeNull();
      expect(state.prepare).not.toHaveBeenCalled();
    });

    it("offers a new search when the last one couldn't finish", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(
        partial({ preparationError: "preparation_unavailable" }),
      );
      state.prepareStream.mockResolvedValue("not_claimed");
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Search didn't finish"),
      );
      expect(screen.getByText("Couldn't prepare suggestions.")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Refresh suggestions" }),
      ).toBeEnabled();
      expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: false });
      expect(state.prepare).not.toHaveBeenCalled();
    });

    it("falls back to exactly one POST when this route can't stream", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial());
      state.prepare.mockImplementation(async () => {
        state.status.mockResolvedValue(initial());
        state.review.mockImplementation(async () => review());
        return { status: "review_ready" };
      });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await screen.findByText("<script>Untrusted.pdf</script>");
      expect(state.prepareStream).toHaveBeenCalledTimes(1);
      expect(state.prepare).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["preparing", 0],
      ["pending", 1],
    ])(
      "after an interrupted stream with status %s, posts %i time(s)",
      async (after, posts) => {
        state.status
          .mockResolvedValueOnce(pending())
          .mockResolvedValue({ ...pending(), status: after });
        state.review.mockResolvedValue(partial());
        state.prepareStream.mockResolvedValue("interrupted");
        render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
        await screen.findByText("b@example.invalid");
        await waitFor(() =>
          expect(state.review.mock.calls.length).toBeGreaterThanOrEqual(2),
        );
        expect(state.prepare).toHaveBeenCalledTimes(posts);
      },
    );

    it("keeps the search layout while a Decline is being sent", async () => {
      state.status.mockResolvedValue(pending(1));
      state.review.mockResolvedValue(partial({ revision: 1 }));
      streaming();
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      state.decide.mockReturnValueOnce(new Promise(() => undefined));
      fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Declining…"),
      );
      expect(screen.queryByText("Suggestions are not ready yet.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Refresh suggestions" })).toBeNull();
      expect(screen.getByRole("button", { name: "Share files" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Decline" })).toBeDisabled();
    });

    it("lets Refresh status take over from a quiet poll", async () => {
      state.status.mockResolvedValue({ ...pending(), direction: "outgoing" });
      state.delivery.mockResolvedValue({ status: "pending", files: [] });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      const refresh = await screen.findByRole("button", { name: "Refresh status" });
      const read = deferred<unknown>();
      state.status.mockReturnValueOnce(read.promise);
      const tick = act(async () => {
        await state.periodic.mock.lastCall?.[2]();
      });
      await waitFor(() => expect(state.status).toHaveBeenCalledTimes(2));
      fireEvent.click(refresh);
      await waitFor(() => expect(state.status).toHaveBeenCalledTimes(3));
      read.resolve({ ...pending(), direction: "outgoing" });
      await tick;
    });

    it("never calls an approved request's empty delivery final for the requester", async () => {
      state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "approved" });
      state.delivery.mockResolvedValue({ status: "approved", files: [] });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Sharing pending"),
      );
      expect(screen.queryByText("Nothing was shared.")).toBeNull();
      expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    });

    it("settles instead of spinning when the owner token is unavailable", async () => {
      state.getToken.mockReturnValue(null);
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Unlock your vault to review.",
      );
      expect(screen.getByRole("status")).toHaveTextContent("Couldn't load request");
      expect(state.status).not.toHaveBeenCalled();
    });

    it("aborts the stream when the sheet closes, and reports nothing after", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial());
      const { seen } = streaming();
      const view = render(
        <DocumentShareReview requestId={requestId} onChanged={vi.fn()} />,
      );
      await screen.findByText("b@example.invalid");
      await waitFor(() => expect(seen.signal).toBeDefined());
      view.unmount();
      expect(seen.signal?.aborted).toBe(true);
      expect(() => seen.onStage?.("checking")).not.toThrow();
    });
  });

  describe("durable request search and bulk sharing", () => {
    it("offers one-time background Drive setup for an automatic Trusted-circle request without manual approval", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, trustedAuto: true,
        search: null, bulkShare: null, preparationError: "background_preparation_required" }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      const enable = await screen.findByRole("button", { name: "Enable background Drive access" });
      expect(screen.getByText("This request is paused. Enable background Drive access to resume automatic sharing.")).toBeVisible();
      expect(screen.getByText(/read relevant files and send excerpts to Gemini while you're away/)).toBeVisible();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /Review \d+ files/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Share \d+ files/ })).toBeNull();
      fireEvent.click(enable);
      await waitFor(() => expect(state.setLiveBackground).toHaveBeenCalledExactlyOnceWith("owner-a", true));
      expect(screen.getByRole("status")).toHaveTextContent("Preparing automatic sharing");
    });

    it("shows all confirmed automatic sharing outcomes instead of only the latest batch", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, trustedAuto: true,
        search: durableSearch({ status: "running", matched: 60 }),
        bulkShare: durableBulk({ status: "queued", fileCount: 10,
          counts: { total: 10, processed: 0, shared: 0, alreadyShared: 0,
            skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 10 } }),
        aggregateCounts: { total: 50, processed: 40, shared: 40, alreadyShared: 0,
          skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 10 },
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("40 of 50 files available")).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent("Sharing matching files");
      expect(screen.queryByRole("button", { name: /Review \d+ files|Share \d+ files/ })).toBeNull();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
    });

    it("returns to manual review when Trusted-circle eligibility changes", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, trustedAuto: true,
        preparationError: "trusted_relationship_changed", progressiveAllowed: true,
        search: durableSearch({ status: "running", matched: 1,
          coverage: { ...durableSearch({ status: "completed" }).coverage!, providerPagesExhausted: false } }),
        bulkShare: null, batches: [], batchCount: 0, claimedPositions: [],
      }));
      state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 1, matched: 1,
        files: [{ ...searchFile(1), shareable: true }], nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("Trusted Circle changed. Review this request manually before sharing.")).toBeVisible();
      expect(await screen.findByRole("button", { name: "Review 1 file" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Enable background Drive access" })).toBeNull();
    });

    it("shows manual batch review after an owner takes over a Trusted-circle search", async () => {
      state.status.mockResolvedValue(pending());
      // The owner review projection clears trustedAuto after authenticated manual takeover.
      state.review.mockResolvedValue(partial({ durableAvailable: true, trustedAuto: false,
        preparationError: null, progressiveAllowed: true,
        search: durableSearch({ status: "running", matched: 1,
          coverage: { ...durableSearch({ status: "completed" }).coverage!, providerPagesExhausted: false } }),
        bulkShare: null, batches: [], batchCount: 0, claimedPositions: [],
      }));
      state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 1, matched: 1,
        files: [{ ...searchFile(1), shareable: true }], nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("button", { name: "Review 1 file" })).toBeEnabled();
      expect(screen.queryByText("Matching files are found and shared automatically.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Enable background Drive access" })).toBeNull();
    });

    it("requires explicit owner selection and approval to recover a skipped automatic file", async () => {
      let phase: "searching" | "review_ready" | "queued" = "searching";
      const search = durableSearch({ status: "running", matched: 3,
        coverage: { ...durableSearch({ status: "completed" }).coverage!, providerPagesExhausted: false } });
      const batch = durableBulk({ fileCount: 2, positions: [2, 3],
        counts: { ...durableBulk().counts, total: 2, pending: 2 } });
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => partial({ durableAvailable: true,
        trustedAuto: false, preparationError: null, progressiveAllowed: true, search,
        bulkShare: phase === "searching" ? null : { ...batch,
          status: phase === "queued" ? "queued" : "review_ready", canApprove: phase === "review_ready" },
        batches: phase === "searching" ? [] : [batch], batchCount: phase === "searching" ? 0 : 1,
        claimedPositions: phase === "searching" ? [1, 2] : [1, 2, 3],
        recoverablePositions: phase === "searching" ? [2] : [],
      }));
      state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 1, matched: 3,
        files: [1, 2, 3].map(position => ({ ...searchFile(position), shareable: true })), nextCursor: null });
      state.prepareRequestBatch.mockImplementation(async () => { phase = "review_ready"; return batch; });
      state.approveBulkShare.mockImplementation(async () => { phase = "queued"; return { ...batch, status: "queued", canApprove: false }; });

      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      const previouslyClaimed = await screen.findByRole("checkbox", { name: "Standup 1" });
      const recovery = screen.getByRole("checkbox", { name: "Standup 2" });
      const fresh = screen.getByRole("checkbox", { name: "Standup 3" });
      expect(previouslyClaimed).toBeDisabled();
      expect(recovery).toBeEnabled();
      expect(recovery).not.toBeChecked();
      expect(fresh).toBeChecked();
      expect(screen.getByText("Automatic sharing stopped before this file was sent. Select it to review and share.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Review 1 file" })).toBeEnabled();
      expect(state.prepareRequestBatch).not.toHaveBeenCalled();
      fireEvent.click(recovery);
      fireEvent.click(screen.getByRole("button", { name: "Review 2 files" }));
      await waitFor(() => expect(state.prepareRequestBatch).toHaveBeenCalledWith(
        "owner-a", requestId, expect.objectContaining({ status: "running" }), [2, 3], expect.any(Function),
      ));
      expect(state.approveBulkShare).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Share 2 files" }));
      await waitFor(() => expect(state.approveBulkShare).toHaveBeenCalledTimes(1));
    });

    it("reviews the first 25 while Drive keeps searching, then offers the next unclaimed page", async () => {
      let phase: "searching" | "first_review" | "first_queued" | "second_review" = "searching";
      const secondId = "55555555-5555-4555-8555-555555555555";
      const firstPositions = Array.from({ length: 25 }, (_, index) => index + 1);
      const secondPositions = Array.from({ length: 25 }, (_, index) => index + 26);
      const search = durableSearch({ status: "running", matched: 50,
        coverage: { ...durableSearch({ status: "completed" }).coverage!, providerPagesExhausted: false } });
      const first = durableBulk({ fileCount: 25, positions: firstPositions,
        counts: { ...durableBulk().counts, total: 25, pending: 25 } });
      const second = durableBulk({ ...first, shareId: secondId, positions: secondPositions });
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => partial({ durableAvailable: true, progressiveAllowed: true, search,
        bulkShare: phase === "searching" ? null : phase === "second_review" ? second :
          phase === "first_queued" ? { ...first, status: "queued", canApprove: false } : first,
        batches: phase === "searching" ? [] : phase === "second_review" ? [second, { ...first, status: "queued", canApprove: false }] :
          [phase === "first_queued" ? { ...first, status: "queued", canApprove: false } : first],
        batchCount: phase === "searching" ? 0 : phase === "second_review" ? 2 : 1,
        claimedPositions: phase === "searching" ? [] : phase === "second_review" ? [...firstPositions, ...secondPositions] : firstPositions,
      }));
      state.requestSearchFiles.mockImplementation(async (_token, _id, _job, _guard, cursor) => ({
        jobId: searchJobId, revision: 3, matched: 50,
        files: (cursor ? secondPositions : firstPositions).map(position => ({
          ...searchFile(position), shareable: true,
        })),
        nextCursor: cursor ? null : "page-2",
      }));
      state.prepareRequestBatch.mockImplementation(async () => {
        phase = phase === "searching" ? "first_review" : "second_review";
        return phase === "first_review" ? first : second;
      });
      state.approveBulkShare.mockImplementation(async () => {
        phase = "first_queued";
        return { ...first, status: "queued", canApprove: false };
      });
      state.bulkShareFiles.mockImplementation(async (_token, shareId) => ({ shareId,
        files: [{ position: shareId === secondId ? 26 : 1, name: "Original",
          mimeType: "application/vnd.google-apps.document", modifiedTime: null, openUrl: null }], nextCursor: null }));

      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("button", { name: "Review 25 files" })).toBeEnabled();
      expect(screen.getByRole("status")).toHaveTextContent("Searching Drive · 50 found");
      fireEvent.click(screen.getByRole("button", { name: "Review 25 files" }));
      await waitFor(() => expect(state.prepareRequestBatch).toHaveBeenCalledWith(
        "owner-a", requestId, expect.objectContaining({ status: "running" }), firstPositions, expect.any(Function),
      ));
      const share = await screen.findByRole("button", { name: "Share 25 files" });
      expect(screen.getByRole("checkbox", { name: "Standup 1" })).toBeDisabled();
      fireEvent.click(share);
      await waitFor(() => expect(state.approveBulkShare).toHaveBeenCalledTimes(1));
      expect(screen.getAllByText("Already in a sharing batch")).toHaveLength(25);
      fireEvent.click(screen.getByRole("button", { name: "Next 25" }));
      expect(await screen.findByRole("checkbox", { name: "Standup 26" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Review 25 files" }));
      await waitFor(() => expect(state.prepareRequestBatch).toHaveBeenCalledWith(
        "owner-a", requestId, expect.objectContaining({ status: "running" }), secondPositions, expect.any(Function),
      ));
      expect(screen.getByRole("status")).toHaveTextContent("2 batches started");
    });
    const searchFile = (position: number) => ({
      position, id: `drive-${position}`, name: `Standup ${position}`,
      mimeType: "application/vnd.google-apps.document", modifiedTime: null, openUrl: null,
    });

    it("starts the full search for an existing two-file review and retains those names if start fails", async () => {
      state.status.mockResolvedValue(initial());
      state.review.mockResolvedValue({ ...review(), durableAvailable: true, search: null, bulkShare: null,
        files: [
          { documentId: "old-1", name: "Old standup 1" },
          { documentId: "old-2", name: "Old standup 2" },
        ] });
      state.startRequestSearch.mockRejectedValue(new Error("offline"));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("Old standup 1")).toBeVisible();
      expect(screen.getByText("Old standup 2")).toBeVisible();
      expect(screen.getByText("Earlier suggestions")).toBeVisible();
      expect(screen.getByRole("button", { name: "Share files" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Search again" })).toBeEnabled();
      expect(state.startRequestSearch).toHaveBeenCalledOnce();
      expect(state.prepareStream).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Search again" }));
      await waitFor(() => expect(state.startRequestSearch).toHaveBeenCalledTimes(2));
      expect(screen.getByText("Old standup 1")).toBeVisible();
      expect(screen.getByRole("button", { name: "Share files" })).toBeDisabled();
    });

    it("replaces a legacy completed search before its files can be reviewed", async () => {
      const complete = durableSearch({ status: "completed", matched: 2 });
      const legacy = { ...complete, coverage: { ...complete.coverage!, shareabilityVerified: false } };
      const refreshed = durableSearch({ jobId: "55555555-5555-4555-8555-555555555555",
        status: "queued", matched: 0, coverage: { ...complete.coverage!, shareabilityVerified: true } });
      const start = deferred<void>();
      let replaced = false;
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => partial({ durableAvailable: true,
        search: replaced ? refreshed : legacy, bulkShare: null }));
      state.startRequestSearch.mockImplementation(async () => {
        await start.promise;
        replaced = true;
        return refreshed;
      });
      state.requestSearchFiles.mockResolvedValue({ jobId: refreshed.jobId, revision: 1,
        matched: 0, files: [], nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Updating file access checks"));
      expect(screen.getByText("Earlier files cannot be selected while the new check runs.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Updating file access" })).toBeDisabled();
      expect(state.requestSearchFiles).not.toHaveBeenCalled();
      expect(state.prepareRequestBulk).not.toHaveBeenCalled();
      await act(async () => start.resolve());
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Searching Drive · 0 found"));
      await poll();
      expect(state.startRequestSearch).toHaveBeenCalledOnce();
      expect(state.prepareRequestBulk).not.toHaveBeenCalled();
    });

    it("does not approve a frozen selection from a legacy search", async () => {
      const complete = durableSearch({ status: "completed", matched: 2 });
      const legacy = { ...complete, coverage: { ...complete.coverage!, shareabilityVerified: false } };
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, search: legacy,
        bulkShare: durableBulk({ status: "review_ready", fileCount: 2, canApprove: true }) }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This selection predates the sharing permission check. Ask for a new document request before sharing.",
      );
      expect(screen.getByRole("button", { name: "New request needed" })).toBeDisabled();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      expect(state.approveBulkShare).not.toHaveBeenCalled();
    });

    it("resumes a request search after the sheet closes without starting another one", async () => {
      let running = false;
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => partial({
        durableAvailable: true,
        search: running ? durableSearch({ matched: 250 }) : null,
        bulkShare: null,
      }));
      state.startRequestSearch.mockImplementation(async () => {
        running = true;
        return durableSearch({ matched: 250 });
      });
      const first = render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Searching Drive · 250 found");
      expect(screen.getByRole("button", { name: "Search in progress" })).toBeDisabled();
      expect(screen.getByText(/250 found so far\. Search continues after you leave\./)).toBeVisible();
      expect(state.startRequestSearch).toHaveBeenCalledOnce();
      expect(state.prepareStream).not.toHaveBeenCalled();
      first.unmount();
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Searching Drive · 250 found");
      expect(state.startRequestSearch).toHaveBeenCalledOnce();
    });

    it("reviews all 525 matches by page, preserves exclusions, then shares the frozen subset", async () => {
      let phase: "running" | "complete" | "bulk" | "queued" = "running";
      const complete = durableSearch({ status: "completed", matched: 525, pagesScanned: 6 });
      const selectedBulk = durableBulk({ fileCount: 523,
        counts: { ...durableBulk().counts, total: 523, pending: 523 } });
      state.status.mockImplementation(async () => phase === "queued"
        ? { ...initial(), status: "approved" } : pending());
      state.review.mockImplementation(async () => partial({
        durableAvailable: true,
        search: phase === "running" ? durableSearch({ matched: 250 }) : complete,
        bulkShare: phase === "bulk" ? selectedBulk : phase === "queued"
          ? durableBulk({ ...selectedBulk, status: "queued", canApprove: false }) : null,
      }));
      state.requestSearchFiles.mockImplementation(async (_token, _id, _job, _guard, cursor) => ({
        jobId: searchJobId, revision: 5, matched: 525,
        files: Array.from({ length: 25 }, (_, index) => searchFile((cursor ? 25 : 0) + index + 1)),
        nextCursor: cursor ? "page-3" : "page-2",
      }));
      state.prepareRequestBulk.mockImplementation(async () => { phase = "bulk"; return selectedBulk; });
      state.approveBulkShare.mockImplementation(async () => { phase = "queued"; return durableBulk({ ...selectedBulk, status: "queued", canApprove: false }); });
      state.delivery.mockResolvedValue({ status: "approved", files: [], bulkShareId,
        fileCount: 523, sharedCount: 0 });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Searching Drive · 250 found");
      expect(screen.queryByText("525 matching files")).toBeNull();
      phase = "complete";
      await poll();
      expect(await screen.findByText("Standup 1")).toBeVisible();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      expect(screen.getByText("525 matching files. Select the files to share.")).toBeVisible();
      fireEvent.click(screen.getByRole("checkbox", { name: "Standup 1" }));
      fireEvent.click(screen.getByRole("button", { name: "Next 25" }));
      expect(await screen.findByText("Standup 26")).toBeVisible();
      fireEvent.click(screen.getByRole("checkbox", { name: "Standup 26" }));
      expect(screen.getByRole("button", { name: "Review 523 files" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Review 523 files" }));
      await waitFor(() => expect(state.prepareRequestBulk).toHaveBeenCalledWith(
        "owner-a", requestId, expect.objectContaining({ matched: 525 }), [1, 26], expect.any(Function),
      ));
      const share = await screen.findByRole("button", { name: "Share 523 files" });
      await waitFor(() => expect(share).toBeEnabled());
      fireEvent.click(share);
      await waitFor(() => expect(state.approveBulkShare).toHaveBeenCalledWith(
        "owner-a", expect.objectContaining({ shareId: bulkShareId, fileCount: 523 }), expect.any(Function),
      ));
      expect(await screen.findByRole("status")).toHaveTextContent("Sharing in progress");
      expect(screen.getByText("0 of 523 files available")).toBeVisible();
    });

    it("pages through verified shared links for the requester", async () => {
      state.providers = [{ providerId: "google.com", email: "b@gmail.test" }];
      state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "completed" });
      state.delivery.mockResolvedValue({ status: "completed", files: [], bulkShareId,
        fileCount: 525, sharedCount: 525 });
      state.deliveryFiles.mockImplementation(async (_token, _id, _guard, cursor) => ({
        files: Array.from({ length: 25 }, (_, index) => {
          const position = (cursor ? 25 : 0) + index + 1;
          return { name: `Standup ${position}`, status: "succeeded", grantId: `grant-${position}`,
            revocationStatus: null, managed: false, manageInGoogle: false,
            openUrl: `https://drive.google.com/file/d/file-${position}/view` };
        }),
        nextCursor: cursor ? null : "page-2",
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("525 of 525 files available")).toBeVisible();
      expect(await screen.findByText("Standup 1")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Next 25" }));
      expect(await screen.findByText("Standup 26")).toBeVisible();
      expect(screen.getAllByRole("link", { name: "Open in Google Drive" })[0]).toHaveAttribute(
        "href", "https://drive.google.com/file/d/file-26/view?authuser=b%40gmail.test",
      );
    });

    it("accounts for the skipped file, keeps search coverage, and pages the owner's original links", async () => {
      state.providers = [{ providerId: "google.com", email: "a@gmail.test" }];
      state.status.mockResolvedValue({ ...initial(), status: "partial" });
      state.delivery.mockResolvedValue({ status: "partial", files: [], bulkShareId, fileCount: 72, sharedCount: 71 });
      state.review.mockResolvedValue(partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 108, unshareableCount: 36, coverage: {
          corpora: ["user", "member_shared_drives"], fileKind: "document",
          requestedPeriod: { start: "2026-06-28", end: "2026-09-28", timezone: "Asia/Kolkata" },
          dateBasis: "title_date_then_created_or_modified", contentPeriodVerified: false,
          providerRowsScanned: 540, excludedByDateCount: 450, excludedByTopicCount: 7, deduplicatedCount: 18,
          unavailableShortcutCount: 36, providerPagesExhausted: true,
          shareabilityVerified: true,
        } }),
        bulkShare: durableBulk({ status: "partial", fileCount: 72, canApprove: false,
          counts: { total: 72, processed: 72, shared: 62, alreadyShared: 9, skipped: 1,
            failed: 0, needsReview: 0, unknown: 0, pending: 0 },
          issues: [{ reasonCode: "source_not_shareable", count: 1 }],
        }),
      }));
      state.bulkShareFiles.mockImplementation(async (_token, _id, _guard, cursor) => ({
        shareId: bulkShareId, nextCursor: cursor ? null : "page-2",
        files: [{ position: cursor ? 26 : 1, name: cursor ? "Original 26" : "Unshared original",
          mimeType: "application/vnd.google-apps.document", modifiedTime: null,
          openUrl: cursor ? "https://drive.google.com/file/d/original-26/view" : "https://drive.google.com/file/d/original-1/view",
          outcomes: [{ status: cursor ? "succeeded" : "skipped", reasonCode: cursor ? null : "source_not_shareable" }],
        }],
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Sharing incomplete");
      expect(screen.getByText("71 of 72 files available")).toBeVisible();
      expect(screen.getByText("108 matching files found · 72 selected for sharing")).toBeVisible();
      expect(screen.getByText("36 unavailable matches were not included.")).toBeVisible();
      expect(screen.getByText("1 not shared")).toBeVisible();
      expect(screen.getByText(/ask its owner or shared drive manager to check sharing permissions/i)).toBeVisible();
      expect(screen.getByText("Review the newly shared originals below. Remove any unintended access in Google Drive.")).toBeVisible();
      expect(screen.queryByText(/0 failed/)).toBeNull();
      expect(screen.getByText("All returned Drive pages checked.")).toBeVisible();
      expect(screen.getByText("Your files and shared drives · 540 results checked")).toBeVisible();
      expect(screen.getByText(/7 files in matching folders were excluded because their names did not match this request/)).toBeVisible();
      expect(screen.getByText(/Dates inside file contents were not checked/)).toBeVisible();
      expect(await screen.findByText("Unshared original")).toBeVisible();
      expect(screen.getAllByRole("link", { name: "Open in Google Drive" })[0]).toHaveAttribute(
        "href", "https://drive.google.com/file/d/original-1/view?authuser=a%40gmail.test",
      );
      fireEvent.click(screen.getByRole("button", { name: "Next 25" }));
      expect(await screen.findByText("Original 26")).toBeVisible();
      expect(screen.getByText("Shared")).toBeVisible();
    });

    it.each([
      ["running", "Sharing in progress", { total: 3, processed: 1, shared: 1, alreadyShared: 0,
        skipped: 0, failed: 0, needsReview: 0, unknown: 1, pending: 1 }, "1 waiting to share", "1 checking the outcome"],
      ["stopped", "Sharing stopped", { total: 3, processed: 3, shared: 0, alreadyShared: 0,
        skipped: 3, failed: 0, needsReview: 0, unknown: 0, pending: 0 }, "3 not shared", null],
      ["failed", "Sharing failed", { total: 3, processed: 3, shared: 0, alreadyShared: 0,
        skipped: 0, failed: 3, needsReview: 0, unknown: 0, pending: 0 }, "3 failed", null],
      ["partial", "Sharing incomplete", { total: 3, processed: 3, shared: 1, alreadyShared: 1,
        skipped: 0, failed: 0, needsReview: 1, unknown: 0, pending: 0 }, "1 needs review", null],
    ])("explains every outcome category for a %s share", async (status, label, counts, outcome, secondOutcome) => {
      state.status.mockResolvedValue({ ...initial(), status: status === "running" ? "approved" : "partial" });
      state.delivery.mockResolvedValue({ status: "partial", files: [], bulkShareId, fileCount: 3, sharedCount: 0 });
      state.review.mockResolvedValue(partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 3 }),
        bulkShare: durableBulk({ status, fileCount: 3, canApprove: false, counts,
          issues: status === "failed" ? [{ reasonCode: "permission_rejected", count: 3 }] : [] }),
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent(label);
      expect(screen.getByText(outcome)).toBeVisible();
      if (secondOutcome) expect(screen.getByText(secondOutcome)).toBeVisible();
      if (status === "failed") expect(screen.getByText(/Google Drive denied sharing/)).toBeVisible();
    });

    it.each(["partial", "running"])("tells B whether the final file is unavailable or still pending (%s)", async bulkStatus => {
      state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: bulkStatus === "running" ? "approved" : "partial" });
      state.delivery.mockResolvedValue({ status: bulkStatus === "running" ? "approved" : "partial", files: [], bulkShareId,
        fileCount: 72, sharedCount: 71, bulkStatus,
        counts: { total: 72, processed: bulkStatus === "running" ? 71 : 72, shared: 62, alreadyShared: 9,
          skipped: bulkStatus === "running" ? 0 : 1, failed: 0, needsReview: 0, unknown: 0,
          pending: bulkStatus === "running" ? 1 : 0 },
        issues: bulkStatus === "running" ? [] : [{ reasonCode: "source_not_shareable", count: 1 }],
      });
      state.deliveryFiles.mockResolvedValue({ files: [{ name: "Confirmed original", status: "succeeded",
        grantId: null, revocationStatus: null, managed: false, manageInGoogle: false,
        openUrl: "https://drive.google.com/file/d/confirmed/view" }], nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("71 of 72 files available")).toBeVisible();
      expect(screen.getByText(bulkStatus === "running" ? "1 waiting to share" : "1 not shared")).toBeVisible();
      if (bulkStatus === "partial") {
        expect(screen.getByRole("status")).toHaveTextContent("Sharing incomplete");
        expect(screen.getByText(/Only confirmed available files appear here/)).toHaveTextContent(
          "Ask the owner to review the 1 file not confirmed available.",
        );
        expect(screen.getByText(/The owner's Google account lacks sharing permission/)).toBeVisible();
      }
      expect(await screen.findByText("Confirmed original")).toBeVisible();
      expect(screen.queryByText("Unshared original")).toBeNull();
      expect(screen.queryByText(/0 failed/)).toBeNull();
      if (bulkStatus === "running") expect(screen.getByRole("status")).toHaveTextContent("71 files available; more may arrive");
    });

    it.each(["pending", "unknown"])("keeps a stopped owner share current until its %s receipt settles", async outcome => {
      let settled = false;
      const counts = () => ({ total: 2, processed: settled ? 2 : 1, shared: settled ? 1 : 0, alreadyShared: 0,
        skipped: 1, failed: 0, needsReview: 0, unknown: !settled && outcome === "unknown" ? 1 : 0,
        pending: !settled && outcome === "pending" ? 1 : 0 });
      state.status.mockResolvedValue({ ...initial(), status: "approved" });
      state.delivery.mockImplementation(async () => ({ status: "approved", files: [], bulkShareId, fileCount: 2, sharedCount: settled ? 1 : 0 }));
      state.review.mockImplementation(async () => partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 2 }),
        bulkShare: durableBulk({ status: "stopped", revision: settled ? 3 : 2, fileCount: 2, canApprove: false, counts: counts() }),
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText(outcome === "unknown" ? "1 checking the outcome" : "1 waiting to share")).toBeVisible();
      expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: true });
      settled = true;
      await poll();
      expect(await screen.findByText("1 of 2 files available")).toBeVisible();
      expect(screen.queryByText(/1 checking the outcome|1 waiting to share/)).toBeNull();
      expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: false });
      expect(state.approveBulkShare).not.toHaveBeenCalled();
      expect(state.retryBulkShare).not.toHaveBeenCalled();
    });

    it("keeps B checking a stopped approved request until a late confirmed link arrives", async () => {
      let settled = false;
      state.status.mockImplementation(async () => ({ ...initial(), direction: "outgoing", status: settled ? "partial" : "approved" }));
      state.delivery.mockImplementation(async () => ({ status: settled ? "partial" : "approved", files: [], bulkShareId,
        bulkStatus: "stopped", fileCount: 2, sharedCount: settled ? 1 : 0,
        counts: { total: 2, processed: settled ? 2 : 1, shared: settled ? 1 : 0, alreadyShared: 0,
          skipped: 1, failed: 0, needsReview: 0, unknown: settled ? 0 : 1, pending: 0 },
      }));
      state.deliveryFiles.mockResolvedValue({ files: [{ name: "Late confirmed original", status: "succeeded",
        grantId: null, revocationStatus: null, managed: false, manageInGoogle: false,
        openUrl: "https://drive.google.com/file/d/late-confirmed/view" }], nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("1 checking the outcome")).toBeVisible();
      expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: true });
      expect(state.deliveryFiles).not.toHaveBeenCalled();
      settled = true;
      await poll();
      expect(await screen.findByText("Late confirmed original")).toBeVisible();
      expect(screen.getByText("1 of 2 files available")).toBeVisible();
      expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: false });
    });

    it("offers an explicit safe retry for only the unshared file in the locked selection", async () => {
      let retrying = false;
      const selected = durableBulk({ status: "partial", fileCount: 72, canApprove: false, canRetry: true, retryableCount: 1,
        counts: { total: 72, processed: 72, shared: 62, alreadyShared: 9, skipped: 1,
          failed: 0, needsReview: 0, unknown: 0, pending: 0 }, issues: [{ reasonCode: "provider_unavailable", count: 1 }] });
      state.status.mockImplementation(async () => ({ ...initial(), status: retrying ? "approved" : "partial" }));
      state.delivery.mockResolvedValue({ status: "partial", files: [], bulkShareId, fileCount: 72, sharedCount: 71 });
      state.review.mockImplementation(async () => partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 108, unshareableCount: 36 }),
        bulkShare: retrying ? { ...selected, status: "queued", canRetry: false, retryableCount: 0,
          counts: { ...selected.counts, processed: 71, skipped: 0, pending: 1 } } : selected,
      }));
      state.retryBulkShare.mockImplementation(async () => { retrying = true; return {}; });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Retry 1 file" }));
      await waitFor(() => expect(state.retryBulkShare).toHaveBeenCalledWith("owner-a",
        expect.objectContaining({ shareId: bulkShareId, fileCount: 72, retryableCount: 1 }), expect.any(Function)));
      expect(await screen.findByText("1 waiting to share")).toBeVisible();
      expect(state.prepareRequestBulk).not.toHaveBeenCalled();
      expect(state.approveBulkShare).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Retry 1 file" })).toBeNull();
    });

    it("withholds candidate names from the requester until a verified grant exists", async () => {
      state.status.mockResolvedValue({ ...pending(), direction: "outgoing" });
      state.delivery.mockResolvedValue({ status: "pending", files: [] });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Request pending");
      expect(screen.queryByText(/Standup 1/)).toBeNull();
      expect(state.deliveryFiles).not.toHaveBeenCalled();
      state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "approved" });
      state.delivery.mockResolvedValue({ status: "approved", files: [], bulkShareId,
        fileCount: 525, sharedCount: 0 });
      await poll();
      expect(screen.getByText("Files appear as sharing finishes.")).toBeVisible();
      expect(state.deliveryFiles).not.toHaveBeenCalled();
      state.delivery.mockResolvedValue({ status: "approved", files: [], bulkShareId,
        fileCount: 525, sharedCount: 1 });
      state.deliveryFiles.mockResolvedValue({ files: [{ name: "Standup 1", status: "succeeded",
        grantId: "grant-1", revocationStatus: null, managed: false, manageInGoogle: false,
        openUrl: "https://drive.google.com/file/d/file-1/view" }], nextCursor: null });
      await poll();
      expect(await screen.findByText("Standup 1")).toBeVisible();
      expect(state.deliveryFiles).toHaveBeenCalledOnce();
    });

    it("shows unshareable matches, excludes them, and blocks a review with no shareable files", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 2, unshareableCount: 2 }), bulkShare: null }));
      state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 4, matched: 2,
        files: [1, 2].map(position => ({ ...searchFile(position), shareable: false,
          unavailableReason: position === 1 ? "source_not_shareable" : "shareability_unverified" })), nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("Standup 1")).toBeVisible();
      expect(screen.getByText("2 files have no confirmed sharing permission and won't be included.")).toBeVisible();
      expect(screen.getByText("Your Google account cannot share this file")).toBeVisible();
      expect(screen.getByText("Sharing permission could not be verified")).toBeVisible();
      expect(screen.getByRole("checkbox", { name: "Standup 1" })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "Standup 2" })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Review 0 files" })).toBeDisabled();
      expect(state.prepareRequestBulk).not.toHaveBeenCalled();
    });
  });

  it("reads out every consequence of standing trust", async () => {
    state.review.mockResolvedValue({ ...review(), canTrustFutureRequests: true });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const trust = await screen.findByRole("checkbox", {
      name: "Trust b@example.invalid for future requests",
    });
    expect(trust).toHaveAccessibleDescription(/including future files, without asking/);
    expect(trust).toHaveAccessibleDescription(/while you’re away/);
    expect(trust).toHaveAccessibleDescription(/stop future sharing anytime/);
    expect(document.body.textContent).not.toMatch(/\bOne\b/);
  });

  it("names access outside the private agent without saying One", async () => {
    state.status.mockResolvedValue({ ...initial(), status: "completed" });
    state.delivery.mockResolvedValue({
      ...delivery(),
      files: [{ ...delivery().files[0], status: "present_unattributed" }],
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByText("Access exists outside your private agent"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Disconnecting Drive doesn't remove Google access. Other access may remain after removal.",
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\bOne\b/);
  });

  it("disables Cancel while a removal is being sent", async () => {
    state.status.mockResolvedValue({ ...initial(), status: "completed" });
    state.prepareRevocation.mockResolvedValue({
      revision: 4,
      directiveId: "d",
      reviewDigest: "b".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      files: [
        { grantId: "grant", name: "Approved.pdf", recipientEmail: "b@example.invalid" },
      ],
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review removal" }));
    const remove = await screen.findByRole("button", { name: "Remove access" });
    state.revoke.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.click(remove);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled(),
    );
  });
});
