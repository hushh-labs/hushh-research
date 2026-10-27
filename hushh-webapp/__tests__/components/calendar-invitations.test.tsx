import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const mutations = () => mock.apiFetch.mock.calls.filter(([path]) => String(path).includes("/attendance/") && String(path).endsWith("/confirm"));
const preparations = () => mock.apiFetch.mock.calls.filter(([path]) => String(path).includes("/attendance/") && String(path).endsWith("/review"));

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-10-14T09:00:00Z"));
  CacheService.getInstance().clear();
  vi.clearAllMocks(); mock.token = "synthetic-owner";
  invitations = [structuredClone(pending), { ...structuredClone(pending), id: "declined", title: "Declined Review", response_status: "declined" }];
  outcome = { calendar: "accepted", email: "not_sent", calendar_error: null, email_error: null };
  mock.apiFetch.mockImplementation(async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/invitations")) return response({ events: invitations, pending_count: invitations.filter(e => e.response_status === "needsAction").length, unreadable_calendars: [], start_at: "2030-10-14T00:00:00Z", end_at: "2031-01-12T00:00:00Z", time_zone: "UTC", complete: true });
    if (path.includes("/attendance/") && path.endsWith("/review")) return response({ review_id: "review-id", review_token: "memory-only-review", title: pending.title, start: pending.start, end: pending.end, response_status: body.response_status, conflicts: body.response_status === "accepted" ? [{ title: "Existing meeting", start: pending.start, end: pending.end }] : [], recipient: body.offer_times || body.send_message ? "priya@example.test" : null, subject: body.offer_times ? "Another time for Client Sync" : body.send_message ? "Unable to attend: Client Sync" : null, message: body.offer_times ? `${body.message}\n\nhttps://one.example.test/calendar/reschedule#encrypted-capability` : body.send_message ? body.message : null, openings: body.offer_times ? [{ start_at: "2030-10-15T10:00:00Z", end_at: "2030-10-15T10:45:00Z" }] : [], expires_at: "2030-10-14T09:00:00Z" });
    if (path.includes("/attendance/") && path.endsWith("/confirm")) {
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

  it("lists guests in readable response order without duplicating the organizer", async () => {
    invitations[0]!.attendees = [
      { email: "owner@example.test", self: true, response_status: "needsAction" },
      { email: "long-name-for-a-guest@example.test", response_status: "needsAction" },
      { email: "priya@example.test", display_name: "Organizer", response_status: "accepted" },
      { email: "manish@example.test", display_name: "Manish", response_status: "accepted" },
    ];
    render(view({ workspaceLayout: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    const guests = within(screen.getByRole("list", { name: "Guests" })).getAllByRole("listitem");
    expect(guests).toHaveLength(4);
    expect(guests[0]).toHaveTextContent("Priya Mehta");
    expect(guests[0]).toHaveTextContent("Organiser · Accepted");
    expect(guests[0].querySelector("[data-accepted-indicator]")).toBeInTheDocument();
    expect(guests[0].querySelector("[data-guest-avatar] > [data-accepted-indicator]")).toBeInTheDocument();
    expect(guests[1]).toHaveTextContent("Manish");
    expect(guests[1].querySelector("[data-accepted-indicator]")).toBeInTheDocument();
    expect(guests[1].querySelector("[data-guest-avatar] > [data-accepted-indicator]")).toBeInTheDocument();
    expect(guests[2]).toHaveTextContent("Awaiting reply");
    expect(guests[2].querySelector("[data-accepted-indicator]")).not.toBeInTheDocument();
    expect(screen.getByText("2 yes, 2 awaiting")).toBeInTheDocument();
  });

  it("does not invent an organizer response when the organizer is absent from attendees", async () => {
    invitations[0]!.attendees = [
      { email: "owner@example.test", self: true, response_status: "needsAction" },
      { email: "manish@example.test", display_name: "Manish", response_status: "accepted" },
    ];
    render(view({ workspaceLayout: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    const guests = within(screen.getByRole("list", { name: "Guests" })).getAllByRole("listitem");
    expect(guests).toHaveLength(3);
    expect(guests[0]).toHaveTextContent("Priya Mehta");
    expect(guests[0]).toHaveTextContent("Organiser · Response unavailable");
    expect(guests[0].querySelector("[data-accepted-indicator]")).not.toBeInTheDocument();
    expect(screen.getByText("1 yes, 1 awaiting, 1 unknown")).toBeInTheDocument();
  });

  it("keeps a named organizer visible when Google omits the organizer email", async () => {
    invitations[0]!.organizer = { displayName: "Priya Mehta" };
    invitations[0]!.attendees = [{ email: "owner@example.test", self: true, response_status: "needsAction" }];
    render(view({ workspaceLayout: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    const guests = within(screen.getByRole("list", { name: "Guests" })).getAllByRole("listitem");
    expect(guests).toHaveLength(2);
    expect(guests[0]).toHaveTextContent("Priya Mehta");
    expect(guests[0]).toHaveTextContent("Organiser · Response unavailable");
  });

  it("keeps the existing chat presentation for invitations", async () => {
    render(view());
    fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    expect(screen.getByText("Organiser")).toBeInTheDocument();
    expect(screen.getByText("Attendees (2)")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Guests" })).not.toBeInTheDocument();
  });

  it("reviews exact selected calendar, warns of overlap, and confirms once without a second OAuth", async () => {
    render(view());
    fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    expect(screen.getByRole("link", { name: "Join meeting" })).toHaveAttribute("href", pending.conference_url);
    fireEvent.click(screen.getByRole("button", { name: "Accept", exact: true }));
    expect(await screen.findByText("This time is already booked")).toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
    const body = JSON.parse(preparations()[0]?.[1].body);
    expect(body).toMatchObject({ event_id: pending.id, calendar_id: pending.calendar_id, response_status: "accepted", offer_times: false, duration_minutes: 45, send_message: false });
    expect(preparations()[0]?.[0]).toBe("/api/one/calendar/attendance/review");
    const button = screen.getByRole("button", { name: "Accept anyway" });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mutations()).toHaveLength(1); expect(onResult).toHaveBeenCalledOnce(); expect(onConnect).not.toHaveBeenCalled();
    expect(JSON.parse(mutations()[0]?.[1].body)).toEqual({ review_id: "review-id", review_token: "memory-only-review" });
    expect(mutations()[0]?.[0]).toBe("/api/one/calendar/attendance/confirm");
  });

  it("lets a locked workspace owner accept without a vault capability or Mail authority", async () => {
    mock.token = null;
    render(view({ workspaceLayout: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    expect(screen.queryByText(/Unlock your vault to respond/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept anyway" }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(preparations()[0]?.[0]).toBe("/api/one/calendar/attendance/rsvp/review");
    expect(mutations()[0]?.[0]).toBe("/api/one/calendar/attendance/rsvp/confirm");
    for (const [, request] of [...preparations(), ...mutations()]) {
      expect(request.headers.Authorization).toBe("Bearer synthetic-firebase");
      expect(request.headers).not.toHaveProperty("X-Hushh-Consent");
    }
  });

  it("lets a locked workspace owner review a Calendar-only decline", async () => {
    mock.token = null;
    outcome.calendar = "declined";
    render(view({ workspaceLayout: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Review decline" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm decline" }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(preparations()[0]?.[0]).toBe("/api/one/calendar/attendance/rsvp/review");
    expect(JSON.parse(preparations()[0]?.[1].body)).toMatchObject({ response_status: "declined" });
    expect(JSON.parse(preparations()[0]?.[1].body)).not.toHaveProperty("message");
    expect(mutations()[0]?.[1].headers).not.toHaveProperty("X-Hushh-Consent");
  });

  it("offers a reviewed alternative from the workspace without vault unlock", async () => {
    mock.token = null;
    outcome = { calendar: "declined", email: "sent", calendar_error: null, email_error: null };
    render(view({ workspaceLayout: true, initialFilter: "all", initialEventId: pending.id, initialCalendarId: pending.calendar_id, initialDecision: "offer_times" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message to organiser" }), { target: { value: "Could we meet tomorrow?" } });
    fireEvent.click(screen.getByRole("button", { name: "Check time & send email" }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(preparations()[0]?.[0]).toBe("/api/one/calendar/attendance/workspace/review");
    expect(mutations()[0]?.[0]).toBe("/api/one/calendar/attendance/workspace/confirm");
    for (const [, request] of [...preparations(), ...mutations()]) {
      expect(request.headers).not.toHaveProperty("X-Hushh-Consent");
    }
  });

  it("declines only after confirmation and moves the response to Responded", async () => {
    outcome.calendar = "declined";
    render(view()); fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline", exact: true }));
    expect(mutations()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Review decline email" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for declining" }), { target: { value: "Family commitment." } });
    fireEvent.click(screen.getByRole("button", { name: "Review decline email" }));
    await screen.findByText("Decline invitation?");
    expect(mutations()).toHaveLength(0);
    expect(JSON.parse(preparations()[0][1].body).message).toContain("Family commitment.");
    expect(screen.getByText(/I’m sorry, but I can’t attend/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Decline & send email" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("tab", { name: "Pending (0)" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Responded" }));
    expect(screen.getByRole("button", { name: "Open invitation: Client Sync" })).toBeInTheDocument();
  });

  it("does not send an email composed for an invitation that changed before review", async () => {
    const original = mock.apiFetch.getMockImplementation()!;
    mock.apiFetch.mockImplementation(async (path: string, init: RequestInit) => {
      const result = await original(path, init);
      return path.endsWith("/attendance/review")
        ? response({ ...await result.json(), start: { dateTime: "2030-10-14T11:00:00Z" } })
        : result;
    });
    render(view());
    fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline", exact: true }));
    fireEvent.change(screen.getByLabelText("Reason for declining"), { target: { value: "I am unavailable." } });
    fireEvent.click(screen.getByRole("button", { name: "Review decline email" }));
    expect(await screen.findByText(/This invitation changed while the email was prepared/)).toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
  });

  it("offers editable real-time alternatives and preserves separate Mail failure outcome", async () => {
    outcome = { calendar: "declined", email: "failed", calendar_error: null, email_error: null };
    render(view({ initialFilter: "all", initialEventId: pending.id, initialCalendarId: pending.calendar_id, initialDecision: "offer_times" }));
    await screen.findByRole("textbox", { name: "Message to organiser" });
    fireEvent.change(screen.getByRole("textbox", { name: "Message to organiser" }), { target: { value: "Can we meet tomorrow?" } });
    expect(screen.queryByLabelText("Alternative duration in minutes")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Alternative start time"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("Alternative end time"), { target: { value: "11:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Check time & send email" }));
    expect(await screen.findByText(/Your attendance was declined.*email was not sent/)).toBeInTheDocument();
    expect(preparations()).toHaveLength(1); expect(mutations()).toHaveLength(1);
    expect(JSON.parse(preparations()[0][1].body)).toMatchObject({ duration_minutes: 60, exact_time: true, send_message: true });
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


it("hands an authorized settlement to chat once and survives page unmount", async () => {
  let settle!: (value: Response) => void;
  const original = mock.apiFetch.getMockImplementation()!;
  mock.apiFetch.mockImplementation((path: string, init: RequestInit) => path.endsWith("/attendance/confirm") ? new Promise<Response>(resolve => { settle = resolve; }) : original(path, init));
  const onSend = vi.fn();
  const mounted = render(view({ onSend }));
  fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
  fireEvent.click(screen.getByRole("button", { name: "Decline", exact: true }));
  fireEvent.change(screen.getByLabelText("Reason for declining"), { target: { value: "Unavailable." } });
  const submit = screen.getByRole("button", { name: "Decline & send email" });
  fireEvent.click(submit); fireEvent.click(submit);
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  const handoff = onSend.mock.calls[0][0];
  expect(handoff.review_token).toBeUndefined();
  mounted.unmount();
  settle(response({ calendar: "declined", email: "sent", calendar_error: null, email_error: null }));
  await expect(handoff.outcome).resolves.toMatchObject({ result: { email: "sent" } });
  expect(mutations()).toHaveLength(1);
});

it("requires conflict acknowledgement before sending a proposed busy time", async () => {
  const original = mock.apiFetch.getMockImplementation()!;
  mock.apiFetch.mockImplementation(async (path: string, init: RequestInit) => {
    const result = await original(path, init);
    if (!path.endsWith("/attendance/review")) return result;
    const body = await result.json();
    return response({ ...body, conflicts: [{ title: "Already booked", start: pending.start, end: pending.end }] });
  });
  render(view({ initialFilter: "all", initialEventId: pending.id, initialCalendarId: pending.calendar_id, initialDecision: "offer_times", initialTerms: { message: "Please move this." } }));
  fireEvent.click(await screen.findByRole("button", { name: "Check time & send email" }));
  await screen.findByText("This time is already booked");
  expect(mutations()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Change time" }));
  expect(screen.getByLabelText("Message to organiser")).toHaveValue("Please move this.");
  fireEvent.click(screen.getByRole("button", { name: "Check time & send email" }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue & send email" }));
  await waitFor(() => expect(mutations()).toHaveLength(1));
});

it("discards an expired token, preserves the reason and requires fresh review", async () => {
  const original = mock.apiFetch.getMockImplementation()!;
  mock.apiFetch.mockImplementation(async (path: string, init: RequestInit) => path.endsWith("/attendance/confirm") ? response({ detail: { message: "Review expired. Check Calendar before retrying.", reason_code: "calendar_review_expired" } }, 410) : original(path, init));
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
  fireEvent.click(screen.getByRole("button", { name: "Decline", exact: true }));
  fireEvent.change(screen.getByLabelText("Reason for declining"), { target: { value: "Unavailable." } });
  fireEvent.click(screen.getByRole("button", { name: "Review decline email" }));
  fireEvent.click(await screen.findByRole("button", { name: "Decline & send email" }));
  await screen.findByRole("button", { name: "Review email again" });
  expect(screen.getByLabelText("Reason for declining")).toHaveValue("Unavailable.");
  fireEvent.click(screen.getByRole("button", { name: "Review email again" }));
  await screen.findByText("Decline invitation?");
  expect(mutations()).toHaveLength(1);
});


it("rejects a decline email if the organizer changed since the form opened", async () => {
  const original = mock.apiFetch.getMockImplementation()!;
  mock.apiFetch.mockImplementation(async (path: string, init: RequestInit) => {
    const result = await original(path, init);
    return path.endsWith("/attendance/review") ? response({ ...await result.json(), recipient: "changed@example.test" }) : result;
  });
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Open invitation: Client Sync" }));
  fireEvent.click(screen.getByRole("button", { name: "Decline", exact: true }));
  fireEvent.change(screen.getByLabelText("Reason for declining"), { target: { value: "Unavailable." } });
  fireEvent.click(screen.getByRole("button", { name: "Review decline email" }));
  await screen.findByText(/This invitation changed while the email was prepared/);
  expect(mutations()).toHaveLength(0);
});
