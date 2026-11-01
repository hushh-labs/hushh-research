import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insights: vi.fn(), requestFiles: vi.fn(), requestStatuses: vi.fn(), approvedDetail: vi.fn(),
  requestReadiness: vi.fn(), getIdToken: vi.fn(), copy: vi.fn(),
}));
vi.mock("@/lib/services/calendar-insights-service", () => ({
  CalendarInsightsService: { read: mocks.insights, requestFiles: mocks.requestFiles,
    requestStatuses: mocks.requestStatuses, approvedDetail: mocks.approvedDetail, requestReadiness: mocks.requestReadiness },
  CalendarInsightsRequestError: class extends Error {
    constructor(message: string, readonly status: number, readonly code?: string, readonly reason?: string) { super(message); }
  },
  safeMeetingProviderUrl: () => null,
}));
vi.mock("@/components/calendar/calendar-followups", () => ({ CalendarFollowups: () => null }));
vi.mock("@/lib/utils/clipboard", () => ({ copyToClipboard: mocks.copy }));
vi.mock("@/lib/connect/invite-to-one", () => ({ buildInviteToOneShare: () => null, buildInviteToOneUrl: () => "https://one.example/?invite=one" }));

import { CalendarInsights } from "@/components/calendar/calendar-insights";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { CalendarInsightsRequestError } from "@/lib/services/calendar-insights-service";
import { CacheService } from "@/lib/services/cache-service";
import { consumeCalendarMeetingOAuthReturn } from "@/lib/calendar/calendar-oauth-journey";

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

function openMeeting(vault: () => string | null = () => "vault-owner-token") {
  render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
    getIdToken={mocks.getIdToken} getVaultOwnerToken={vault} />);
  fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
  return screen.findByRole("button", { name: /Growth Sync/ }).then(button => fireEvent.click(button));
}
async function reachConfirmStep() {
  await openMeeting();
  fireEvent.click(await screen.findByRole("button", { name: "Request recording or notes" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Recording" }));
  fireEvent.click(screen.getByRole("button", { name: "Review request" }));
  expect(screen.getByRole("button", { name: "Send request" })).toBeInTheDocument();
}
const send = () => fireEvent.click(screen.getByRole("button", { name: /^(Send request|Try again)$/ }));
const noSend = () => expect(screen.queryByRole("button", { name: /^(Send request|Try again)$/ })).toBeNull();
const noRequestControls = () => {
  expect(screen.queryByRole("button", { name: /^(Send request|Sending…)$/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Request recording or notes" })).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Request to send to the organizer" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy request" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Invite to One" })).toBeNull();
};

describe("Calendar Insights request readiness and refusal recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    CacheService.getInstance().clear();
    window.sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    mocks.getIdToken.mockResolvedValue("firebase-owner-token");
    mocks.requestReadiness.mockResolvedValue("ready");
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

  it("checks the connection for the selected meeting before offering anything to send", async () => {
    await openMeeting();
    expect(await screen.findByRole("button", { name: "Request recording or notes" })).toBeInTheDocument();
    expect(mocks.requestReadiness).toHaveBeenCalledTimes(1);
    expect(mocks.requestReadiness.mock.calls[0]?.[0]).toEqual({
      account_id: "default", calendar_id: "primary", event_id: "a", occurrence_id: row.occurrence_id,
      expected_grant: grant, date: "2026-10-14", time_zone: "UTC",
    });
    expect(mocks.requestReadiness.mock.calls[0]?.[2]).toBe("vault-owner-token");
  });

  it("shows only a compact checking line, with nothing to send, while the check is running", async () => {
    let settle: (state: string) => void = () => undefined;
    mocks.requestReadiness.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    await openMeeting();
    expect(await screen.findByText("Checking your connection to the organizer…")).toBeInTheDocument();
    noRequestControls();
    await act(async () => { settle("ready"); });
    expect(await screen.findByRole("button", { name: "Request recording or notes" })).toBeInTheDocument();
  });

  it("an unconnected requester sees Connect, with no way to send and no copy fallback", async () => {
    mocks.requestReadiness.mockResolvedValue("not_connected");
    await openMeeting();
    const panel = await screen.findByTestId("calendar-request-recovery");
    expect(within(panel).getByRole("alert")).toHaveTextContent("Connect with the organizer to request files");
    expect(within(panel).getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/one/connect");
    noRequestControls();
    expect(mocks.requestFiles).not.toHaveBeenCalled();
  });

  it("a pending connection waits for approval and offers nothing to send", async () => {
    mocks.requestReadiness.mockResolvedValue("pending");
    await openMeeting();
    expect(await screen.findByText("Waiting for connection approval.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect" })).toBeNull();
    noRequestControls();
  });

  it("an organizer One cannot confirm is explained without Send or Connect", async () => {
    mocks.requestReadiness.mockResolvedValue("unavailable");
    await openMeeting();
    expect(await screen.findByText(/can't confirm who this organizer is/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect" })).toBeNull();
    noRequestControls();
  });

  it("an unlocked vault is required to check, and a locked one never reads as unconnected", async () => {
    await openMeeting(() => null);
    expect(await screen.findByText("Unlock your vault to request files.")).toBeInTheDocument();
    expect(mocks.requestReadiness).not.toHaveBeenCalled();
    expect(screen.queryByText(/Connect with the organizer/)).toBeNull();
    noRequestControls();
  });

  it("a check that could not finish offers a retry and never claims the organizer is unconnected", async () => {
    mocks.requestReadiness
      .mockRejectedValueOnce(refusal(503, "recipient_verification_unavailable", undefined, "Couldn't check their Google account. Try again."))
      .mockResolvedValueOnce("ready");
    await openMeeting();
    expect(await screen.findByText("Couldn't check your connection to the organizer.")).toBeInTheDocument();
    expect(screen.queryByText(/Connect with the organizer/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Connect" })).toBeNull();
    noRequestControls();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Request recording or notes" })).toBeInTheDocument();
    expect(mocks.requestReadiness).toHaveBeenCalledTimes(2);
  });

  it("a connection accepted while the meeting is open enables requesting and clears the old state", async () => {
    mocks.requestReadiness.mockResolvedValueOnce("pending").mockResolvedValue("ready");
    await openMeeting();
    expect(await screen.findByText("Waiting for connection approval.")).toBeInTheDocument();
    act(() => dispatchFeedStateChanged("arrived"));
    expect(await screen.findByRole("button", { name: "Request recording or notes" })).toBeInTheDocument();
    expect(screen.queryByText("Waiting for connection approval.")).toBeNull();
  });

  it("an authoritative refusal at Send re-reads the connection and replaces Send with Connect", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_organizer_unavailable", "organizer_unresolved"));
    await reachConfirmStep();
    mocks.requestReadiness.mockResolvedValue("not_connected");
    send();

    const panel = await screen.findByTestId("calendar-request-recovery");
    expect(within(panel).getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/one/connect");
    noRequestControls();
    expect(mocks.requestReadiness).toHaveBeenCalledTimes(2);
    expect(mocks.requestFiles).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.requestFiles).toHaveBeenCalledTimes(1);
  });

  it("a refused connection_required answer is treated the same way", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "connection_required"));
    await reachConfirmStep();
    mocks.requestReadiness.mockResolvedValue("pending");
    send();
    expect(await screen.findByText("Waiting for connection approval.")).toBeInTheDocument();
    noRequestControls();
  });

  it("Connect remembers the meeting, account, day and chosen files for the way back", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "connection_required"));
    await reachConfirmStep();
    mocks.requestReadiness.mockResolvedValue("not_connected");
    send();
    const panel = await screen.findByTestId("calendar-request-recovery");
    const connect = within(panel).getByRole("link", { name: "Connect" });
    connect.addEventListener("click", event => event.preventDefault());
    fireEvent.click(connect);
    expect(consumeCalendarMeetingOAuthReturn("owner")).toEqual({
      accountId: "default", day: "2026-10-14", timeZone: "UTC", filter: "all", query: "",
      occurrenceId: row.occurrence_id, requestedTypes: ["recording"],
    });
  });

  it("returning from Connect lands on the same meeting with the same files, ready to send", async () => {
    render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
      getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"}
      initialLibrary={{ accountId: "default", day: "2026-10-14", timeZone: "UTC", filter: "all", query: "",
        occurrenceId: row.occurrence_id, requestedTypes: ["recording"] }} />);
    expect(await screen.findByRole("heading", { name: "Growth Sync" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Send request" })).toBeInTheDocument();
    expect(screen.getByText("Requested: recording")).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
  });

  it("returning to a meeting that is no longer listed stays on the day's list", async () => {
    render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
      getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"}
      initialLibrary={{ accountId: "default", day: "2026-10-14", timeZone: "UTC", filter: "all", query: "",
        occurrenceId: "c".repeat(64), requestedTypes: ["notes"] }} />);
    expect(await screen.findByRole("button", { name: /Growth Sync/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send request" })).toBeNull();
    expect(mocks.requestReadiness).not.toHaveBeenCalled();
  });

  it("shows Request sent only after the request is durably accepted, and sends once", async () => {
    let accept: (value: unknown) => void = () => undefined;
    mocks.requestFiles.mockReturnValue(new Promise(resolve => { accept = resolve; }));
    await reachConfirmStep();
    const button = screen.getByRole("button", { name: "Send request" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.queryByText(/Request sent to the organizer/)).toBeNull();
    expect(mocks.requestFiles).toHaveBeenCalledTimes(1);
    await act(async () => { accept({ requestType: "calendar_meeting", requestId: "11111111-1111-4111-8111-111111111111", recipientEmail: "owner@example.com", status: "pending" }); });
    expect(await screen.findByText(/Request sent to the organizer/)).toBeInTheDocument();
  });

  it("Google authorization from an open meeting remembers that meeting and the chosen files", async () => {
    mocks.requestStatuses.mockImplementation(async (selections: { occurrence_id: string }[]) =>
      selections.map(selection => ({ occurrence_id: selection.occurrence_id, requests: [],
        artifacts: [{ kind: "recording", state: "permission_required" }] })));
    const allow = vi.fn();
    render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
      getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"} onAllowMeetingFiles={allow} />);
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Growth Sync/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Request recording or notes" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Allow recording and notes access" }));
    expect(allow).toHaveBeenCalledWith("default", {
      accountId: "default", day: "2026-10-14", timeZone: "UTC", filter: "all", query: "",
      occurrenceId: row.occurrence_id, requestedTypes: ["notes"],
    });
  });

  it("Copy writes the meeting-specific request for a refusal that is not about a connection", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_attendee_required", "requester_not_listed"));
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
    expect(within(panel).queryByRole("link", { name: "Connect" })).toBeNull();
    noSend();
  });

  it("a meeting with no organizer One can reach can only be copied, never connected", async () => {
    mocks.requestReadiness.mockRejectedValue(refusal(409, "calendar_organizer_unavailable", "organizer_missing"));
    await openMeeting();
    const panel = await screen.findByTestId("calendar-request-recovery");
    expect(within(panel).queryByRole("link", { name: "Connect" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Copy request" })).toBeInTheDocument();
    noSend();
  });

  it.each([
    ["requester_is_organizer", /organized this meeting/],
    ["event_cancelled", /was cancelled/],
    ["requester_declined", /declined this meeting/],
  ])("attendee refusal %s is explained before anything can be sent", async (reason, text) => {
    mocks.requestReadiness.mockRejectedValue(refusal(409, "calendar_attendee_required", reason));
    await openMeeting();
    const panel = await screen.findByTestId("calendar-request-recovery");
    expect(within(panel).getByRole("alert")).toHaveTextContent(text);
    expect(within(panel).queryByRole("link", { name: "Connect" })).toBeNull();
    noRequestControls();
    expect(mocks.requestFiles).not.toHaveBeenCalled();
  });

  it("a temporary lookup failure at Send stays retryable and a retry can succeed", async () => {
    mocks.requestFiles
      .mockRejectedValueOnce(refusal(503, "recipient_verification_unavailable", undefined, "Couldn't check their Google account. Try again."))
      .mockResolvedValueOnce({ requestType: "calendar_meeting", requestId: "11111111-1111-4111-8111-111111111111", recipientEmail: "owner@example.com", status: "pending" });
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
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_attendee_required", "requester_not_listed"));
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
