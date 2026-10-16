import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ apiFetch: vi.fn(), token: "synthetic-owner" as string | null }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mock.apiFetch } }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: mock.token }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
import { CalendarInvitations } from "@/components/calendar/calendar-invitations";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { CacheService } from "@/lib/services/cache-service";
import { notifyCalendarChanged } from "@/lib/calendar/calendar-refresh";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import type { CalendarInvitation } from "@/lib/services/google-calendar-service";

const pending: CalendarInvitation = { id: "client-instance", calendar_id: "work@example.test", title: "Client Sync", start: { dateTime: "2030-10-14T10:00:00Z" }, end: { dateTime: "2030-10-14T10:45:00Z" }, response_status: "needsAction", can_respond: true, conflicts: [], organizer: { displayName: "Priya Mehta", email: "priya@example.test" }, description: "<p>Review the roadmap</p>", attendees: [{ email: "owner@example.test", self: true, response_status: "needsAction" }, { email: "priya@example.test", display_name: "Priya", response_status: "accepted" }], conference_url: "https://meet.google.com/abc-defg-hij", conference_name: "Google Meet" };
let invitations: CalendarInvitation[];
let outcome = { calendar: "accepted", email: "not_sent", calendar_error: null, email_error: null };
const onConnect = vi.fn(), onMailConnect = vi.fn(), onResult = vi.fn();
function view(extra: object = {}) { return <CalendarInvitations userId="owner" accountEmail="owner@example.test" zone="UTC" getIdToken={async () => "synthetic-firebase"} onConnect={onConnect} onMailConnect={onMailConnect} onResult={onResult} {...extra} />; }
function response(body: object, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
const mutations = () => mock.apiFetch.mock.calls.filter(([path]) => String(path).endsWith("/attendance/confirm"));
const preparations = () => mock.apiFetch.mock.calls.filter(([path]) => String(path).endsWith("/attendance/review"));

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-10-14T09:00:00Z"));
  CacheService.getInstance().clear();
  vi.clearAllMocks(); mock.token = "synthetic-owner";
  invitations = [structuredClone(pending), { ...structuredClone(pending), id: "declined", title: "Declined Review", response_status: "declined" }];
  outcome = { calendar: "accepted", email: "not_sent", calendar_error: null, email_error: null };
  mock.apiFetch.mockImplementation(async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/invitations")) return response({ events: invitations, pending_count: invitations.filter(e => e.response_status === "needsAction").length, unreadable_calendars: [], start_at: "2030-10-14T00:00:00Z", end_at: "2031-01-12T00:00:00Z", time_zone: "UTC", complete: true });
    if (path.endsWith("/attendance/review")) return response({ review_id: "review-id", review_token: "memory-only-review", title: pending.title, response_status: body.response_status, conflicts: body.response_status === "accepted" ? [{ title: "Existing meeting", start: pending.start, end: pending.end }] : [], recipient: body.offer_times ? "priya@example.test" : null, subject: body.offer_times ? "Another time for Client Sync" : null, message: body.offer_times ? `${body.message}\n\nhttps://one.example.test/calendar/reschedule#encrypted-capability` : null, openings: body.offer_times ? [{ start_at: "2030-10-15T10:00:00Z", end_at: "2030-10-15T10:45:00Z" }] : [], expires_at: "2030-10-14T09:00:00Z" });
    if (path.endsWith("/attendance/confirm")) {
      invitations[0] = { ...invitations[0]!, response_status: outcome.calendar as "accepted" | "declined" };
      return response(outcome);
    }
    throw new Error(`Unexpected request ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("shared page/chat Invitations with real typed transport", () => {
  it("loads owner-bound upcoming invitations and filters pending/responded/all", async () => {
    render(view());
    expect(await screen.findByRole("button", { name: "Open invitation: Client Sync" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Pending (1)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "Open invitation: Declined Review" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Responded" }));
    expect(screen.getByRole("button", { name: "Open invitation: Declined Review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open invitation: Client Sync" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "All", exact: true }));
    expect(screen.getByRole("button", { name: "Open invitation: Client Sync" })).toBeInTheDocument();
    expect(mock.apiFetch.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer synthetic-firebase");
    expect(mutations()).toHaveLength(0); expect(onConnect).not.toHaveBeenCalled();
  });

  it("reviews exact selected calendar, warns of overlap, and confirms once without a second OAuth", async () => {
    render(view());
    fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    expect(screen.getByRole("link", { name: "Join meeting" })).toHaveAttribute("href", pending.conference_url);
    fireEvent.click(screen.getByRole("button", { name: "Accept", exact: true }));
    expect(await screen.findByText("This overlaps another meeting")).toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
    const body = JSON.parse(preparations()[0]?.[1].body);
    expect(body).toMatchObject({ event_id: pending.id, calendar_id: pending.calendar_id, response_status: "accepted", offer_times: false, duration_minutes: 45 });
    const button = screen.getByRole("button", { name: "Accept anyway" });
    fireEvent.click(button); fireEvent.click(button);
    expect(await screen.findByText("Your invitation was accepted.")).toBeInTheDocument();
    expect(mutations()).toHaveLength(1); expect(onResult).toHaveBeenCalledOnce(); expect(onConnect).not.toHaveBeenCalled();
    expect(JSON.parse(mutations()[0]?.[1].body)).toEqual({ review_id: "review-id", review_token: "memory-only-review" });
  });

  it("declines only after confirmation and moves the response to Responded", async () => {
    outcome.calendar = "declined";
    render(view()); fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm decline" }));
    expect(await screen.findByText("Your attendance was declined.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Invitations", exact: true }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Pending (0)" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Responded" }));
    expect(screen.getByRole("button", { name: "Open invitation: Client Sync" })).toBeInTheDocument();
  });

  it("offers editable real-time alternatives and preserves separate Mail failure outcome", async () => {
    outcome = { calendar: "declined", email: "failed", calendar_error: null, email_error: null };
    render(view({ initialFilter: "all", initialEventId: pending.id, initialCalendarId: pending.calendar_id, initialDecision: "offer_times" }));
    await screen.findByRole("textbox", { name: "Message to organiser" });
    fireEvent.change(screen.getByRole("textbox", { name: "Message to organiser" }), { target: { value: "Can we meet tomorrow?" } });
    fireEvent.click(screen.getByRole("button", { name: "Check times & review message" }));
    await screen.findByRole("button", { name: "Confirm decline & send email" });
    expect(screen.getByText(/Can we meet tomorrow\?/)).toBeInTheDocument();
    expect(screen.getByText(/encrypted-capability/)).toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    expect(screen.getByRole("textbox", { name: "Message to organiser" })).toHaveValue("Can we meet tomorrow?");
    fireEvent.click(screen.getByRole("button", { name: "Check times & review message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm decline & send email" }));
    expect(await screen.findByText(/Your attendance was declined.*email was not sent/)).toBeInTheDocument();
    expect(preparations()).toHaveLength(2); expect(mutations()).toHaveLength(1);
  });

  it("uses page-to-chat context without performing an attendance write", async () => {
    const onOfferTimes = vi.fn();
    render(view({ onOfferTimes })); fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline & offer another time" }));
    expect(onOfferTimes).toHaveBeenCalledWith({ ownerId: "owner", accountEmail: "owner@example.test", calendarId: pending.calendar_id, eventId: pending.id });
    expect(preparations()).toHaveLength(0); expect(mutations()).toHaveLength(0);
    act(() => { expect(unwindBackLayer("/")).toBe(true); });
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("does not show old details or a pending review after account/epoch changes", async () => {
    const rendered = render(view()); fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept", exact: true })); await screen.findByText("Accept invitation?");
    act(() => { advanceVaultSessionEpoch(); mock.token = null; });
    rendered.rerender(view({ accountEmail: "replacement@example.test" }));
    expect(screen.queryByText("Accept invitation?")).not.toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
  });
});

it("replaces the selected chat review when a later request chooses another invitation or terms", async () => {
  const mounted = render(view({ initialFilter: "all", initialCalendarId: pending.calendar_id, initialEventId: pending.id }));
  await screen.findByRole("article", { name: "Invitation details: Client Sync" });
  mounted.rerender(view({ initialFilter: "all", initialCalendarId: pending.calendar_id, initialEventId: "declined", initialDecision: "offer_times", initialTerms: { date: "2030-10-18", startTime: "15:00", endTime: "18:00", message: "Friday afternoon, please." } }));
  await screen.findByRole("article", { name: "Invitation details: Declined Review" });
  expect(screen.getByLabelText("Alternative date")).toHaveValue("2030-10-18");
  expect(screen.getByLabelText("Alternative start time")).toHaveValue("15:00");
  expect(screen.getByRole("textbox", { name: "Message to organiser" })).toHaveValue("Friday afternoon, please.");
  expect(mutations()).toHaveLength(0);
});


it("reuses a warm invitation snapshot immediately on tab remount", async () => {
  const getIdToken = vi.fn(async () => "synthetic-firebase");
  const first = render(view({ workspaceLayout: true, getIdToken }));
  await screen.findByRole("button", { name: "Open invitation: Client Sync" });
  first.unmount();
  render(view({ workspaceLayout: true, getIdToken }));
  expect(screen.getByRole("button", { name: "Open invitation: Client Sync" })).toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "Invitations loading" })).not.toBeInTheDocument();
  expect(getIdToken).toHaveBeenCalledTimes(1);
  expect(mock.apiFetch).toHaveBeenCalledTimes(1);
});

it("invalidates snapshots for changes made while the tab is unmounted", async () => {
  const first = render(view({ workspaceLayout: true }));
  await screen.findByRole("button", { name: "Open invitation: Client Sync" });
  first.unmount();
  invitations[0]!.response_status = "accepted";
  act(() => notifyCalendarChanged("owner"));
  render(view({ workspaceLayout: true, initialFilter: "responded" }));
  await screen.findByRole("button", { name: "Open invitation: Client Sync" });
  expect(mock.apiFetch).toHaveBeenCalledTimes(2);
});

it("filters each selected local date, including an empty date, without a placeholder", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-10-14T09:00:00Z"));
  invitations.push({ ...structuredClone(pending), id: "tomorrow", title: "Tomorrow Sync", start: { dateTime: "2030-10-15T10:00:00Z" }, end: { dateTime: "2030-10-15T10:45:00Z" } });
  render(view({ workspaceLayout: true }));
  await screen.findByRole("button", { name: "Open invitation: Client Sync" });
  expect(screen.queryByText("Select an invitation to see its details.")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open invitation: Tomorrow Sync" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  await screen.findByRole("button", { name: "Open invitation: Tomorrow Sync" });
  expect(screen.queryByRole("button", { name: "Open invitation: Client Sync" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  await screen.findByText("No pending invitations on this date.");
  expect(screen.getByRole("button", { name: "Previous day" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
  expect(screen.getByRole("button", { name: "Open invitation: Tomorrow Sync" })).toBeInTheDocument();
  vi.restoreAllMocks();
});

it("isolates cached invitations by owner, account and session", async () => {
  const first = render(view({ workspaceLayout: true }));
  await screen.findByRole("button", { name: "Open invitation: Client Sync" });
  first.unmount();
  mock.apiFetch.mockImplementation(() => new Promise(() => {}));
  const other = render(view({ workspaceLayout: true, userId: "another-owner", accountEmail: "another@example.test" }));
  expect(screen.queryByRole("button", { name: "Open invitation: Client Sync" })).not.toBeInTheDocument();
  other.unmount();
  act(() => advanceVaultSessionEpoch());
  render(view({ workspaceLayout: true }));
  expect(screen.queryByRole("button", { name: "Open invitation: Client Sync" })).not.toBeInTheDocument();
});

it("retains expired rows while refreshing and uses the selected time zone", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-10-14T09:00:00Z"));
  invitations = [{ ...structuredClone(pending), start: { dateTime: "2030-10-13T23:30:00Z" } }];
  const first = render(view({ workspaceLayout: true, zone: "Asia/Kolkata" }));
  await screen.findByRole("button", { name: "Open invitation: Client Sync" });
  first.unmount();
  now.mockReturnValue(Date.parse("2030-10-14T09:02:00Z"));
  mock.apiFetch.mockImplementation(() => new Promise(() => {}));
  render(view({ workspaceLayout: true, zone: "Asia/Kolkata" }));
  expect(screen.getByRole("button", { name: "Open invitation: Client Sync" })).toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "Invitations loading" })).not.toBeInTheDocument();
  await waitFor(() => expect(mock.apiFetch).toHaveBeenCalledTimes(2));
  vi.restoreAllMocks();
});


it("includes multi-day invitations on overlapping dates and excludes their end date", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-10-14T09:00:00Z"));
  invitations = [{ ...structuredClone(pending), start: { date: "2030-10-13" }, end: { date: "2030-10-15" } }];
  render(view({ workspaceLayout: true }));
  await screen.findByRole("button", { name: "Open invitation: Client Sync" });
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  await screen.findByText("No pending invitations on this date.");
  vi.restoreAllMocks();
});


it("keeps explicit chat invitation requests live instead of using tab snapshots", async () => {
  const first = render(view());
  await screen.findByRole("button", { name: "Open invitation: Client Sync" });
  first.unmount();
  render(view());
  await screen.findByRole("button", { name: "Open invitation: Client Sync" });
  expect(mock.apiFetch).toHaveBeenCalledTimes(2);
});
