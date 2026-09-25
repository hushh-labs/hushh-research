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

    it("stops at still working when the poll budget runs out, and Refresh status resumes", async () => {
      state.status.mockResolvedValue({ ...pending(), status: "preparing" });
      state.review.mockResolvedValue(partial({ status: "preparing" }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await screen.findByText("b@example.invalid");
      expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: true });
      for (let tick = 0; tick < 25; tick += 1) await poll();
      expect(screen.getByRole("status")).toHaveTextContent("Still finding files");
      expect(screen.getByRole("status")).toHaveTextContent(
        "Check again in a minute.",
      );
      expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: false });
      fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
      await waitFor(() =>
        expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: true }),
      );
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

