import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insights: vi.fn(), requestFiles: vi.fn(), requestStatuses: vi.fn(), approvedDetail: vi.fn(),
  getIdToken: vi.fn(), copy: vi.fn(), share: vi.fn(), inviteShare: vi.fn(),
}));
vi.mock("@/lib/services/calendar-insights-service", () => ({
  CalendarInsightsService: { read: mocks.insights, requestFiles: mocks.requestFiles,
    requestStatuses: mocks.requestStatuses, approvedDetail: mocks.approvedDetail },
  CalendarInsightsRequestError: class extends Error {
    constructor(message: string, readonly status: number, readonly code?: string, readonly reason?: string) { super(message); }
  },
  safeMeetingProviderUrl: () => null,
}));
vi.mock("@/components/calendar/calendar-followups", () => ({ CalendarFollowups: () => null }));
vi.mock("@/lib/utils/clipboard", () => ({ copyToClipboard: mocks.copy }));
vi.mock("@/lib/connect/invite-to-one", () => ({
  buildInviteToOneShare: mocks.inviteShare, buildInviteToOneUrl: () => "https://one.example/?invite=one",
}));
vi.mock("@/lib/share/share-link", () => ({
  shareLink: mocks.share,
  isShareCancellationError: (error: unknown) => error instanceof Error && error.name === "AbortError",
  ShareUnavailableError: class ShareUnavailableError extends Error {},
}));

import { CalendarInsights } from "@/components/calendar/calendar-insights";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { CalendarInsightsRequestError } from "@/lib/services/calendar-insights-service";
import { CacheService } from "@/lib/services/cache-service";

const grant = "b".repeat(64);
const row = {
  id: "a", title: "Growth Sync", calendar_id: "primary", account_id: "default",
  occurrence_id: "a".repeat(64), grant_id: grant, sources: [{ calendar_id: "primary", event_id: "a" }],
  artifact_kinds: [], availability: {}, discovery: "checked", file_state: "unknown",
  start: { dateTime: "2026-10-14T10:00:00Z" }, organizer: { email: "organizer@example.test" },
};
const account = { account_id: "default", google_email: "owner@example.com", status: "connected" as const,
  connected: true, access_level: "read" as const, calendar_list_access: true };

function refusal(status: number, code: string, reason?: string, message = "Server wording") {
  return new (CalendarInsightsRequestError as unknown as new (m: string, s: number, c?: string, r?: string) => Error)(
    message, status, code, reason);
}

async function reachConfirmStep() {
  render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
    getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"} />);
  fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Growth Sync/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Request recording or notes" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Recording" }));
  fireEvent.click(screen.getByRole("button", { name: "Review request" }));
  expect(screen.getByRole("button", { name: "Send request" })).toBeInTheDocument();
}
const send = () => fireEvent.click(screen.getByRole("button", { name: /^(Send request|Try again)$/ }));
const noSend = () => expect(screen.queryByRole("button", { name: /^(Send request|Try again)$/ })).toBeNull();

describe("Calendar Insights request refusal recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    CacheService.getInstance().clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    mocks.getIdToken.mockResolvedValue("firebase-owner-token");
    mocks.inviteShare.mockReturnValue({ title: "Join me on One", text: "Join", dialogTitle: "Invite", url: "https://one.example/?invite=one" });
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string }) =>
      path === "meetings"
        ? { complete: true, calendar_complete: true, next_cursor: null, date: body.date, time_zone: body.time_zone,
            account_id: "default", limitations: [], checked_events: 1, meetings: [row], meeting_file_access: "ready" }
        : { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    mocks.approvedDetail.mockResolvedValue({ event: { title: row.title }, discovery: "checked", complete: true, artifacts: [] });
    mocks.requestStatuses.mockImplementation(async (selections: { occurrence_id: string }[]) =>
      selections.map(selection => ({ occurrence_id: selection.occurrence_id, requests: [], artifacts: [] })));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("removes Send after an unreachable organizer, never repeats it, and offers Connect, Invite and Copy", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_organizer_unavailable", "organizer_unresolved"));
    await reachConfirmStep();
    send();

    const panel = await screen.findByTestId("calendar-request-recovery");
    noSend();
    expect(within(panel).getByRole("alert")).toHaveTextContent("isn't connected to you on One");
    expect(within(panel).getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/one/connect");
    expect(within(panel).getByRole("button", { name: "Invite to One" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Copy request" })).toBeInTheDocument();
    expect(mocks.requestFiles).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.requestFiles).toHaveBeenCalledTimes(1);
  });

  it("Copy writes the meeting-specific request and says whether it worked", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_organizer_unavailable", "organizer_unresolved"));
    await reachConfirmStep();
    send();
    const panel = await screen.findByTestId("calendar-request-recovery");

    mocks.copy.mockResolvedValueOnce(true);
    fireEvent.click(within(panel).getByRole("button", { name: "Copy request" }));
    expect(await within(panel).findByRole("status")).toHaveTextContent("Request copied.");
    const copied = String(mocks.copy.mock.calls[0]?.[0]);
    expect(copied).toContain("Growth Sync (2026-10-14)");
    expect(copied).toContain("owner@example.com");
    expect(copied).toContain("https://one.example/?invite=one");

    mocks.copy.mockResolvedValueOnce(false);
    fireEvent.click(within(panel).getByRole("button", { name: "Copy request" }));
    await waitFor(() => expect(within(panel).getByRole("status")).toHaveTextContent("Couldn't copy automatically"));
    expect(within(panel).getByRole("textbox", { name: "Request to send to the organizer" })).toHaveValue(copied);
  });

  it("Invite reports a copied link and stays quiet when the person dismisses the share sheet", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "connection_required"));
    await reachConfirmStep();
    send();
    const panel = await screen.findByTestId("calendar-request-recovery");

    mocks.share.mockResolvedValueOnce("copied");
    fireEvent.click(within(panel).getByRole("button", { name: "Invite to One" }));
    expect(await within(panel).findByRole("status")).toHaveTextContent("Invite link copied.");

    mocks.share.mockRejectedValueOnce(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Invite to One" }));
    await waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(2));
    expect(within(panel).getByRole("status")).toHaveTextContent("Invite link copied.");
  });

  it("does not offer an invite when this build has no shareable link", async () => {
    mocks.inviteShare.mockReturnValue(null);
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_organizer_unavailable", "organizer_unresolved"));
    await reachConfirmStep();
    send();
    const panel = await screen.findByTestId("calendar-request-recovery");
    expect(within(panel).queryByRole("button", { name: "Invite to One" })).toBeNull();
    expect(within(panel).getByRole("link", { name: "Connect" })).toBeInTheDocument();
  });

  it("a meeting with no reachable organizer can only be copied, never connected or invited", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_organizer_unavailable", "organizer_missing"));
    await reachConfirmStep();
    send();
    const panel = await screen.findByTestId("calendar-request-recovery");
    expect(within(panel).queryByRole("link", { name: "Connect" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Invite to One" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Copy request" })).toBeInTheDocument();
    noSend();
  });

  it.each([
    ["requester_is_organizer", /organized this meeting/],
    ["event_cancelled", /was cancelled/],
    ["requester_declined", /declined this meeting/],
  ])("attendee refusal %s explains itself and offers nothing to send", async (reason, text) => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_attendee_required", reason));
    await reachConfirmStep();
    send();
    const panel = await screen.findByTestId("calendar-request-recovery");
    expect(within(panel).getByRole("alert")).toHaveTextContent(text);
    expect(within(panel).queryByRole("link", { name: "Connect" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Invite to One" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Copy request" })).toBeNull();
    noSend();
  });

  it("an attendee the selected account cannot be verified as may still copy a direct request", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_attendee_required", "requester_not_listed"));
    await reachConfirmStep();
    send();
    const panel = await screen.findByTestId("calendar-request-recovery");
    expect(within(panel).getByRole("alert")).toHaveTextContent("isn't verified as an invited attendee");
    expect(within(panel).getByRole("button", { name: "Copy request" })).toBeInTheDocument();
    expect(within(panel).queryByRole("link", { name: "Connect" })).toBeNull();
  });

  it("a temporary lookup failure stays retryable and a retry can succeed", async () => {
    mocks.requestFiles
      .mockRejectedValueOnce(refusal(503, "recipient_verification_unavailable", undefined, "Couldn't check their Google account. Try again."))
      .mockResolvedValueOnce({ requestId: "11111111-1111-4111-8111-111111111111", recipientEmail: "owner@example.com", status: "pending" });
    await reachConfirmStep();
    send();

    expect(await screen.findByText("Couldn't check their Google account. Try again.")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-request-recovery")).toBeNull();
    expect(screen.queryByRole("link", { name: "Connect" })).toBeNull();
    send(); // now labelled "Try again"
    await waitFor(() => expect(mocks.requestFiles).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Request sent to the organizer/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Send request|Try again)$/ })).toBeNull();
  });

  it("a service-level outage is retryable and also allows a direct copy", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(503, "sharing_unavailable", undefined, "Document sharing is not available yet."));
    await reachConfirmStep();
    send();
    expect(await screen.findByText("Document sharing is not available yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy request" })).toBeInTheDocument();
  });

  it("choosing to request again after a terminal refusal starts clean", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_organizer_unavailable", "organizer_unresolved"));
    await reachConfirmStep();
    send();
    const panel = await screen.findByTestId("calendar-request-recovery");
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("calendar-request-recovery")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Request recording or notes" }));
    expect(screen.getByText(/Choose the files to ask the organizer for/)).toBeInTheDocument();
  });
});

describe("Calendar Insights Feed refresh coalescing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    CacheService.getInstance().clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    mocks.getIdToken.mockResolvedValue("firebase-owner-token");
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string }) =>
      path === "meetings"
        ? { complete: true, calendar_complete: true, next_cursor: null, date: body.date, time_zone: body.time_zone,
            account_id: "default", limitations: [], checked_events: 1, meetings: [row], meeting_file_access: "ready" }
        : { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    mocks.approvedDetail.mockResolvedValue({ event: { title: row.title }, discovery: "checked", complete: true, artifacts: [] });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("delivers a completion that arrives inside the spacing window as one trailing refresh", async () => {
    let shared = false;
    mocks.requestStatuses.mockImplementation(async (selections: { occurrence_id: string }[]) =>
      selections.map(selection => ({ occurrence_id: selection.occurrence_id,
        requests: shared ? [{ requestId: "11111111-1111-4111-8111-111111111111", status: "completed", requestedTypes: ["recording"] }] : [],
        artifacts: shared ? [{ kind: "recording", state: "available" }] : [] })));
    render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
      getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"} />);
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByText("Not available yet (1)")).toBeInTheDocument();

    // An unrelated Feed change starts the spacing window...
    act(() => dispatchFeedStateChanged("arrived"));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    const meetingReads = () => mocks.insights.mock.calls.filter(call => call[0] === "meetings").length;
    const afterFirst = meetingReads();

    // ...then the real completion lands inside it. It must not be dropped.
    shared = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    act(() => dispatchFeedStateChanged("arrived"));
    act(() => dispatchFeedStateChanged("arrived"));
    act(() => dispatchFeedStateChanged("action"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(meetingReads()).toBe(afterFirst); // still deferred, not run per event

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(screen.getByText("Available (1)")).toBeInTheDocument();
    expect(meetingReads()).toBe(afterFirst + 1); // one trailing refresh for the whole burst
  });

  it("does not refresh later if the person has left the library", async () => {
    mocks.requestStatuses.mockImplementation(async (selections: { occurrence_id: string }[]) =>
      selections.map(selection => ({ occurrence_id: selection.occurrence_id, requests: [], artifacts: [] })));
    const view = render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
      getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"} />);
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    act(() => dispatchFeedStateChanged("arrived"));
    act(() => dispatchFeedStateChanged("arrived"));
    const reads = mocks.insights.mock.calls.length;
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mocks.insights.mock.calls.length).toBe(reads);
  });
});
