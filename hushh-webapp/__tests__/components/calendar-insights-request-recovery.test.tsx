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
const asked = (...ids: string[]) => ({ requestType: "calendar_meeting", requestId: "11111111-1111-4111-8111-111111111111",
  recipientEmail: "owner@example.com", status: "pending", requestedTypes: ids });
async function reachAsk(kind: "Recording" | "Notes" | "Both" = "Recording") {
  await openMeeting();
  const ask = await screen.findByRole("button", { name: "Ask organizer" });
  fireEvent.click(screen.getByRole("tab", { name: kind }));
  expect(ask).toBeEnabled();
  return ask;
}
/** Open the meeting under fake timers: nothing polls on its own, so time is advanced explicitly. */
async function openMeetingWithFakeTimers() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
  render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
    getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"} />);
  fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  fireEvent.click(screen.getByRole("button", { name: /Growth Sync/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
}
const askButton = () => screen.getByRole("button", { name: /^(Ask organizer|Asking…)$/ });
const NOT_CONNECTED_HINT = "Requests work once you're connected on One.";
const noOldControls = () => {
  expect(screen.queryByRole("link", { name: "Connect" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy request" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Request to send to the organizer" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Send request|Review request|Request recording or notes/ })).toBeNull();
  expect(screen.queryByText(/Request missing files|We couldn.t verify the files|attendee's shared meeting files/)).toBeNull();
};

describe("Calendar Insights Ask organizer journey", () => {
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

  it("asks what to request with Recording, Notes and Both, and Ask organizer is the one action", async () => {
    await openMeeting();
    expect(await screen.findByText("Recording or notes?")).toBeInTheDocument();
    expect(screen.getByText("What would you like to request?")).toBeInTheDocument();
    for (const name of ["Recording", "Notes", "Both"]) expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask organizer" })).toBeDisabled(); // nothing chosen yet
    noOldControls();
    expect(screen.queryByText(NOT_CONNECTED_HINT)).toBeNull();
    expect(mocks.requestReadiness.mock.calls[0]?.[0]).toEqual({
      account_id: "default", calendar_id: "primary", event_id: "a", occurrence_id: row.occurrence_id,
      expected_grant: grant, date: "2026-10-14", time_zone: "UTC",
    });
    expect(mocks.requestReadiness.mock.calls[0]?.[2]).toBe("vault-owner-token");
  });

  it("a connected requester asks once, in one tap, and sees Request sent with no redirect", async () => {
    let accept: (value: unknown) => void = () => undefined;
    mocks.requestFiles.mockReturnValue(new Promise(resolve => { accept = resolve; }));
    await reachAsk("Both");
    fireEvent.click(askButton());
    fireEvent.click(askButton());
    expect(await screen.findByRole("button", { name: "Asking…" })).toBeDisabled();
    expect(screen.queryByText(/Request sent/)).toBeNull(); // only after the request is durably accepted
    expect(mocks.requestFiles).toHaveBeenCalledTimes(1);
    expect(mocks.requestFiles.mock.calls[0]?.[1]).toEqual(["recording", "notes"]);
    await act(async () => { accept(asked("recording", "notes")); });
    expect(await screen.findByText("Request sent · Waiting for organizer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask organizer" })).toBeNull(); // everything asked for
    expect(window.location.pathname).not.toMatch(/connect/);
    noOldControls();
  });

  it("asking for one type leaves the other available to ask, and never repeats the first", async () => {
    mocks.requestFiles.mockResolvedValueOnce(asked("recording"));
    await reachAsk("Recording");
    fireEvent.click(askButton());
    expect(await screen.findByText("Request sent · Waiting for organizer")).toBeInTheDocument();
    // Only Notes is still outstanding: a single option needs no picker.
    expect(await screen.findByRole("button", { name: "Ask organizer" })).toBeEnabled();
    expect(screen.queryByRole("tab", { name: "Recording" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Both" })).toBeNull();
    mocks.requestFiles.mockResolvedValueOnce({ ...asked("notes"), requestId: "22222222-2222-4222-8222-222222222222" });
    fireEvent.click(screen.getByRole("button", { name: "Ask organizer" }));
    await waitFor(() => expect(mocks.requestFiles).toHaveBeenCalledTimes(2));
    expect(mocks.requestFiles.mock.calls[1]?.[1]).toEqual(["notes"]);
  });

  it("an unconnected requester sees the same controls, cannot send, and gets one quiet hint that links to Connect", async () => {
    mocks.requestReadiness.mockResolvedValue("not_connected");
    await openMeeting();
    const hint = await screen.findByRole("link", { name: NOT_CONNECTED_HINT });
    expect(hint).toHaveAttribute("href", "/one/connect");
    expect(screen.getByRole("tab", { name: "Both" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Recording" }));
    expect(screen.getByRole("button", { name: "Ask organizer" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ask organizer" }));
    expect(mocks.requestFiles).not.toHaveBeenCalled();
    noOldControls();
    expect(screen.queryByText("Connect with the organizer to request files")).toBeNull();
    expect(screen.getAllByRole("link", { name: /connect/i })).toHaveLength(1); // one hint, never a button
  });

  it("tapping the hint remembers the meeting, account, day and chosen type for the way back", async () => {
    mocks.requestReadiness.mockResolvedValue("not_connected");
    await openMeeting();
    fireEvent.click(await screen.findByRole("tab", { name: "Recording" }));
    const hint = await screen.findByRole("link", { name: NOT_CONNECTED_HINT });
    hint.addEventListener("click", event => event.preventDefault());
    fireEvent.click(hint);
    expect(consumeCalendarMeetingOAuthReturn("owner")).toEqual({
      accountId: "default", day: "2026-10-14", timeZone: "UTC", filter: "all", query: "",
      occurrenceId: row.occurrence_id, requestedTypes: ["recording"],
    });
  });

  it("a connected requester never sees anything about connecting", async () => {
    await openMeeting();
    await screen.findByRole("button", { name: "Ask organizer" });
    expect(screen.queryByRole("link", { name: /connect/i })).toBeNull();
    expect(screen.queryByText(/connected on One|Waiting for connection/)).toBeNull();
  });

  it("a pending connection is handled separately and rechecks itself until it is accepted", async () => {
    mocks.requestReadiness.mockResolvedValueOnce("pending").mockResolvedValue("ready");
    await openMeetingWithFakeTimers();
    expect(screen.getByText("Waiting for connection approval.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: NOT_CONNECTED_HINT })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Recording" }));
    expect(screen.getByRole("button", { name: "Ask organizer" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); }); // no tap, no reload, no navigation
    expect(screen.queryByText("Waiting for connection approval.")).toBeNull();
    expect(screen.getByRole("button", { name: "Ask organizer" })).toBeEnabled();
    expect(mocks.requestReadiness).toHaveBeenCalledTimes(2);
  });

  it("a connection accepted while the meeting is open enables asking on the next Feed change", async () => {
    mocks.requestReadiness.mockResolvedValueOnce("not_connected").mockResolvedValue("ready");
    await openMeeting();
    expect(await screen.findByText(NOT_CONNECTED_HINT)).toBeInTheDocument();
    act(() => dispatchFeedStateChanged("arrived"));
    await waitFor(() => expect(screen.queryByText(NOT_CONNECTED_HINT)).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByRole("button", { name: "Ask organizer" })).toBeEnabled();
  });

  it("an authoritative refusal at Ask re-reads the connection and only brings the quiet hint back", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_organizer_unavailable", "organizer_unresolved"));
    await reachAsk();
    mocks.requestReadiness.mockResolvedValue("not_connected");
    fireEvent.click(askButton());
    expect(await screen.findByText(NOT_CONNECTED_HINT)).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-request-recovery")).toBeNull();
    noOldControls();
    expect(mocks.requestFiles).toHaveBeenCalledTimes(1);
    expect(mocks.requestReadiness).toHaveBeenCalledTimes(2);
  });

  it("a connection_required answer that turns out pending shows the pending line", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "connection_required"));
    await reachAsk();
    mocks.requestReadiness.mockResolvedValue("pending");
    fireEvent.click(askButton());
    expect(await screen.findByText("Waiting for connection approval.")).toBeInTheDocument();
    noOldControls();
  });

  it("an organizer One cannot confirm is explained without sending or copying", async () => {
    mocks.requestReadiness.mockResolvedValue("unavailable");
    await openMeeting();
    expect(await screen.findByText(/can't confirm who this organizer is/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask organizer" })).toBeNull();
    noOldControls();
  });

  it("a locked vault asks to unlock and is never read as unconnected", async () => {
    await openMeeting(() => null);
    expect(await screen.findByText("Unlock your vault to ask the organizer.")).toBeInTheDocument();
    expect(mocks.requestReadiness).not.toHaveBeenCalled();
    expect(screen.queryByText(NOT_CONNECTED_HINT)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Recording" }));
    expect(mocks.requestFiles).not.toHaveBeenCalled();
  });

  it("a check that could not finish offers a retry and never claims the organizer is unconnected", async () => {
    mocks.requestReadiness
      .mockRejectedValueOnce(refusal(503, "recipient_verification_unavailable", undefined, "Couldn't check their Google account. Try again."))
      .mockResolvedValueOnce("ready");
    await openMeeting();
    expect(await screen.findByText(/Couldn.t check right now/)).toBeInTheDocument();
    expect(screen.queryByText(NOT_CONNECTED_HINT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText(/Couldn.t check right now/)).toBeNull());
    expect(mocks.requestReadiness).toHaveBeenCalledTimes(2);
  });

  it("the organizer's Don't have is reported per type, and that type is not offered again", async () => {
    mocks.requestStatuses.mockImplementation(async (selections: { occurrence_id: string }[]) =>
      selections.map(selection => ({ occurrence_id: selection.occurrence_id, artifacts: [], requests: [
        { requestId: "11111111-1111-4111-8111-111111111111", status: "pending",
          requestedTypes: ["recording", "notes"], notAvailableTypes: ["recording"] }] })));
    await openMeeting();
    expect(await screen.findByText(/The organizer says they don't have the recording\./)).toBeInTheDocument();
    expect(screen.getByText(/Request sent for the notes\. Waiting for organizer\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask organizer" })).toBeNull(); // nothing left to ask
    expect(screen.queryByText(/doesn't exist|does not exist/)).toBeNull();
  });

  it("when the organizer lacks everything it says so and offers nothing to repeat", async () => {
    mocks.requestStatuses.mockImplementation(async (selections: { occurrence_id: string }[]) =>
      selections.map(selection => ({ occurrence_id: selection.occurrence_id, artifacts: [], requests: [
        { requestId: "11111111-1111-4111-8111-111111111111", status: "declined",
          requestedTypes: ["recording", "notes"], notAvailableTypes: ["notes", "recording"] }] })));
    await openMeeting();
    expect(await screen.findByText("The organizer says they don't have the recording or the notes.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask organizer" })).toBeNull();
    expect(screen.queryByText(/declined this request/)).toBeNull();
  });

  it("goes from Request sent to Checking access to Available without a reload", async () => {
    let phase: "sent" | "approved" | "shared" = "sent";
    mocks.requestStatuses.mockImplementation(async (selections: { occurrence_id: string }[]) =>
      selections.map(selection => ({ occurrence_id: selection.occurrence_id,
        requests: [{ requestId: "11111111-1111-4111-8111-111111111111",
          status: phase === "sent" ? "pending" : phase === "approved" ? "approved" : "completed", requestedTypes: ["recording", "notes"] }],
        artifacts: phase === "shared" ? [{ kind: "recording", state: "available" }, { kind: "notes", state: "available" }] : [] })));
    await openMeetingWithFakeTimers();
    expect(screen.getByText("Request sent · Waiting for organizer")).toBeInTheDocument();
    phase = "approved"; // the organizer acted; the Feed event is the fast path
    act(() => dispatchFeedStateChanged("arrived"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("Checking access…")).toBeInTheDocument();
    expect(screen.queryByText(/Recording.*Available|Verified file access/)).toBeNull(); // never Available before it is verified
    phase = "shared";
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); }); // bounded fallback, no event needed
    expect(screen.queryByText("Checking access…")).toBeNull();
    expect(screen.queryByText(/Request sent/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask organizer" })).toBeNull();
  });

  it("Google authorization from an open meeting remembers that meeting and the chosen type", async () => {
    mocks.requestStatuses.mockImplementation(async (selections: { occurrence_id: string }[]) =>
      selections.map(selection => ({ occurrence_id: selection.occurrence_id, requests: [],
        artifacts: [{ kind: "recording", state: "permission_required" }] })));
    const allow = vi.fn();
    render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
      getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"} onAllowMeetingFiles={allow} />);
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Growth Sync/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Allow recording and notes access" }));
    expect(allow).toHaveBeenCalledWith("default", {
      accountId: "default", day: "2026-10-14", timeZone: "UTC", filter: "all", query: "",
      occurrenceId: row.occurrence_id, requestedTypes: ["notes"],
    });
  });

  it("returning from Google lands on the same meeting with the same type chosen", async () => {
    render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
      getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"}
      initialLibrary={{ accountId: "default", day: "2026-10-14", timeZone: "UTC", filter: "all", query: "",
        occurrenceId: row.occurrence_id, requestedTypes: ["recording"] }} />);
    expect(await screen.findByRole("heading", { name: "Growth Sync" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Recording", selected: true })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Ask organizer" })).toBeEnabled();
  });

  it("returning to a meeting that is no longer listed stays on the day's list", async () => {
    render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
      getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"}
      initialLibrary={{ accountId: "default", day: "2026-10-14", timeZone: "UTC", filter: "all", query: "",
        occurrenceId: "c".repeat(64), requestedTypes: ["notes"] }} />);
    expect(await screen.findByRole("button", { name: /Growth Sync/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask organizer" })).toBeNull();
    expect(mocks.requestReadiness).not.toHaveBeenCalled();
  });

  it("Copy writes the meeting-specific request for a refusal that is not about a connection", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_attendee_required", "requester_not_listed"));
    await reachAsk();
    fireEvent.click(askButton());
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

  it("a meeting with no organizer One can reach can only be copied, never connected", async () => {
    mocks.requestReadiness.mockRejectedValue(refusal(409, "calendar_organizer_unavailable", "organizer_missing"));
    await openMeeting();
    const panel = await screen.findByTestId("calendar-request-recovery");
    expect(within(panel).queryByRole("link", { name: "Connect" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Copy request" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask organizer" })).toBeNull();
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
    expect(screen.queryByRole("button", { name: "Ask organizer" })).toBeNull();
    expect(mocks.requestFiles).not.toHaveBeenCalled();
  });

  it("a temporary lookup failure at Ask stays retryable and a second tap can succeed", async () => {
    mocks.requestFiles
      .mockRejectedValueOnce(refusal(503, "recipient_verification_unavailable", undefined, "Couldn't check their Google account. Try again."))
      .mockResolvedValueOnce(asked("recording"));
    await reachAsk();
    fireEvent.click(askButton());
    expect(await screen.findByText("Couldn't check their Google account. Try again.")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-request-recovery")).toBeNull();
    fireEvent.click(askButton());
    await waitFor(() => expect(mocks.requestFiles).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Request sent · Waiting for organizer")).toBeInTheDocument();
  });

  it("a service-level outage is retryable and also allows a direct copy", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(503, "sharing_unavailable", undefined, "Document sharing is not available yet."));
    await reachAsk();
    fireEvent.click(askButton());
    expect(await screen.findByText("Document sharing is not available yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask organizer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy request" })).toBeInTheDocument();
  });

  it("choosing again after a terminal refusal starts clean", async () => {
    mocks.requestFiles.mockRejectedValue(refusal(409, "calendar_attendee_required", "requester_not_listed"));
    await reachAsk();
    fireEvent.click(askButton());
    const panel = await screen.findByTestId("calendar-request-recovery");
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("calendar-request-recovery")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByRole("button", { name: "Ask organizer" })).toBeEnabled();
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
