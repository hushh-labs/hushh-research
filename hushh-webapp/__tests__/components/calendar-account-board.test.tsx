import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  boardDay: vi.fn(), reviewWorkspaceConflict: vi.fn(), confirmWorkspaceConflict: vi.fn(),
  reviewWorkspaceAttendance: vi.fn(), confirmWorkspaceAttendance: vi.fn(),
  onChat: vi.fn(), onMailConnect: vi.fn(),
}));

vi.mock("@/lib/services/google-calendar-service", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/google-calendar-service")>(),
  GoogleCalendarService: {
    boardDay: mocks.boardDay,
    reviewWorkspaceConflict: mocks.reviewWorkspaceConflict,
    confirmWorkspaceConflict: mocks.confirmWorkspaceConflict,
    reviewWorkspaceAttendance: mocks.reviewWorkspaceAttendance,
    confirmWorkspaceAttendance: mocks.confirmWorkspaceAttendance,
  },
}));
vi.mock("@/lib/perf/use-periodic-task", () => ({ usePeriodicTask: vi.fn(), useCoarseClock: () => Date.now() }));

import { CalendarAccountBoard } from "@/components/calendar/calendar-account-board";
import type { CalendarBoardDay, GoogleCalendarStatus } from "@/lib/services/google-calendar-service";

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
  accounts: board.accounts.map(account => ({ account_id: account.account_id, google_email: account.google_email, status: "connected" as const, connected: true, access_level: "manage" as const, calendar_list_access: true })),
} satisfies GoogleCalendarStatus;

function page(currentStatus: GoogleCalendarStatus = status) {
  return <CalendarAccountBoard userId="owner" status={currentStatus} busy={false} token="owner-token"
    getIdToken={async () => "firebase-token"} onAddAccount={vi.fn()} onReconnectAccount={vi.fn()}
    onDisconnectAccount={vi.fn()} onConnect={vi.fn()} onMailConnect={mocks.onMailConnect}
    onChat={mocks.onChat} />;
}

describe("three-account Calendar board", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T08:00:00Z`));
    vi.clearAllMocks();
    mocks.boardDay.mockResolvedValue(board);
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

  it("hands a single-account opening to One with its exact bounds", async () => {
    mocks.boardDay.mockResolvedValue({ ...board, accounts: [board.accounts[0]], conflicts: [] });
    render(page({ ...status, accounts: status.accounts.slice(0, 1) }));
    fireEvent.click(await screen.findByRole("button", { name: /Use shared free time/ }));
    expect(mocks.onChat).toHaveBeenCalledWith(undefined, {
      ownerId: "owner",
      accountEmail: "default@example.com",
      date,
      windowStart: "2026-10-21T12:00:00Z",
      windowEnd: "2026-10-21T13:00:00Z",
      durationMinutes: 15,
      timeZone: expect.any(String),
    });
  });

  it("does not turn a multi-account opening into a default-only booking handoff", async () => {
    render(page());
    await screen.findByText("Planning review");
    expect(screen.queryByRole("button", { name: /Use shared free time/ })).toBeNull();
    expect(screen.getByText(/Refresh before scheduling because availability can change/)).toBeTruthy();
    expect(mocks.onChat).not.toHaveBeenCalled();
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
    const photo = "https://lh3.googleusercontent.com/a/default=s96-c";
    const currentStatus = { ...status, accounts: [{ ...status.accounts[0], profile_photo_url: photo }] };
    render(page(currentStatus));

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
    expect(card.querySelector("[data-photo-url]")).toHaveAttribute("data-photo-url", photo);
    expect(within(card).getByRole("link", { name: "Join meeting: Planning review" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "View 2 occasions for default@example.com" }));
    const occasions = screen.getByRole("dialog", { name: "Occasions" });
    expect(within(occasions).getByText("Birthday")).toBeInTheDocument();
    expect(within(occasions).getByText("Festival")).toBeInTheDocument();
    expect(occasions.querySelectorAll("[data-kind]")).toHaveLength(2);
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
