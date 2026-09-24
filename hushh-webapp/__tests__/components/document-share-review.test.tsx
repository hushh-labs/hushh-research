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
  revoke: vi.fn(),
  periodic: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: state.uid } }),
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
  });
  afterEach(cleanup);
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
  it("gives B only the recorded delivery and explains both access paths", async () => {
    state.status.mockResolvedValue({
      ...initial(),
      direction: "outgoing",
      status: "completed",
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByRole("link", { name: "Open in Google Drive" }),
    ).toHaveAttribute("href", "https://drive.google.com/file/d/approved/view");
    expect(state.review).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Share files" })).toBeNull();
    expect(
      screen.getByText(/connect your own Drive and select these files/),
    ).toBeVisible();
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
  it("prepares a pending owner request once and recovers after a transient failure", async () => {
    state.status.mockResolvedValue({ requestId, revision: 0, direction: "incoming", status: "pending" });
    state.prepare.mockRejectedValueOnce(new Error("temporary"));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    await screen.findByRole("alert");
    state.prepare.mockImplementationOnce(async () => {
      state.status.mockResolvedValue({ requestId, revision: 3, direction: "incoming", status: "review_ready" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByText("<script>Untrusted.pdf</script>");
    expect(state.prepare).toHaveBeenCalledTimes(2);
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

});
