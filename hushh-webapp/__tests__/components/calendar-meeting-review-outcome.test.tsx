import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(), review: vi.fn(), approve: vi.fn(), decide: vi.fn(), preview: vi.fn(),
  onChanged: vi.fn(), getVaultOwnerToken: vi.fn(() => "vault-owner-token"),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "organizer" }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({
  isVaultUnlocked: true, getVaultOwnerToken: mocks.getVaultOwnerToken,
}) }));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => 1, isVaultSessionEpochCurrent: () => true,
}));
vi.mock("@/lib/services/drive-sharing-service", () => ({
  DriveSharingService: { status: mocks.status, review: mocks.review, approve: mocks.approve, decide: mocks.decide },
}));
vi.mock("@/lib/services/calendar-meeting-review-service", () => ({
  CalendarMeetingReviewService: { preview: mocks.preview, search: vi.fn(), linkedFiles: vi.fn(), prepare: vi.fn() },
}));
vi.mock("@/components/consent/document-share-review", () => ({ DocumentShareReview: () => null }));
vi.mock("@/components/profile/profile-connectors-link", () => ({
  ProfileConnectorsLink: ({ children }: { children: React.ReactNode }) => <a href="/connectors">{children}</a>,
}));

import { DocumentRequestReviewRouter } from "@/components/consent/calendar-meeting-review-card";
import { isMeetingReviewing, meetingOutcome } from "@/lib/consent/calendar-meeting-outcome";

const requestId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const base = { requestId, requestType: "calendar_meeting", direction: "incoming", revision: 3 };
const preview = {
  requestId, revision: 3, status: "review_ready", requestType: "calendar_meeting",
  recipientEmail: "requester@example.invalid", ownerDriveReady: true,
  meeting: { title: "Growth Sync", date: "2026-10-28", start_at: "2026-10-28T10:00:00Z",
    organizer_email: "organizer@example.invalid", account_id: "default", occurrence_id: "a".repeat(64),
    requested_types: ["recording"] },
};

const outcome = () => screen.getByTestId("calendar-review-outcome");
async function flush(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

async function giveAccess() {
  render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
  expect(await screen.findByText("Final file and recipient review")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Growth Sync recording" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I confirm these selected files/ }));
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Give access" }));
  await flush(0);
}

describe("Calendar organizer sharing outcome", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getVaultOwnerToken.mockReturnValue("vault-owner-token");
    mocks.status.mockResolvedValue({ ...base, status: "review_ready" });
    mocks.preview.mockResolvedValue(preview);
    mocks.review.mockResolvedValue({ requestId, requestType: "calendar_meeting", recipientEmail: preview.recipientEmail,
      revision: 3, canApprove: true, reviewDigest: "d".repeat(64), expiresAt: "2099-01-01T00:00:00Z",
      files: [{ documentId, name: "Growth Sync recording" }] });
    mocks.approve.mockResolvedValue({ requestId, status: "approved" });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("stays on the review showing Sharing, never Access given, until the server settles", async () => {
    await giveAccess();
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(outcome()).toHaveAttribute("data-outcome", "approved");
    expect(within(outcome()).getByText("Sharing…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Give access" })).toBeNull();
    expect(screen.getByText("Growth Sync", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Feed" })).toHaveAttribute("href", "/one/feed");
    expect(screen.queryByText("Access given")).toBeNull();
    expect(mocks.onChanged).toHaveBeenCalledTimes(1);

    mocks.status.mockResolvedValue({ ...base, revision: 4, status: "approved" });
    await flush(2_500);
    expect(within(outcome()).getByText("Sharing…")).toBeInTheDocument();

    mocks.status.mockResolvedValue({ ...base, revision: 5, status: "completed" });
    await flush(2_500);
    expect(outcome()).toHaveAttribute("data-outcome", "completed");
    expect(within(outcome()).getByText("Access given")).toBeInTheDocument();
    expect(outcome()).toHaveTextContent("requester's Calendar shows the files once their selected Google account can open them");
    expect(screen.getByRole("link", { name: "Back to Feed" })).toBeInTheDocument();
    expect(mocks.onChanged).toHaveBeenCalledTimes(2); // post-approval, then the settled outcome
    await flush(20_000);
    expect(mocks.status.mock.calls.length).toBeLessThan(6); // polling stopped when settled
  });

  it.each([
    ["partial", "Some files were shared", "status"],
    ["failed", "Sharing did not complete", "alert"],
    ["no_match", "No files were shared", "status"],
  ])("reports the actual %s outcome and keeps Back to Feed", async (settled, title, role) => {
    await giveAccess();
    mocks.status.mockResolvedValue({ ...base, revision: 9, status: settled });
    await flush(2_500);
    expect(within(outcome()).getByText(title)).toBeInTheDocument();
    expect(within(outcome()).getByRole(role)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Feed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Give access" })).toBeNull();
  });

  it("survives transient status failures and stops with a manual check, not forever", async () => {
    await giveAccess();
    mocks.status.mockRejectedValue(new Error("network"));
    await flush(2_500 * 40 + 100);
    expect(outcome()).toHaveAttribute("data-outcome", "approved");
    expect(screen.getByText(/taking longer than usual/)).toBeInTheDocument();
    const polls = mocks.status.mock.calls.length;
    await flush(30_000);
    expect(mocks.status.mock.calls.length).toBe(polls);

    mocks.status.mockResolvedValue({ ...base, revision: 7, status: "completed" });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await flush(2_500);
    expect(within(outcome()).getByText("Access given")).toBeInTheDocument();
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();
  });

  it("an organizer who returns mid-share sees Sharing at once and it settles", async () => {
    vi.useFakeTimers();
    mocks.status.mockResolvedValue({ ...base, status: "approved" });
    mocks.preview.mockResolvedValue({ ...preview, status: "approved" });
    render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
    await flush(0);
    expect(screen.getByText("Sharing…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Give access" })).toBeNull();
    mocks.status.mockResolvedValue({ ...base, revision: 4, status: "completed" });
    await flush(2_500);
    expect(within(outcome()).getByText("Access given")).toBeInTheDocument();
  });

  it("an already settled request shows its outcome and Back to Feed, with nothing left to approve", async () => {
    mocks.status.mockResolvedValue({ ...base, status: "partial" });
    mocks.preview.mockResolvedValue({ ...preview, status: "partial" });
    render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
    expect(await screen.findByText("Some files were shared")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Feed" })).toHaveAttribute("href", "/one/feed");
    expect(screen.queryByRole("button", { name: "Give access" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Decline|Confirm decline/ })).toBeNull();
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("declining settles in place: outcome, no leftover decision buttons, Back to Feed", async () => {
    mocks.decide.mockResolvedValue({ requestId, status: "declined" });
    render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline request" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm decline" }));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Request declined")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Decline request|Confirm decline|Give access/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Feed" })).toBeInTheDocument();
  });

  it("does not show Back to Feed while the organizer still has a decision to make", async () => {
    render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
    expect(await screen.findByText("Final file and recipient review")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Back to Feed" })).toBeNull();
    expect(screen.queryByTestId("calendar-review-outcome")).toBeNull();
  });
});

describe("meetingOutcome", () => {
  it.each(["pending", "preparing", "review_ready"])("%s has no outcome yet", status => {
    expect(isMeetingReviewing(status)).toBe(true);
    expect(meetingOutcome(status)).toBeNull();
  });
  it("only an approved request is still in progress, and never claims access", () => {
    expect(meetingOutcome("approved")).toMatchObject({ inProgress: true, tone: "progress" });
    for (const status of ["completed", "partial", "failed", "no_match", "declined", "expired", "something_new"])
      expect(meetingOutcome(status)?.inProgress).toBe(false);
    expect(meetingOutcome("completed")?.detail).not.toMatch(/can now open|has access/i);
  });
  it("describes an unknown status without inventing an outcome", () => {
    expect(meetingOutcome("on_hold")).toMatchObject({ tone: "neutral", detail: "This request is on hold." });
  });
});
