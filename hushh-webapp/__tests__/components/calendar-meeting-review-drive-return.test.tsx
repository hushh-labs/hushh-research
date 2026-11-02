import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(), review: vi.fn(), preview: vi.fn(), onChanged: vi.fn(),
  getVaultOwnerToken: vi.fn(() => "vault-owner-token"),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "organizer" }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({
  isVaultUnlocked: true, getVaultOwnerToken: mocks.getVaultOwnerToken,
}) }));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => 1, isVaultSessionEpochCurrent: () => true,
}));
vi.mock("@/lib/services/drive-sharing-service", () => ({
  DriveSharingService: { status: mocks.status, review: mocks.review, approve: vi.fn(), decide: vi.fn() },
}));
vi.mock("@/lib/services/calendar-meeting-review-service", () => ({
  CalendarMeetingReviewService: { preview: mocks.preview, search: vi.fn(), linkedFiles: vi.fn(), prepare: vi.fn() },
}));
vi.mock("@/components/consent/document-share-review", () => ({ DocumentShareReview: () => null }));
// The real link opens a pane; here it only reports that it was activated.
vi.mock("@/components/profile/profile-connectors-link", () => ({
  ProfileConnectorsLink: ({ children, onClick }: { children: React.ReactNode; onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void }) =>
    <a href="/connectors" onClick={event => { event.preventDefault(); onClick?.(event); }}>{children}</a>,
}));

import { DocumentRequestReviewRouter } from "@/components/consent/calendar-meeting-review-card";
import { readMeetingReviewOAuthReturn } from "@/lib/consent/meeting-review-return";

const requestId = "11111111-1111-4111-8111-111111111111";
const base = { requestId, requestType: "calendar_meeting", direction: "incoming", revision: 3 };
const notReady = {
  requestId, revision: 3, status: "preparing", requestType: "calendar_meeting",
  recipientEmail: "requester@example.invalid", ownerDriveReady: false,
  meeting: { title: "Growth Sync", date: "2026-10-28", start_at: "2026-10-28T10:00:00Z",
    organizer_email: "organizer@example.invalid", account_id: "default", occurrence_id: "a".repeat(64),
    requested_types: ["recording"] },
};
const ready = { ...notReady, ownerDriveReady: true };
const connectCopy = /Connect the Google Drive account that can share these files/;
let visibility: DocumentVisibilityState = "visible";

async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
/** The organizer chooses Give access; only then is a Drive connection asked of them. */
async function mountBlocked() {
  render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
  fireEvent.click(await screen.findByRole("button", { name: "Give access" }));
  expect(await screen.findByText(connectCopy)).toBeInTheDocument();
}
async function comeBack(kind: "focus" | "visibility" | "popstate" = "focus") {
  await act(async () => {
    if (kind === "focus") window.dispatchEvent(new Event("focus"));
    else if (kind === "popstate") window.dispatchEvent(new PopStateEvent("popstate"));
    else document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve(); await Promise.resolve();
  });
}

describe("organizer returns from authorizing Drive to the same request", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    mocks.getVaultOwnerToken.mockReturnValue("vault-owner-token");
    mocks.status.mockResolvedValue({ ...base, status: "preparing" });
    mocks.preview.mockResolvedValue(notReady);
    window.localStorage.clear();
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); window.localStorage.clear(); window.sessionStorage.clear(); });

  it("asks nothing about Drive until Give access is chosen, and Don't have never needs it", async () => {
    render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
    expect(await screen.findByRole("button", { name: "Don't have" })).toBeEnabled();
    expect(screen.queryByText(connectCopy)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Don't have" }));
    expect(screen.queryByText(connectCopy)).toBeNull();
    expect(screen.getByRole("checkbox", { name: "The recording" })).toBeChecked();
  });

  it("brings the organizer back to the Give access step after a full-page Drive authorization", async () => {
    await mountBlocked();
    fireEvent.click(screen.getByRole("link", { name: "Open Drive connection" }));
    cleanup();
    // A fresh page for the same organizer and request lands on the same step, not on the choice.
    mocks.preview.mockResolvedValue(ready);
    render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
    expect(await screen.findByLabelText("Search your Drive for the exact meeting files")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Give access" })).toHaveAttribute("aria-pressed", "true");
    // One-shot: it does not steer a later visit.
    cleanup();
    render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
    expect(await screen.findByRole("button", { name: "Give access" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText("Search your Drive for the exact meeting files")).toBeNull();
  });

  it("remembers this exact request for this organizer when they open the Drive connection", async () => {
    await mountBlocked();
    expect(readMeetingReviewOAuthReturn("organizer")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Open Drive connection" }));
    expect(readMeetingReviewOAuthReturn("organizer")).toEqual({ requestId });
    expect(readMeetingReviewOAuthReturn("someone-else")).toBeNull();
    expect(screen.getByText(/You will come back to this request/)).toBeInTheDocument();
  });

  it("re-checks in place when the organizer returns, with no reload, spinner or remount", async () => {
    await mountBlocked();
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    const heading = screen.getByRole("heading", { name: "Meeting file request" });
    mocks.preview.mockResolvedValue(ready);
    await comeBack("focus");
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(await screen.findByLabelText("Search your Drive for the exact meeting files")).toBeInTheDocument();
    expect(screen.queryByText(connectCopy)).toBeNull();
    expect(screen.queryByText("Loading this meeting request…")).toBeNull();
    expect(screen.getByRole("heading", { name: "Meeting file request" })).toBe(heading);
    // The request itself was never re-routed or reset.
    expect(mocks.status).toHaveBeenCalledTimes(1);
  });

  it.each(["visibility", "popstate"] as const)("also re-checks when the page becomes visible again or Back closes the pane (%s)", async kind => {
    await mountBlocked();
    mocks.preview.mockResolvedValue(ready);
    await comeBack(kind);
    expect(await screen.findByLabelText("Search your Drive for the exact meeting files")).toBeInTheDocument();
  });

  it("does not re-check while the page is hidden", async () => {
    await mountBlocked();
    visibility = "hidden";
    await comeBack("visibility");
    await comeBack("focus");
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of focus events into one re-check", async () => {
    await mountBlocked();
    await comeBack("focus"); await comeBack("focus"); await comeBack("visibility");
    expect(mocks.preview).toHaveBeenCalledTimes(2);
  });

  it("keeps the connect prompt, with no error, when a quiet re-check fails", async () => {
    await mountBlocked();
    mocks.preview.mockRejectedValue(new Error("offline"));
    await comeBack("focus");
    await settle();
    expect(screen.getByText(connectCopy)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets the organizer ask for the check themselves", async () => {
    await mountBlocked();
    mocks.preview.mockResolvedValue(ready);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check Drive connection" })); await Promise.resolve(); await Promise.resolve(); });
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(await screen.findByLabelText("Search your Drive for the exact meeting files")).toBeInTheDocument();
  });

  it("stops listening once Drive is ready", async () => {
    mocks.preview.mockResolvedValue(ready);
    render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: "Give access" }));
    expect(await screen.findByLabelText("Search your Drive for the exact meeting files")).toBeInTheDocument();
    await comeBack("focus");
    await comeBack("popstate");
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Check Drive connection" })).toBeNull();
  });
});
