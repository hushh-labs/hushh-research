import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarTimeZone } from "@/lib/calendar/calendar-time-zone";
import { bookingInstant } from "@/lib/calendar/calendar-booking-time";
import { calendarDate } from "@/components/calendar/calendar-schedule-presentation";

const mocks = vi.hoisted(() => ({
  boardDay: vi.fn(), reviewBoardBooking: vi.fn(), executeProposal: vi.fn(), reviewWorkspaceConflict: vi.fn(), confirmWorkspaceConflict: vi.fn(),
  reviewWorkspaceAttendance: vi.fn(), confirmWorkspaceAttendance: vi.fn(),
  onChat: vi.fn(), onMailConnect: vi.fn(),
}));

vi.mock("@/lib/services/google-calendar-service", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/google-calendar-service")>(),
  GoogleCalendarService: {
    boardDay: mocks.boardDay,
    reviewBoardBooking: mocks.reviewBoardBooking,
    executeProposal: mocks.executeProposal,
    reviewWorkspaceConflict: mocks.reviewWorkspaceConflict,
    confirmWorkspaceConflict: mocks.confirmWorkspaceConflict,
    reviewWorkspaceAttendance: mocks.reviewWorkspaceAttendance,
    confirmWorkspaceAttendance: mocks.confirmWorkspaceAttendance,
  },
}));
vi.mock("@/lib/perf/use-periodic-task", () => ({ usePeriodicTask: vi.fn(), useCoarseClock: () => Date.now() }));
vi.mock("@/components/calendar/calendar-insights", () => ({
  CalendarInsights: ({ account, initialLibrary }: { account: { account_id: string }; initialLibrary?: { day: string } | null }) => {
    const [initial] = useState(initialLibrary);
    return <div><div data-testid="insights-account">{account.account_id}</div><div data-testid="insights-restored-day">{initial?.day || "none"}</div></div>;
  },
}));

import { CalendarAccountBoard } from "@/components/calendar/calendar-account-board";
import type { CalendarBoardDay, GoogleCalendarStatus } from "@/lib/services/google-calendar-service";
import { markCalendarMeetingOAuthReturn } from "@/lib/calendar/calendar-oauth-journey";

const date = "2026-10-21";
const event = (account: string, id: string, title: string, start: string, end: string) => ({
  account_id: account, id, calendar_id: "primary", title,
  start: { dateTime: start }, end: { dateTime: end }, etag: `etag-${id}`,
  organizer: { email: `organizer-${id}@example.com` }, can_decline: true,
  attendees: [{ email: `${account}@example.com`, response_status: "needsAction" }],
});
const meetingA = event("default", "one", "Planning review", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z");
const meetingB = event("second", "two", "Client call", "2026-10-21T10:30:00Z", "2026-10-21T11:30:00Z");
const board = {
  date, time_zone: "UTC", duration_minutes: 30, complete: true, conflicts_complete: true,
  checked_at: "2026-10-21T08:00:00Z", shared_free_windows: [{ start_at: "2026-10-21T12:00:00Z", end_at: "2026-10-21T13:00:00Z" }],
  conflicts: [{ left: { account_id: "default", calendar_id: "primary", event_id: "one" }, right: { account_id: "second", calendar_id: "primary", event_id: "two" }, start_at: "2026-10-21T10:30:00Z", end_at: "2026-10-21T11:00:00Z" }],
  accounts: [
    { account_id: "default", google_email: "default@example.com", connection_status: "connected", status: "complete", events: [meetingA], free_windows: [], unreadable_calendars: [], calendar_options: [{ id: "primary", name: "Primary calendar", availability_default_included: true }, { id: "work", name: "Work calendar", availability_default_included: true }] },
    { account_id: "second", google_email: "second@example.com", connection_status: "connected", status: "complete", events: [meetingB], free_windows: [], unreadable_calendars: [] },
    { account_id: "third", google_email: "third@example.com", connection_status: "connected", status: "complete", events: [], free_windows: [], unreadable_calendars: [] },
  ],
} satisfies CalendarBoardDay;
const status = {
  configured: true, connected: true, status: "connected", access_level: "manage", google_email: "default@example.com", scope_csv: "", calendar_list_access: true,
  accounts: board.accounts.map(account => ({ account_id: account.account_id, google_email: account.google_email, google_email_verified: account.account_id === "default", status: "connected" as const, connected: true, access_level: "manage" as const, calendar_list_access: true })),
} satisfies GoogleCalendarStatus;

function page(currentStatus: GoogleCalendarStatus = status, calendarPeople = new Map()) {
  return <CalendarAccountBoard userId="owner" status={currentStatus} calendarPeople={calendarPeople} busy={false} token="owner-token"
    getIdToken={async () => "firebase-token"} onAddAccount={vi.fn()} onReconnectAccount={vi.fn()}
    onDisconnectAccount={vi.fn()} onConnect={vi.fn()} onMailConnect={mocks.onMailConnect}
    onChat={mocks.onChat} />;
}

describe("three-account Calendar board", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    window.sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T08:00:00Z`));
    vi.clearAllMocks();
    mocks.boardDay.mockResolvedValue(board);
    mocks.reviewBoardBooking.mockImplementation(async (input: { accountId: string; title: string; startAt: string; endAt: string; timeZone: string; attendees: string[]; meetingType: string }) => ({
      proposal_id: "gcal_reviewed_booking", expires_at: "2999-01-01T00:00:00Z", confirmation_required: true,
      plan: { account_id: input.accountId, title: input.title, start_at: input.startAt, end_at: input.endAt, time_zone: input.timeZone, attendees: input.attendees, meeting_type: input.meetingType, description: "", location: "", board_conflicts: [], board_accounts: status.accounts.map(account => ({ account_id: account.account_id, account_email: account.google_email, binding: [account.account_id], calendar_ids: ["primary"] })) },
    }));
    mocks.executeProposal.mockResolvedValue({ action: "create", event: { id: "created-event", title: "Bug Bash" } });
    mocks.reviewWorkspaceConflict.mockImplementation(async ({ decline }: { decline: { message: string }[] }) => ({ review_id: "review-conflict", review_token: "sealed-review", expires_at: "2999-01-01T00:00:00Z", previews: [
      { kind: "keep", ref: board.conflicts[0].right, title: meetingB.title, account_email: "second@example.com", start: meetingB.start, end: meetingB.end, action: "accept" },
      { kind: "decline", ref: board.conflicts[0].left, title: meetingA.title, account_email: "default@example.com", start: meetingA.start, end: meetingA.end, action: "decline and send note", sender_label: "Owner <mail@example.com>", recipient: "organizer-one@example.com", subject: "Unable to attend", message: decline[0].message },
    ] }));
    mocks.confirmWorkspaceConflict.mockResolvedValue({ complete: true, results: [
      { kind: "keep", ref: board.conflicts[0].right, calendar: "accepted", email: "not_sent" },
      { kind: "decline", ref: board.conflicts[0].left, calendar: "declined", email: "sent" },
    ] });
    mocks.reviewWorkspaceAttendance.mockImplementation(async ({ message }: { message: string }) => ({ review_id: "retry-review", review_token: "sealed-retry", expires_at: "2999-01-01T00:00:00Z", title: meetingA.title, start: meetingA.start, end: meetingA.end, recipient: "organizer-one@example.com", sender_label: "Owner <mail@example.com>", subject: "Unable to attend", message }));
    mocks.confirmWorkspaceAttendance.mockResolvedValue({ calendar: "declined", email: "sent", calendar_error: null, email_error: null });
  });

  afterEach(() => vi.useRealTimers());

  it("shows all three accounts, shared free time, and resolves a cross-account overlap inline", async () => {
    render(page());
    await screen.findByText("Planning review");
    expect(screen.getByText("Client call")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Calendar account third@example.com" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Free across all accounts" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Review 1 overlapping meeting for Planning review/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Resolve these overlaps" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep this instead" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Client call")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.change(within(dialog).getByPlaceholderText("Explain why you cannot attend"), { target: { value: "I need to join the client call." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review Calendar and Mail" }));
    await waitFor(() => expect(mocks.reviewWorkspaceConflict).toHaveBeenCalledOnce());
    expect(mocks.reviewWorkspaceConflict.mock.calls[0][0]).toEqual(expect.objectContaining({ firebaseIdToken: "firebase-token" }));
    expect(mocks.reviewWorkspaceConflict.mock.calls[0][0]).not.toHaveProperty("vaultOwnerToken");
    expect(mocks.reviewWorkspaceConflict.mock.calls[0][0].decline[0].message).toContain("I need to join the client call.");
    expect(mocks.reviewWorkspaceConflict.mock.calls[0][0].decline[0].message).toContain("Planning review");
    expect(mocks.confirmWorkspaceConflict).not.toHaveBeenCalled();
    expect(within(dialog).getByText("To: organizer-one@example.com")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm selected changes" }));
    await waitFor(() => expect(mocks.confirmWorkspaceConflict).toHaveBeenCalledOnce());
    expect(within(dialog).getByText("Calendar: declined · Mail: sent")).toBeTruthy();
    expect(mocks.onChat).not.toHaveBeenCalled();
  });

  it("selects each of the three accounts in Insights without the Board summary", () => {
    const husshPhoto = "data:image/png;base64,aGVsbG8=";
    const verifiedStatus = { ...status, accounts: status.accounts.map(account => ({ ...account, google_email_verified: account.account_id !== "third" })) };
    const people = new Map([
      ["default@example.com", { userId: "owner", displayName: null, photoUrl: husshPhoto }],
      ["second@example.com", { userId: "peer", displayName: null, photoUrl: husshPhoto }],
    ]);
    render(page(verifiedStatus, people));
    fireEvent.click(screen.getByRole("tab", { name: "Insights" }));
    const insights = screen.getByRole("region", { name: "Calendar insights" });
    const selector = () => within(insights).getByRole("button", { name: /^Calendar account:/ });
    expect(within(insights).getByTestId("insights-account")).toHaveTextContent("default");
    expect(selector().querySelector("[data-photo-source]")).toHaveAttribute("data-photo-source", "hussh");
    fireEvent.keyDown(selector(), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: /second@example.com/ }));
    expect(within(insights).getByTestId("insights-account")).toHaveTextContent("second");
    expect(selector().querySelector("[data-photo-source]")).toHaveAttribute("data-photo-source", "hussh");
    fireEvent.keyDown(selector(), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: /third@example.com/ }));
    expect(within(insights).getByTestId("insights-account")).toHaveTextContent("third");
    expect(selector().querySelector("[data-photo-url]")).toBeNull();
    expect(selector().querySelector("[data-slot=avatar-fallback]")).toHaveTextContent("T");
    expect(within(insights).queryByText("Across your connected accounts today")).toBeNull();
  });

  it("returns to the exact account's library once after OAuth without replaying its old day", () => {
    markCalendarMeetingOAuthReturn("owner", { accountId: "second", day: "2026-10-14", timeZone: "UTC", filter: "notes", query: "Growth" });
    render(page());
    const insights = screen.getByRole("region", { name: "Calendar insights" });
    expect(within(insights).getByRole("button", { name: "Calendar account: second@example.com" })).toBeTruthy();
    expect(within(insights).getByTestId("insights-restored-day")).toHaveTextContent("2026-10-14");
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    fireEvent.click(screen.getByRole("tab", { name: "Insights" }));
    expect(screen.getByTestId("insights-account")).toHaveTextContent("second");
    expect(screen.getByTestId("insights-restored-day")).toHaveTextContent("none");
  });

  it("books an account's free time into that account without asking for an account", async () => {
    mocks.boardDay.mockResolvedValue({ ...board, accounts: [{ ...board.accounts[0], free_windows: board.shared_free_windows }], conflicts: [] });
    const husshPhoto = "data:image/png;base64,aGVsbG8=";
    render(page({ ...status, accounts: status.accounts.slice(0, 1) }, new Map([["default@example.com", { userId: "owner", displayName: null, photoUrl: husshPhoto }]])));
    const account = await screen.findByRole("group", { name: "Calendar account default@example.com" });
    fireEvent.click(within(account).getByRole("tab", { name: "Free time" }));
    fireEvent.click(await within(account).findByRole("button", { name: /Schedule from free time/ }));
    const dialog = screen.getByRole("dialog", { name: "Schedule meeting" });
    expect(within(dialog).queryByRole("combobox", { name: "Calendar account and destination" })).toBeNull();
    expect(within(dialog).queryByRole("combobox", { name: "Time zone" })).toBeNull();
    expect(dialog.querySelector("[data-photo-source]")).toHaveAttribute("data-photo-source", "hussh");
    expect(within(dialog).getByPlaceholderText("Project planning meeting")).toBeTruthy();
    const where = within(dialog).getByRole("combobox", { name: "Where" });
    expect(within(where).getByRole("option", { name: "Existing Meet, Zoom, or Teams link" })).toBeTruthy();
    fireEvent.change(where, { target: { value: "external_link" } });
    expect(within(dialog).getByPlaceholderText("https://zoom.us/j/123456789")).toBeTruthy();
    fireEvent.change(where, { target: { value: "google_meet" } });
    expect(within(dialog).queryByText("Your calendar updates after Google confirms the event.")).toBeNull();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Bug Bash" } });
    expect(within(dialog).getByRole("combobox", { name: "Duration" })).toHaveValue("60");
    expect(dialog).not.toHaveTextContent("Primary calendar");
    expect(dialog).not.toHaveTextContent("No guests creates");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review meeting" }));
    await waitFor(() => expect(mocks.reviewBoardBooking).toHaveBeenCalledOnce());
    expect(mocks.reviewBoardBooking).toHaveBeenCalledWith(expect.objectContaining({ accountId: "default", checkedAccountIds: ["default"], title: "Bug Bash", startAt: "2026-10-21T12:00:00.000Z", endAt: "2026-10-21T13:00:00.000Z" }));
    expect(mocks.executeProposal).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Schedule personal block" }));
    await waitFor(() => expect(mocks.executeProposal).toHaveBeenCalledWith(expect.objectContaining({ accountId: "default", proposalId: "gcal_reviewed_booking" })));
    expect(mocks.onChat).not.toHaveBeenCalled();
  });

  it("requires an explicit account for a shared opening and binds the chosen third account", async () => {
    render(page());
    await screen.findByText("Planning review");
    fireEvent.click(screen.getByRole("button", { name: /Schedule from shared free time/ }));
    const dialog = screen.getByRole("dialog", { name: "Schedule meeting" });
    expect(within(dialog).getByRole("button", { name: "Review meeting" })).toBeDisabled();
    expect(within(dialog).getByRole("option", { name: "third@example.com" })).toBeTruthy();
    expect(dialog).not.toHaveTextContent("Primary calendar");
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Calendar account and destination" }), { target: { value: "third" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Bug Bash" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review meeting" }));
    await waitFor(() => expect(mocks.reviewBoardBooking).toHaveBeenCalledWith(expect.objectContaining({ accountId: "third", checkedAccountIds: ["default", "second", "third"] })));
    fireEvent.click(within(dialog).getByRole("button", { name: "Schedule personal block" }));
    await waitFor(() => expect(mocks.executeProposal).toHaveBeenCalledWith(expect.objectContaining({ accountId: "third" })));
    expect(mocks.onChat).not.toHaveBeenCalled();
  });

  it("requires a fresh review before confirming edited guests", async () => {
    render(page());
    fireEvent.click(await screen.findByRole("button", { name: /Schedule from shared free time/ }));
    const dialog = screen.getByRole("dialog", { name: "Schedule meeting" });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Calendar account and destination" }), { target: { value: "second" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Bug Bash" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review meeting" }));
    await within(dialog).findByRole("button", { name: "Schedule personal block" });
    expect(within(dialog).queryByRole("combobox", { name: /Guests/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit details" }));
    fireEvent.change(within(dialog).getByRole("combobox", { name: /Guests/ }), { target: { value: "new@example.com" } });
    expect(within(dialog).queryByRole("button", { name: "Schedule personal block" })).toBeNull();
    expect(mocks.executeProposal).not.toHaveBeenCalled();
  });

  it("returns to the event's Board date after booking in the detected time zone", async () => {
    const boardZone = calendarTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const startAt = bookingInstant(date, "23:30", boardZone);
    const boardDate = calendarDate(Date.parse(startAt), boardZone);
    render(page());
    fireEvent.click(await screen.findByRole("button", { name: /Schedule from shared free time/ }));
    const dialog = screen.getByRole("dialog", { name: "Schedule meeting" });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Calendar account and destination" }), { target: { value: "second" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Midnight planning" } });
    expect(within(dialog).queryByRole("combobox", { name: "Time zone" })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: date } });
    fireEvent.change(within(dialog).getByLabelText("Start"), { target: { value: "23:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review meeting" }));
    await waitFor(() => expect(mocks.reviewBoardBooking).toHaveBeenCalledWith(expect.objectContaining({ startAt, selectedDate: date, timeZone: boardZone })));
    const callsBeforeConfirmation = mocks.boardDay.mock.calls.length;
    fireEvent.click(await within(dialog).findByRole("button", { name: "Schedule personal block" }));
    await waitFor(() => expect(mocks.executeProposal).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.boardDay.mock.calls.length).toBeGreaterThan(callsBeforeConfirmation));
    await waitFor(() => expect(mocks.boardDay.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ date: boardDate, timeZone: boardZone })));
  });

  it("retries only a definitely failed organizer email once without changing attendance", async () => {
    mocks.confirmWorkspaceConflict.mockResolvedValue({ complete: false, results: [
      { kind: "keep", ref: board.conflicts[0].right, calendar: "accepted", email: "not_sent" },
      { kind: "decline", ref: board.conflicts[0].left, calendar: "declined", email: "failed" },
    ] });
    render(page());
    fireEvent.click(await screen.findByRole("button", { name: /Review 1 overlapping meeting for Planning review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Resolve these overlaps" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep this instead" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.change(within(dialog).getByPlaceholderText("Explain why you cannot attend"), { target: { value: "I need to join the client call." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review Calendar and Mail" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm selected changes" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: /Review email retry/ }));
    await waitFor(() => expect(mocks.reviewWorkspaceAttendance).toHaveBeenCalledWith(expect.objectContaining({ mailOnlyRetry: true, sendMessage: true, accountId: "default", expectedAccountEmail: "default@example.com" })));
    expect(mocks.reviewWorkspaceAttendance.mock.calls[0][0]).not.toHaveProperty("vaultOwnerToken");
    expect(mocks.reviewWorkspaceAttendance.mock.calls[0][0].message).toBe(mocks.reviewWorkspaceConflict.mock.calls[0][0].decline[0].message);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Send reviewed note" }));
    await waitFor(() => expect(mocks.confirmWorkspaceAttendance).toHaveBeenCalledOnce());
    expect(within(dialog).queryByRole("button", { name: /Review email retry/ })).toBeNull();
    expect(within(dialog).getByText(/Email retry: sent/)).toBeTruthy();
  });

  it("refuses to retry an old note if the invitation changed after the first review", async () => {
    mocks.confirmWorkspaceConflict.mockResolvedValue({ complete: false, results: [
      { kind: "keep", ref: board.conflicts[0].right, calendar: "accepted", email: "not_sent" },
      { kind: "decline", ref: board.conflicts[0].left, calendar: "declined", email: "failed" },
    ] });
    mocks.reviewWorkspaceAttendance.mockImplementationOnce(async ({ message }: { message: string }) => ({ review_id: "retry-review", review_token: "sealed-retry", expires_at: "2999-01-01T00:00:00Z", title: meetingA.title, start: { dateTime: "2026-10-21T12:00:00Z" }, end: meetingA.end, recipient: "organizer-one@example.com", sender_label: "Owner <mail@example.com>", subject: "Unable to attend", message }));
    render(page());
    fireEvent.click(await screen.findByRole("button", { name: /Review 1 overlapping meeting for Planning review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Resolve these overlaps" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep this instead" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.change(within(dialog).getByPlaceholderText("Explain why you cannot attend"), { target: { value: "I need to join the client call." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review Calendar and Mail" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm selected changes" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: /Review email retry/ }));
    expect(await within(dialog).findByText(/This invitation changed since the earlier review/)).toBeInTheDocument();
    expect(mocks.confirmWorkspaceAttendance).not.toHaveBeenCalled();
  });

  it("keeps an uncertain email retry bound to its original review", async () => {
    mocks.confirmWorkspaceConflict.mockResolvedValue({ complete: false, results: [
      { kind: "keep", ref: board.conflicts[0].right, calendar: "accepted", email: "not_sent" },
      { kind: "decline", ref: board.conflicts[0].left, calendar: "declined", email: "failed" },
    ] });
    mocks.confirmWorkspaceAttendance.mockRejectedValueOnce(new Error("Network response was lost"));
    render(page());
    fireEvent.click(await screen.findByRole("button", { name: /Review 1 overlapping meeting for Planning review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Resolve these overlaps" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep this instead" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.change(within(dialog).getByPlaceholderText("Explain why you cannot attend"), { target: { value: "I need to join the client call." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review Calendar and Mail" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm selected changes" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: /Review email retry/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Send reviewed note" }));
    expect(await within(dialog).findByText("Network response was lost")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Review email retry for/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send reviewed note" }));
    await waitFor(() => expect(mocks.confirmWorkspaceAttendance).toHaveBeenCalledTimes(2));
    expect(mocks.reviewWorkspaceAttendance).toHaveBeenCalledOnce();
    expect(mocks.confirmWorkspaceAttendance.mock.calls[1][0].reviewId).toBe(mocks.confirmWorkspaceAttendance.mock.calls[0][0].reviewId);
  });

  it("keeps the board focused on events and free time", async () => {
    render(page());
    await screen.findByText("Planning review");
    expect(screen.getAllByRole("tab", { name: "Free time" })).toHaveLength(3);
    expect(screen.queryByText("Calendars used for free time")).toBeNull();
    expect(screen.queryByRole("button", { name: "15 min" })).toBeNull();
    expect(screen.queryByText(/Asia\/Calcutta/)).toBeNull();
    expect(screen.queryByRole("button", { name: /update permission/i })).toBeNull();
    expect(mocks.boardDay).toHaveBeenCalledWith(expect.objectContaining({ durationMinutes: 15 }));
  });

  it("shows a direct Join link and provider on an event without nesting the link in the details button", async () => {
    mocks.boardDay.mockResolvedValue({ ...board, accounts: [{ ...board.accounts[0], checked_at: board.checked_at, events: [{ ...meetingA, conference_url: "https://meet.google.com/abc-defg-hij" }] }] });
    render(page());
    const join = await screen.findByRole("link", { name: "Join meeting: Planning review" });
    expect(join).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
    expect(join.closest("button")).toBeNull();
    expect(screen.getByText("Google Meet")).toBeInTheDocument();
    expect(screen.getByText("Connected", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/Awaiting your response/i)).toBeNull();
  });

  it("summarizes occasions after meetings and opens a responsive detail dialog", async () => {
    const birthday = { ...event("default", "birthday", "Birthday", "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z"), event_type: "birthday" };
    const holiday = { ...event("default", "holiday", "Festival", "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z"), source_calendar_id: "en.indian#holiday@group.v.calendar.google.com" };
    const extra = [2, 3, 4].map(number => event("default", `meeting-${number}`, `Meeting ${number}`, `2026-10-21T${number + 10}:00:00Z`, `2026-10-21T${number + 10}:30:00Z`));
    mocks.boardDay.mockResolvedValue({ ...board, accounts: [{ ...board.accounts[0], events: [birthday, holiday, { ...meetingA, conference_url: "https://meet.google.com/abc-defg-hij" }, ...extra] }], conflicts: [] });
    const googlePhoto = "https://lh3.googleusercontent.com/a/default=s96-c";
    const husshPhoto = "data:image/png;base64,aGVsbG8=";
    const currentStatus = { ...status, accounts: [{ ...status.accounts[0], profile_photo_url: googlePhoto }] };
    render(page(currentStatus, new Map([["default@example.com", { userId: "owner", displayName: null, photoUrl: husshPhoto }]])));

    const card = await screen.findByRole("group", { name: "Calendar account default@example.com" });
    expect(within(card).getByRole("tab", { name: "Events (6)" })).toBeInTheDocument();
    expect(within(card).getByText("4 meetings")).toBeInTheDocument();
    expect(within(card).queryByText("Birthday")).toBeNull();
    expect(within(card).queryByText("Festival")).toBeNull();
    const meetingList = within(card).getByRole("region", { name: "Events for default@example.com" });
    expect(meetingList).not.toHaveAttribute("data-scrollable");
    expect(meetingList).not.toHaveAttribute("tabindex");
    expect(within(card).getByRole("region", { name: "Calendar events for default@example.com" })).toHaveAttribute("data-scrollable", "true");
    expect(within(meetingList).getAllByRole("listitem")).toHaveLength(4);
    expect(card.querySelector("[data-photo-url]")).toHaveAttribute("data-photo-url", husshPhoto);
    expect(card.querySelector("[data-photo-source]")).toHaveAttribute("data-photo-source", "hussh");
    expect(card.querySelector("[data-photo-url='https://lh3.googleusercontent.com/a/default=s96-c']")).toBeNull();
    expect(within(card).getByRole("link", { name: "Join meeting: Planning review" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "View 2 occasions for default@example.com" }));
    const occasions = screen.getByRole("dialog", { name: "Occasions" });
    expect(within(occasions).getByText("Birthday")).toBeInTheDocument();
    expect(within(occasions).getByText("Festival")).toBeInTheDocument();
    expect(occasions.querySelectorAll("[data-kind]")).toHaveLength(2);
    expect(within(occasions).queryByRole("link", { name: "Open in Google Calendar" })).toBeNull();
    expect(within(occasions).queryByText("More details")).toBeNull();
  });

  it("shows occasions the way Google Calendar does: day, note and calendar, without observance text or a provider link", async () => {
    const holiday = { ...event("default", "diwali", "Diwali/Deepavali", "2026-11-08T00:00:00Z", "2026-11-09T00:00:00Z"), start: { date: "2026-11-08" }, end: { date: "2026-11-09" }, source_calendar_id: "en.indian#holiday@group.v.calendar.google.com", calendar_name: "Holidays in India", description: "Public holiday" };
    const observance = { ...event("default", "naraka", "Naraka Chaturdasi", "2026-11-08T00:00:00Z", "2026-11-09T00:00:00Z"), start: { date: "2026-11-08" }, end: { date: "2026-11-09" }, source_calendar_id: "en.indian#holiday@group.v.calendar.google.com", calendar_name: "Holidays in India", description: "Observance\nTo hide observances, go to Google Calendar Settings > Holidays in India" };
    mocks.boardDay.mockResolvedValue({ ...board, accounts: [{ ...board.accounts[0], events: [holiday, observance] }], conflicts: [] });
    render(page({ ...status, accounts: status.accounts.slice(0, 1) }));
    fireEvent.click(await screen.findByRole("button", { name: "View 2 occasions for default@example.com" }));
    const dialog = screen.getByRole("dialog", { name: "Occasions" });
    expect(within(dialog).getAllByText("Sunday, November 8")).toHaveLength(2);
    expect(within(dialog).getByText("Public holiday")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Holidays in India")).toHaveLength(2);
    expect(within(dialog).queryByText(/observance/i)).toBeNull();
    expect(within(dialog).queryByText("More details")).toBeNull();
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("keeps initials when Google has not verified the account email", async () => {
    const husshPhoto = "data:image/png;base64,aGVsbG8=";
    const peer = new Map([["second@example.com", { userId: "peer", displayName: null, photoUrl: husshPhoto }]]);
    render(page(status, peer));
    const card = await screen.findByRole("group", { name: "Calendar account second@example.com" });
    expect(card.querySelector("[data-photo-url]")).toBeNull();
    expect(card.querySelector("[data-photo-source]")).toBeNull();
  });

  it("marks an elapsed event as ended and removes Join from its card and details", async () => {
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    mocks.boardDay.mockResolvedValue({ ...board, accounts: [{ ...board.accounts[0], events: [{ ...meetingA, conference_url: "https://meet.google.com/abc-defg-hij" }] }] });
    render(page({ ...status, accounts: status.accounts.slice(0, 1) }));
    const open = await screen.findByRole("button", { name: "Open Planning review in default@example.com" });
    const card = open.closest("li")!;
    expect(card).toHaveAttribute("data-ended", "true");
    expect(within(card).getByText("Ended")).toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: /Join meeting/ })).toBeNull();
    fireEvent.click(open);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Ended")).toBeInTheDocument();
    expect(within(dialog).queryByRole("link", { name: "Join meeting" })).toBeNull();
  });

  it("updates the open details when a meeting reaches its end without a board refresh", async () => {
    vi.setSystemTime(new Date("2026-10-21T10:59:00Z"));
    mocks.boardDay.mockResolvedValue({ ...board, accounts: [{ ...board.accounts[0], events: [{ ...meetingA, conference_url: "https://meet.google.com/abc-defg-hij" }] }] });
    const view = render(page({ ...status, accounts: status.accounts.slice(0, 1) }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Planning review in default@example.com" }));
    expect(within(screen.getByRole("dialog")).getByRole("link", { name: "Join meeting" })).toBeInTheDocument();
    vi.setSystemTime(new Date("2026-10-21T11:00:00Z"));
    view.rerender(page({ ...status, accounts: status.accounts.slice(0, 1) }));
    expect(within(screen.getByRole("dialog")).getByText("Ended")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).queryByRole("link", { name: "Join meeting" })).toBeNull();
    expect(mocks.boardDay).toHaveBeenCalledOnce();
  });

  it("shows a concise event detail with one account address and the existing response actions", async () => {
    mocks.boardDay.mockResolvedValue({ ...board, accounts: [{ ...board.accounts[0], events: [{
      ...meetingA,
      calendar_name: "default@example.com",
      conference_url: "https://meet.google.com/abc-defg-hij",
      html_link: "https://calendar.google.com/calendar/event?eid=meeting-one",
    }] }], conflicts: [] });
    render(page({ ...status, accounts: status.accounts.slice(0, 1) }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Planning review in default@example.com" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Planning review" })).toBeInTheDocument();
    expect(within(dialog).getAllByText(/default@example\.com/)).toHaveLength(1);
    expect(within(dialog).getByText("Organized by organizer-one@example.com")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Join meeting" })).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
    expect(within(dialog).queryByRole("link", { name: "Open in Google Calendar" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Decline", exact: true })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Decline & offer another time" })).toBeInTheDocument();
  });
});
