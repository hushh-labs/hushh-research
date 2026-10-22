import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  boardDay: vi.fn(), reviewConflict: vi.fn(), confirmConflict: vi.fn(),
  reviewAttendance: vi.fn(), confirmAttendance: vi.fn(),
  onChat: vi.fn(), onMailConnect: vi.fn(),
}));

vi.mock("@/lib/services/google-calendar-service", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/google-calendar-service")>(),
  GoogleCalendarService: {
    boardDay: mocks.boardDay,
    reviewConflict: mocks.reviewConflict,
    confirmConflict: mocks.confirmConflict,
    reviewAttendance: mocks.reviewAttendance,
    confirmAttendance: mocks.confirmAttendance,
  },
}));
vi.mock("@/lib/perf/use-periodic-task", () => ({ usePeriodicTask: vi.fn() }));

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
    mocks.reviewConflict.mockImplementation(async ({ decline }: { decline: { message: string }[] }) => ({ review_id: "review-conflict", review_token: "sealed-review", expires_at: "2999-01-01T00:00:00Z", previews: [
      { kind: "keep", ref: board.conflicts[0].right, title: meetingB.title, account_email: "second@example.com", start: meetingB.start, end: meetingB.end, action: "accept" },
      { kind: "decline", ref: board.conflicts[0].left, title: meetingA.title, account_email: "default@example.com", start: meetingA.start, end: meetingA.end, action: "decline and send note", sender_label: "Owner <mail@example.com>", recipient: "organizer-one@example.com", subject: "Unable to attend", message: decline[0].message },
    ] }));
    mocks.confirmConflict.mockResolvedValue({ complete: true, results: [
      { kind: "keep", ref: board.conflicts[0].right, calendar: "accepted", email: "not_sent" },
      { kind: "decline", ref: board.conflicts[0].left, calendar: "declined", email: "sent" },
    ] });
    mocks.reviewAttendance.mockImplementation(async ({ message }: { message: string }) => ({ review_id: "retry-review", review_token: "sealed-retry", expires_at: "2999-01-01T00:00:00Z", title: meetingA.title, start: meetingA.start, end: meetingA.end, recipient: "organizer-one@example.com", sender_label: "Owner <mail@example.com>", subject: "Unable to attend", message }));
    mocks.confirmAttendance.mockResolvedValue({ calendar: "declined", email: "sent", calendar_error: null, email_error: null });
  });

  it("shows all three accounts, shared free time, and resolves a cross-account overlap inline", async () => {
    render(page());
    await screen.findByText("Planning review");
    expect(screen.getByText("Client call")).toBeTruthy();
    expect(screen.getByText("third@example.com")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Free across all accounts" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Review 1 overlapping meeting for Planning review/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Resolve these overlaps" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep this instead" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Client call")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.change(within(dialog).getByPlaceholderText("Explain why you cannot attend"), { target: { value: "I need to join the client call." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review Calendar and Mail" }));
    await waitFor(() => expect(mocks.reviewConflict).toHaveBeenCalledOnce());
    expect(mocks.reviewConflict.mock.calls[0][0].decline[0].message).toContain("I need to join the client call.");
    expect(mocks.reviewConflict.mock.calls[0][0].decline[0].message).toContain("Planning review");
    expect(mocks.confirmConflict).not.toHaveBeenCalled();
    expect(within(dialog).getByText("To: organizer-one@example.com")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm selected changes" }));
    await waitFor(() => expect(mocks.confirmConflict).toHaveBeenCalledOnce());
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
    mocks.confirmConflict.mockResolvedValue({ complete: false, results: [
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
    await waitFor(() => expect(mocks.reviewAttendance).toHaveBeenCalledWith(expect.objectContaining({ mailOnlyRetry: true, sendMessage: true, accountId: "default" })));
    expect(mocks.reviewAttendance.mock.calls[0][0].message).toBe(mocks.reviewConflict.mock.calls[0][0].decline[0].message);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Send reviewed note" }));
    await waitFor(() => expect(mocks.confirmAttendance).toHaveBeenCalledOnce());
    expect(within(dialog).queryByRole("button", { name: /Review email retry/ })).toBeNull();
    expect(within(dialog).getByText(/Email retry: sent/)).toBeTruthy();
  });

  it("refuses to retry an old note if the invitation changed after the first review", async () => {
    mocks.confirmConflict.mockResolvedValue({ complete: false, results: [
      { kind: "keep", ref: board.conflicts[0].right, calendar: "accepted", email: "not_sent" },
      { kind: "decline", ref: board.conflicts[0].left, calendar: "declined", email: "failed" },
    ] });
    mocks.reviewAttendance.mockImplementationOnce(async ({ message }: { message: string }) => ({ review_id: "retry-review", review_token: "sealed-retry", expires_at: "2999-01-01T00:00:00Z", title: meetingA.title, start: { dateTime: "2026-10-21T12:00:00Z" }, end: meetingA.end, recipient: "organizer-one@example.com", sender_label: "Owner <mail@example.com>", subject: "Unable to attend", message }));
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
    expect(mocks.confirmAttendance).not.toHaveBeenCalled();
  });

  it("keeps an uncertain email retry bound to its original review", async () => {
    mocks.confirmConflict.mockResolvedValue({ complete: false, results: [
      { kind: "keep", ref: board.conflicts[0].right, calendar: "accepted", email: "not_sent" },
      { kind: "decline", ref: board.conflicts[0].left, calendar: "declined", email: "failed" },
    ] });
    mocks.confirmAttendance.mockRejectedValueOnce(new Error("Network response was lost"));
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
    await waitFor(() => expect(mocks.confirmAttendance).toHaveBeenCalledTimes(2));
    expect(mocks.reviewAttendance).toHaveBeenCalledOnce();
    expect(mocks.confirmAttendance.mock.calls[1][0].reviewId).toBe(mocks.confirmAttendance.mock.calls[0][0].reviewId);
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
    mocks.boardDay.mockResolvedValue({ ...board, accounts: [{ ...board.accounts[0], events: [{ ...meetingA, conference_url: "https://meet.google.com/abc-defg-hij" }] }] });
    render(page());
    const join = await screen.findByRole("link", { name: "Join meeting: Planning review" });
    expect(join).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
    expect(join.closest("button")).toBeNull();
    expect(screen.getByText("Google Meet")).toBeInTheDocument();
  });
});
