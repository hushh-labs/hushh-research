import { notifyCalendarChanged } from "@/lib/calendar/calendar-refresh";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";

const mocks = vi.hoisted(() => ({
  insights: vi.fn(),
  invitations: vi.fn().mockResolvedValue({ events: [], pending_count: 0, unreadable_calendars: [], start_at: "2026-10-14T00:00:00Z", end_at: "2027-01-12T00:00:00Z", time_zone: "Asia/Kolkata", complete: true }),
  today: vi.fn(),
  availability: vi.fn(),
  reviewAttendance: vi.fn(),
  confirmAttendance: vi.fn(),
  onConnect: vi.fn(),
  onChat: vi.fn(),
  onDisconnect: vi.fn(),
  retryOwnerTokenRenewal: vi.fn(),
  ownerTokenStatus: "valid" as "locked" | "valid" | "renewing" | "unavailable",
  getIdToken: vi.fn(),
  vaultOwnerToken: "owner-token" as string | null,
  router: { push: vi.fn(), replace: vi.fn() },
}));

vi.mock("@/lib/services/calendar-insights-service", () => ({ CalendarInsightsService: { read: mocks.insights } }));

vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
  usePathname: () => "/one/calendar",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultOwnerToken: mocks.vaultOwnerToken,
    isVaultUnlocked: Boolean(mocks.vaultOwnerToken),
    getVaultOwnerToken: () => mocks.vaultOwnerToken,
    ownerTokenStatus: mocks.ownerTokenStatus,
    retryOwnerTokenRenewal: mocks.retryOwnerTokenRenewal,
  }),
}));
vi.mock("@/lib/services/google-calendar-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/services/google-calendar-service")>(),
  GoogleCalendarService: {
    invitations: mocks.invitations,
    today: mocks.today,
    availability: mocks.availability,
    reviewAttendance: mocks.reviewAttendance,
    confirmAttendance: mocks.confirmAttendance,
  },
}));

import { CalendarConnectedWorkspace } from "@/components/calendar/calendar-connected-workspace";
import { CalendarTimelineRow, availabilityTimeRangeLabel } from "@/components/calendar/calendar-schedule-presentation";
import { GoogleCalendarError } from "@/lib/services/google-calendar-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { resetIdleSchedulerForTests } from "@/lib/perf/idle-scheduler";

const status = {
  configured: true, connected: true, status: "connected" as const,
  google_email: "owner@example.com", access_level: "manage" as const,
  calendar_list_access: true, scope_csv: "calendar.events calendar.freebusy calendar.calendarlist.readonly",
};
const dailyEvents = [
  {
    id: "future", calendar_id: "primary", title: "Next planning session", status: "confirmed",
    start: { dateTime: "2026-10-14T08:00:00Z" }, end: { dateTime: "2026-10-14T08:30:00Z" },
    can_decline: true, organizer: { email: "organizer@example.com" },
  },
  {
    id: "ongoing", calendar_id: "primary", title: "Current partner meeting", status: "confirmed",
    start: { dateTime: "2026-10-14T05:45:00Z" }, end: { dateTime: "2026-10-14T06:30:00Z" },
    description: "Review the implementation and blockers.", location: "Office",
    conference_url: "https://meet.google.com/abc-defg-hij",
    can_decline: true, organizer: { email: "organizer@example.com" },
  },
  {
    id: "all-day", calendar_id: "primary", title: "Team retreat", status: "confirmed",
    start: { date: "2026-10-14" }, end: { date: "2026-10-15" },
  },
];

function workspace(userId = "owner", connectionStatus = status) {
  return <CalendarConnectedWorkspace userId={userId} status={connectionStatus} busy={false}
    getIdToken={mocks.getIdToken} onConnect={mocks.onConnect} onChat={mocks.onChat} onDisconnect={mocks.onDisconnect} />;
}

function dailyResponse(events: typeof dailyEvents = [], date = "2026-10-14", timeZone = "Asia/Kolkata") {
  return { events, date, time_zone: timeZone, calendars: [{ id: "owner@example.com", name: "Personal", primary: true }], unreadable_calendars: [] };
}

function freeResponse(date = "2026-10-14", duration = 15) {
  return { windows: [], full_count: 0, requested_duration_minutes: duration, date,
    time_zone: "Asia/Kolkata", time_min: `${date}T03:30:00Z`, time_max: `${date}T11:30:00Z`, calendars: [{ id: "primary", name: "Personal" }] };
}

async function openSettings() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Calendar settings and actions", exact: true }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Settings", exact: true }));
  await screen.findByRole("heading", { name: "Calendar settings", exact: true });
}

function control(name: string) {
  return screen.queryByRole("tab", { name, exact: true })
    ?? screen.getByRole("button", { name, exact: true });
}

describe("CalendarConnectedWorkspace", () => {
  it("keeps DST offsets when a repeated-hour window ends at next midnight", () => {
    expect(availabilityTimeRangeLabel("2026-11-01T05:30:00Z", "2026-11-02T05:00:00Z", "America/New_York", "2026-11-01")).toMatch(/GMT-4.*Midnight \(next day\).*GMT-5/);
  });
  it("keeps holiday defaults informational and confirms session-only exclusions without changing Today", async () => {
    const options = [
      { id: "owner@example.com", name: "Personal", primary: true, availability_default_included: true },
      { id: "shared", name: "Shared work", availability_default_included: true },
      { id: "en.jewish#holiday@group.v.calendar.google.com", name: "Observances", availability_default_included: false },
    ];
    mocks.today.mockResolvedValue({ ...dailyResponse(), calendar_options: options });
    mocks.availability.mockImplementation(async params => ({ ...freeResponse(params.date, params.durationMinutes), calendar_options: options }));
    const view = render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalled());
    await openSettings();
    expect(screen.getByText("Informational holiday feed")).toBeTruthy();
    const shared = within(screen.getByRole("listitem", { name: "Shared work" }));
    fireEvent.click(shared.getByRole("button", { name: "Exclude this calendar from availability" }));
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    act(() => { expect(unwindBackLayer("/one/calendar")).toBe(true); });
    expect(screen.queryByRole("button", { name: "Confirm exclusion" })).toBeNull();
    expect(shared.getByText("Blocks availability")).toBeTruthy();
    fireEvent.click(shared.getByRole("button", { name: "Exclude this calendar from availability" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm exclusion" }));
    fireEvent.click(within(screen.getByRole("listitem", { name: "Observances" })).getByRole("button", { name: "Include in availability" }));
    expect(mocks.availability).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    fireEvent.click(control("Free time"));
    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ calendarOverrides: { shared: false, "en.jewish#holiday@group.v.calendar.google.com": true } })));
    await act(async () => { advanceVaultSessionEpoch(); mocks.vaultOwnerToken = "renewed-same-owner"; view.rerender(workspace()); });
    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ calendarOverrides: { shared: false, "en.jewish#holiday@group.v.calendar.google.com": true } })));
    expect(mocks.today.mock.calls.every(([params]) => !("calendarOverrides" in params))).toBe(true);
    await openSettings();
    expect(within(screen.getByRole("listitem", { name: "Shared work" })).getByRole("button", { name: "Include in availability" })).toBeTruthy();
  });

  it("recovers failed availability using its full catalog and discards unsaved exclusion", async () => {
    const options = [{ id: "work", name: "Work", availability_default_included: true }];
    mocks.availability.mockRejectedValue(new GoogleCalendarError("Cannot read Work", "calendar_unreadable", 409, options));
    render(workspace());
    fireEvent.click(control("Free time"));
    await screen.findByRole("button", { name: "Retry", exact: true });
    expect(screen.queryByRole("button", { name: "Review availability calendars" })).toBeNull();
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Exclude this calendar from availability" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm exclusion" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Choose at least one calendar for availability.")).toBeTruthy();
    act(() => { unwindBackLayer("/one/calendar"); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openSettings();
    expect(screen.getByText("Blocks availability")).toBeTruthy();
  });

  it("requires review before retiring an override for a removed calendar", async () => {
    const initial = [{ id: "work", name: "Work", availability_default_included: true }, { id: "old", name: "Old shared", availability_default_included: true }];
    mocks.today.mockResolvedValue({ ...dailyResponse(), calendar_options: initial });
    render(workspace());
    await openSettings();
    fireEvent.click(within(await screen.findByRole("listitem", { name: "Old shared" })).getByRole("button", { name: "Exclude this calendar from availability" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm exclusion" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    mocks.availability.mockRejectedValueOnce(new GoogleCalendarError("Review changed calendars", "calendar_selection_changed", 409, initial.slice(0, 1)));
    fireEvent.click(control("Free time"));
    await screen.findByRole("button", { name: "Retry", exact: true });
    expect(screen.queryByRole("button", { name: "Review availability calendars" })).toBeNull();
    await openSettings();
    expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ calendarOverrides: { old: false } }));
    mocks.availability.mockResolvedValue({ ...freeResponse(), calendar_options: initial.slice(0, 1) });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ calendarOverrides: {} })));
  });

  it("clears availability choices on Google account replacement and retires pending requests", async () => {
    const options = [{ id: "owner@example.com", name: "Personal", availability_default_included: true }, { id: "shared", name: "Shared", availability_default_included: true }];
    mocks.today.mockResolvedValue({ ...dailyResponse(), calendar_options: options });
    const view = render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalled());
    await openSettings();
    fireEvent.click(within(screen.getByRole("listitem", { name: "Shared" })).getByRole("button", { name: "Exclude this calendar from availability" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm exclusion" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    mocks.availability.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(control("Free time"));
    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ calendarOverrides: { shared: false } })));
    const prior = mocks.availability.mock.calls.at(-1)![0];
    view.rerender(workspace("owner", { ...status, google_email: "replacement@example.com" }));
    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ calendarOverrides: {} })));
    expect(prior.signal.aborted).toBe(true);
    expect(prior.isEffectCurrent()).toBe(false);
    await openSettings();
    expect(screen.queryByRole("listitem", { name: "Shared" })).toBeNull();
  });

  it("retains the chat device zone despite provider metadata and preserves an explicit settings override", async () => {
    mocks.today.mockImplementation(async () => ({ ...dailyResponse(), calendars: [{ id: "primary", primary: true, time_zone: "America/Los_Angeles" }] }));
    render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalledWith(expect.objectContaining({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })));
    await openSettings();
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Europe/London" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings", exact: true }));
    await waitFor(() => expect(mocks.today).toHaveBeenLastCalledWith(expect.objectContaining({ timeZone: "Europe/London" })));
  });

  it.each(["America/Los_Angeles", "America/New_York", "America/Phoenix", "Asia/Kolkata", "Europe/London", "Asia/Kathmandu"])("ignores provider zone %s for every duration request", async primaryZone => {
    mocks.today.mockImplementation(async ({ date, timeZone }) => ({ ...dailyResponse([], date, timeZone), calendars: [{ id: "primary", primary: true, time_zone: primaryZone }] }));
    render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenLastCalledWith(expect.objectContaining({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })));
    fireEvent.click(control("Free time"));
    for (const minutes of [15, 30, 60]) {
      fireEvent.click(control(`${minutes} min`));
      await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, durationMinutes: minutes, startTime: "00:00", endTime: "24:00" })));
    }
    expect(screen.queryByText(`09:00 – 17:00 · ${primaryZone}`)).toBeNull();
  });

  it.each(["Europe/London", undefined])("uses the device zone for a replacement Google account (%s)", async replacementZone => {
    mocks.today.mockImplementation(async ({ date, timeZone }) => ({ ...dailyResponse([], date, timeZone), calendars: [{ id: "primary", primary: true, time_zone: "America/Los_Angeles" }] }));
    const view = render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenLastCalledWith(expect.objectContaining({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })));
    mocks.today.mockImplementation(async ({ date, timeZone }) => ({ ...dailyResponse([], date, timeZone), calendars: [{ id: "primary", primary: true, time_zone: replacementZone }] }));
    view.rerender(workspace("owner", { ...status, google_email: "replacement@example.com" }));
    const expectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await waitFor(() => expect(mocks.today).toHaveBeenLastCalledWith(expect.objectContaining({ timeZone: expectedZone })));
    fireEvent.click(control("Free time"));
    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ timeZone: expectedZone })));
  });

  it.each(["Availability could not be checked.", "Calendar availability could not be checked"])("renders the actual invalid-response message once with deliberate retry (%s)", async message => {
    mocks.availability.mockRejectedValueOnce(new GoogleCalendarError(message, "calendar_invalid_response", 502));
    render(workspace());
    fireEvent.click(control("Free time"));
    await screen.findByRole("alert");
    expect(screen.getAllByText("Availability could not be checked.")).toHaveLength(1);
    if (message !== "Availability could not be checked.") expect(screen.queryByText(message)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry", exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/Checking again automatically/)).toBeNull();
  });

  it("does not duplicate an account-switch read when only zone ownership changes", async () => {
    const view = render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Selected date"), { target: { value: "2030-01-02" } });
    await waitFor(() => expect(mocks.today).toHaveBeenCalledTimes(2));
    view.rerender(workspace("owner", { ...status, google_email: "replacement@example.com" }));
    await waitFor(() => expect(mocks.today).toHaveBeenCalledTimes(3));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.today).toHaveBeenCalledTimes(3);
  });

  it("retires the old account read during render before passive cleanup", async () => {
    let oldRequest!: { signal: AbortSignal; isEffectCurrent: () => boolean };
    let observed!: { aborted: boolean; current: boolean };
    mocks.today.mockImplementationOnce(() => new Promise(() => {}));
    function Probe({ email }: { email: string }) {
      useLayoutEffect(() => {
        if (email === "replacement@example.com") observed = { aborted: oldRequest.signal.aborted, current: oldRequest.isEffectCurrent() };
      }, [email]);
      return workspace("owner", { ...status, google_email: email });
    }
    const view = render(<Probe email={status.google_email} />);
    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    oldRequest = mocks.today.mock.calls[0][0];
    view.rerender(<Probe email="replacement@example.com" />);
    expect(observed).toEqual({ aborted: false, current: false });
  });

  it("discards an old account's pending availability while retaining the device date", async () => {
    vi.setSystemTime(new Date("2026-10-14T00:15:00Z"));
    mocks.today.mockImplementation(async ({ date, timeZone }) => ({ ...dailyResponse([], date, timeZone), calendars: [{ id: "primary", primary: true, time_zone: "America/Los_Angeles" }] }));
    const view = render(workspace());
    await waitFor(() => expect(screen.getByLabelText("Selected date")).toHaveValue("2026-10-14"));
    let resolveOld!: (value: ReturnType<typeof freeResponse>) => void;
    mocks.availability.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    fireEvent.click(control("Free time"));
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledOnce());
    const oldRequest = mocks.availability.mock.calls[0][0];
    mocks.availability.mockImplementation(async ({ date, durationMinutes }) => ({ ...freeResponse(date, durationMinutes), calendars: [{ id: "replacement", primary: true, time_zone: "Europe/London" }] }));
    view.rerender(workspace("owner", { ...status, google_email: "replacement@example.com" }));
    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ date: "2026-10-14", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })));
    expect(oldRequest.signal.aborted).toBe(true);
    expect(oldRequest.isEffectCurrent()).toBe(false);
    await act(async () => resolveOld({ ...freeResponse("2026-10-13"), full_count: 99 }));
    expect(screen.queryByText(/99 available slots/)).toBeNull();
    expect(screen.getByLabelText("Selected date")).toHaveValue("2026-10-14");
    expect(mocks.onChat).not.toHaveBeenCalled();
  });

  it("cancels rapid duration changes and keeps loading until the newest response settles", async () => {
    const pending = new Map<number, (value: ReturnType<typeof freeResponse>) => void>();
    mocks.availability.mockImplementation(({ durationMinutes }) => new Promise(resolve => pending.set(durationMinutes, resolve)));
    render(workspace());
    fireEvent.click(control("Free time"));
    await waitFor(() => expect(pending.has(15)).toBe(true));
    fireEvent.click(control("30 min"));
    await waitFor(() => expect(pending.has(30)).toBe(true));
    fireEvent.click(control("60 min"));
    await waitFor(() => expect(pending.has(60)).toBe(true));
    expect(mocks.availability.mock.calls.slice(0, 2).every(([request]) => request.signal.aborted)).toBe(true);
    await act(async () => { pending.get(30)!({ ...freeResponse(undefined, 30), full_count: 30 }); pending.get(15)!({ ...freeResponse(), full_count: 15 }); });
    expect(screen.getByRole("region", { name: "Free time" })).toBeInTheDocument();
    await act(async () => pending.get(60)!(freeResponse(undefined, 60)));
    expect(screen.getByText("No free slots in this window.")).toBeInTheDocument();
    expect(screen.queryByText(/(?:15|30) available slots/)).toBeNull();
  });

  it.each([undefined, "Not/AZone"])("retains device zone when primary zone is unavailable (%s)", async primaryZone => {
    const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    mocks.today.mockImplementation(async ({ date, timeZone }) => ({ ...dailyResponse([], date, timeZone), calendars: [{ id: "primary", primary: true, time_zone: primaryZone }] }));
    render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    fireEvent.click(control("Free time"));
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledWith(expect.objectContaining({ timeZone: deviceZone })));
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.vaultOwnerToken = "owner-token";
    mocks.ownerTokenStatus = "valid";
    mocks.retryOwnerTokenRenewal.mockResolvedValue(undefined);
    mocks.getIdToken.mockResolvedValue("firebase-owner-token");
    mocks.insights.mockResolvedValue({ complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0, time_zone: "UTC" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    mocks.invitations.mockResolvedValue({ events: [], pending_count: 0, unreadable_calendars: [], start_at: "2026-10-14T00:00:00Z", end_at: "2027-01-12T00:00:00Z", time_zone: "Asia/Kolkata", complete: true });
    mocks.today.mockImplementation(async ({ date, timeZone }) => dailyResponse([], date, timeZone));
    mocks.availability.mockImplementation(async ({ date, durationMinutes }) => freeResponse(date, durationMinutes));
  });

  afterEach(() => {
    cleanup();
    resetIdleSchedulerForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("defaults to Schedule and Today without requesting action permissions", async () => {
    render(workspace());

    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    expect(screen.getByRole("heading", { name: "Calendar", exact: true, hidden: true })).toHaveClass("sr-only");
    expect(screen.getByRole("tab", { name: "Schedule", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(control("Today")).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(mocks.availability).not.toHaveBeenCalled();
    expect(mocks.onConnect).not.toHaveBeenCalled();
  });

  it("supports keyboard main-tab changes and invitation filters", async () => {
    render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    const schedule = screen.getByRole("tab", { name: "Schedule", exact: true });
    schedule.focus();
    fireEvent.keyDown(schedule, { key: "ArrowRight" });

    const invitations = screen.getByRole("tab", { name: "Invitations", exact: true });
    expect(invitations).toHaveFocus();
    expect(invitations).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tablist", { name: "Invitation filters" })).toBeInTheDocument();
    fireEvent.keyDown(invitations, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Insights", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Executive snapshot" })).toBeInTheDocument();
    expect(mocks.availability).not.toHaveBeenCalled();
    expect(mocks.reviewAttendance).not.toHaveBeenCalled();
  });

  it("does not describe loading or a failed event fetch as an empty day", async () => {
    let reject!: (reason: Error) => void;
    mocks.today.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(workspace());

    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    expect(screen.queryByText(/No events/i)).toBeNull();
    await act(async () => reject(new Error("Calendar service unavailable")));

    await screen.findByText(/Calendar service unavailable/i);
    expect(screen.queryByText(/No events/i)).toBeNull();
    vi.setSystemTime(new Date("2026-10-14T06:00:04Z"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await screen.findByText("No events today.");
    let rejectRefresh!: (error: Error) => void;
    mocks.today.mockImplementationOnce(() => new Promise((_resolve, fail) => { rejectRefresh = fail; }));
    vi.setSystemTime(new Date("2026-10-14T06:00:08Z"));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(screen.getByRole("region", { name: "Today's events" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("No events today.")).toBeNull();
    expect(screen.queryByText("Your included calendars are clear.")).toBeNull();
    await act(async () => rejectRefresh(new GoogleCalendarError("Calendar refresh failed", "calendar_invalid_response", 503)));
    expect(screen.getByText("Calendar refresh failed")).toBeInTheDocument();
    expect(screen.queryByText("No events today.")).toBeNull();
    expect(screen.queryByText("Your included calendars are clear.")).toBeNull();
  });

  it("provides read reconnect recovery only after the provider requests it", async () => {
    mocks.today.mockRejectedValueOnce(new GoogleCalendarError("Reconnect Calendar to read events.", "calendar_reauthorization_required", 401));
    render(workspace());

    fireEvent.click(await screen.findByRole("button", { name: /Reconnect Calendar/i }));

    expect(mocks.onConnect.mock.calls[0][0]).toBe("read");
    expect(mocks.onConnect.mock.calls[0][1]).toBeFalsy();
    expect(screen.queryByText(/No events/i)).toBeNull();
    expect(mocks.reviewAttendance).not.toHaveBeenCalled();
  });

  it("separates all-day events, exposes real meeting links, and opens event details", async () => {
    mocks.today.mockResolvedValueOnce(dailyResponse([...dailyEvents,
      { ...dailyEvents[0], id: "zoom", title: "Zoom meeting", conference_url: "https://zoom.us/j/123456789", can_decline: false },
      { ...dailyEvents[0], id: "teams", title: "Teams meeting", conference_url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_qa/0", can_decline: false },
    ]));
    render(workspace());

    await screen.findByText("Team retreat");
    expect(screen.getByRole("heading", { name: "All-day events" })).toBeInTheDocument();
    const join = screen.getByRole("link", { name: "Join meeting: Current partner meeting", exact: true });
    expect(join).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
    expect(join).toHaveAttribute("target", "_blank");
    expect(document.querySelector('[data-calendar-event="primary:ongoing"] img[src="/one-calendar/providers/google-meet-reference.png"]')).toBeInTheDocument();
    expect(document.querySelector('[data-calendar-event="primary:zoom"] svg circle[fill="#0784ff"]')).toBeInTheDocument();
    expect(document.querySelector('[data-calendar-event="primary:zoom"] svg rect[fill="white"]')).toBeInTheDocument();
    expect(document.querySelector('[data-calendar-event="primary:teams"] img[src="/one-calendar/providers/microsoft-teams-reference.png"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Current partner meeting/i }));

    expect(await screen.findByText("Review the implementation and blockers.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Can.t attend/i })).toBeInTheDocument();
    expect(mocks.confirmAttendance).not.toHaveBeenCalled();
  });

  it("highlights an ongoing meeting and orders timed events before the next event", async () => {
    mocks.today.mockResolvedValueOnce(dailyResponse(dailyEvents));
    render(workspace());
    const ongoing = await screen.findByRole("button", { name: /^Current partner meeting/i });

    expect(within(ongoing.closest("li")!).getByText("Happening now")).toBeInTheDocument();
    expect(screen.queryByText("Up next")).toBeNull();
    const next = screen.getByRole("button", { name: /^Next planning session/i });
    expect(ongoing.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("ends an event at its actual instant regardless of the display timezone", () => {
    const event = { ...dailyEvents[1], start: { dateTime: "2026-10-16T17:30:00Z" }, end: { dateTime: "2026-10-16T18:00:00Z" }, conference_url: "https://meet.google.com/abc-defg-hij" };
    const props = { event, zone: "Asia/Kolkata", onOpen: vi.fn() };
    const view = render(<CalendarTimelineRow {...props} active ongoing now={Date.parse("2026-10-16T17:52:00Z")} />);
    expect(screen.getByText("Happening now")).toBeVisible();
    expect(screen.queryByText("Ended")).toBeNull();
    expect(screen.getByRole("link", { name: `Join meeting: ${event.title}` })).toBeInTheDocument();
    view.rerender(<CalendarTimelineRow {...props} active={false} ongoing={false} now={Date.parse("2026-10-16T18:00:00Z")} />);
    expect(screen.queryByText("Happening now")).toBeNull();
    expect(screen.getByText("Ended")).toBeVisible();
    expect(screen.queryByRole("link", { name: `Join meeting: ${event.title}` })).toBeNull();
  });

  it("highlights the next upcoming event when no meeting is ongoing", async () => {
    mocks.today.mockResolvedValueOnce(dailyResponse([dailyEvents[0]]));
    render(workspace());
    const next = await screen.findByRole("button", { name: /^Next planning session/i });

    expect(within(next.closest("li")!).getByText("Up next")).toBeInTheDocument();
    expect(screen.queryByText("Happening now")).toBeNull();
  });

  it("reloads the selected daily window when a valid time zone is applied", async () => {
    render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    expect(screen.queryByRole("textbox", { name: "Time zone" })).toBeNull();
    const providerShortcut = screen.getByRole("link", { name: "Open Google Calendar", exact: true });
    await openSettings();
    await waitFor(() => expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true));
    act(() => { providerShortcut.focus(); });
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Time zone" }), { target: { value: "America/New_York" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings", exact: true }));

    await waitFor(() => expect(mocks.today).toHaveBeenCalledTimes(2));
    expect(mocks.today).toHaveBeenLastCalledWith(expect.objectContaining({ firebaseIdToken: "firebase-owner-token", timeZone: "America/New_York" }));
    expect(mocks.onConnect).not.toHaveBeenCalled();
    await openSettings();
    let consumed = false;
    act(() => { consumed = unwindBackLayer("/one/calendar"); });
    expect(consumed).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Calendar settings and actions", exact: true })).toHaveFocus());
  });

  it("checks the full selected day despite edited alternative meeting hours", async () => {
    render(workspace());
    fireEvent.click(control("Free time"));
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledOnce());
    expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ durationMinutes: 15 }));
    fireEvent.change(screen.getByLabelText("Selected date"), { target: { value: "2026-10-15" } });
    await openSettings();
    fireEvent.change(screen.getByLabelText("Availability window start"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("Availability window end"), { target: { value: "16:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings", exact: true }));
    fireEvent.click(control("60 min"));

    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({
      firebaseIdToken: "firebase-owner-token", date: "2026-10-15", startTime: "00:00", endTime: "24:00", durationMinutes: 60,
    })));
    expect(await screen.findByText("No free slots in this window.")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /booking/i })).toBeNull();
  });

  it("shows one Free time error card and retries only deliberately after failure", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    mocks.availability.mockRejectedValueOnce(new GoogleCalendarError("Team calendar is unavailable", "calendar_invalid_response", 502));
    const view = render(workspace());
    try {
      await act(async () => { fireEvent.click(control("Free time")); });
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getAllByText("Availability could not be checked.")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Retry", exact: true })).toBeInTheDocument();
      expect(screen.queryByText("No free slots in this window.")).toBeNull();
      expect(screen.queryByText(/^Checked:/)).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_032);
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(mocks.availability).toHaveBeenCalledOnce();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true })); });
      expect(mocks.availability).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("No free slots in this window.")).toBeInTheDocument();
    } finally {
      view.unmount();
      resetIdleSchedulerForTests();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("loads a new date after an old Free time check failed", async () => {
    mocks.availability.mockRejectedValueOnce(new GoogleCalendarError("Calendar data was incomplete", "calendar_unreadable", 409));
    render(workspace());
    fireEvent.click(control("Free time"));
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Selected date"), { target: { value: "2026-10-16" } });
    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ date: "2026-10-16" })));
    expect(await screen.findByText("0 available slots on this day")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not request Free time while offline and recovers once immediately on reconnect", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    const tokenReads = mocks.getIdToken.mock.calls.length;
    online.mockReturnValue(false);
    fireEvent.click(control("Free time"));
    await screen.findByRole("alert");
    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
    expect(mocks.availability).not.toHaveBeenCalled();
    expect(mocks.getIdToken).toHaveBeenCalledTimes(tokenReads);
    await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    expect(mocks.availability).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("online")); });
    expect(mocks.availability).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("aborts an in-flight Free time check on offline and ignores its late result after reconnect", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    let resolveOld!: (value: unknown) => void;
    mocks.availability.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    render(workspace());
    fireEvent.click(control("Free time"));
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledOnce());
    const old = mocks.availability.mock.calls[0][0];
    online.mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    expect(old.signal.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent(/offline/);
    expect(screen.queryByText("Checking availability…")).toBeNull();
    online.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("online")); });
    expect(mocks.availability).toHaveBeenCalledTimes(2);
    expect(screen.getByText("0 available slots today")).toBeInTheDocument();
    await act(async () => resolveOld({ ...freeResponse(), full_count: 99 }));
    expect(screen.queryByText("99 available slots today")).toBeNull();
    expect(screen.getByText("0 available slots today")).toBeInTheDocument();
  });

  it.each(["token", "provider after token"])("bounds the entire Free time check to forty-five seconds while waiting for %s", async phase => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    const view = render(workspace());
    try {
      await act(async () => { await Promise.resolve(); });
      let resolveToken!: (value: string) => void;
      let resolveProvider!: (value: unknown) => void;
      mocks.getIdToken.mockImplementationOnce(() => new Promise(resolve => { resolveToken = resolve; }));
      mocks.availability.mockImplementationOnce(() => new Promise(resolve => { resolveProvider = resolve; }));
      await act(async () => { fireEvent.click(control("Free time")); });
      if (phase === "provider after token") {
        await act(async () => { await vi.advanceTimersByTimeAsync(40_000); resolveToken("firebase-owner-token"); });
        expect(mocks.availability).toHaveBeenCalledOnce();
        await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
      } else {
        await act(async () => { await vi.advanceTimersByTimeAsync(44_999); });
        expect(mocks.availability).not.toHaveBeenCalled();
      }
      expect(screen.getByRole("region", { name: "Free time" })).toHaveAttribute("aria-busy", "true");
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(screen.getByRole("alert")).toHaveTextContent("The availability check timed out. Try again.");
      expect(screen.queryByText("Checking availability…")).toBeNull();
      expect(screen.queryByText("No free slots in this window.")).toBeNull();
      expect(screen.getByRole("button", { name: "Retry", exact: true })).toBeInTheDocument();
      if (phase === "token") {
        await act(async () => resolveToken("late-firebase-owner-token"));
        expect(mocks.availability).not.toHaveBeenCalled();
      } else {
        expect(mocks.availability.mock.calls[0][0].signal.aborted).toBe(true);
        await act(async () => resolveProvider(freeResponse()));
      }
      expect(screen.getByRole("alert")).toHaveTextContent("timed out");
      expect(screen.queryByText("0 available slots today")).toBeNull();
    } finally {
      view.unmount();
      resetIdleSchedulerForTests();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("asks for optional Calendar-list access only when availability needs it", async () => {
    mocks.availability.mockRejectedValueOnce(new GoogleCalendarError("Allow subscribed-calendar access", "calendar_list_permission_required", 403));
    render(workspace());
    expect(mocks.onConnect).not.toHaveBeenCalled();
    fireEvent.click(control("Free time"));
    fireEvent.click(await screen.findByRole("button", { name: "Allow Calendar access", exact: true }));

    expect(mocks.onConnect).toHaveBeenCalledWith("read", true);
    expect(screen.queryByText("No free slots in this window.")).toBeNull();
  });

  it("invalidates a delayed availability response when its window changes", async () => {
    let complete!: (value: unknown) => void;
    mocks.availability.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    render(workspace());
    fireEvent.click(control("Free time"));
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledOnce());
    const superseded = mocks.availability.mock.calls[0][0];
    expect(superseded.signal.aborted).toBe(false);
    fireEvent.change(screen.getByLabelText("Selected date"), { target: { value: "2026-10-16" } });
    expect(superseded.signal.aborted).toBe(true);
    expect(superseded.isEffectCurrent()).toBe(false);
    await act(async () => complete({ ...freeResponse(), full_count: 99, windows: [{ start_at: "2026-10-15T10:00:00Z", end_at: "2026-10-15T10:30:00Z", duration_minutes: 30 }], calendars: [{ id: "old-calendar", name: "Old calendar" }] }));

    expect(screen.queryByText(/Old calendar/i)).toBeNull();
    expect(screen.queryByText(/^Checked:/)).toBeNull();
    expect(screen.queryByText("99 available slots today")).toBeNull();
    expect(await screen.findByText("0 available slots on this day")).toBeInTheDocument();
  });

  it("requests extra attendance access only when the owner chooses the action", async () => {
    mocks.today.mockResolvedValueOnce(dailyResponse(dailyEvents));
    render(<CalendarConnectedWorkspace userId="owner" status={{ ...status, access_level: "read" }} busy={false}
      getIdToken={mocks.getIdToken} onConnect={mocks.onConnect} onChat={mocks.onChat} onDisconnect={mocks.onDisconnect} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Current partner meeting/i }));
    expect(mocks.onConnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Can't attend", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Allow attendance changes", exact: true }));

    expect(mocks.onConnect).toHaveBeenCalledWith("manage");
    expect(mocks.reviewAttendance).not.toHaveBeenCalled();
    expect(mocks.confirmAttendance).not.toHaveBeenCalled();
  });

  it("reviews the exact editable organizer message before confirming once", async () => {
    mocks.today.mockResolvedValue(dailyResponse(dailyEvents));
    mocks.reviewAttendance.mockResolvedValueOnce({
      review_id: "review-id", review_token: "review-token", title: "Current partner meeting",
      recipient: "organizer@example.com", subject: "Another time", sender_label: "Connected Mail",
      message: "Tomorrow would work better.\n\nhttps://one.example.com/calendar/reschedule#recipient-capability",
      rescheduling_link: "https://one.example.com/calendar/reschedule#recipient-capability",
    });
    let settle!: (value: unknown) => void;
    mocks.confirmAttendance.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    render(workspace());
    fireEvent.click(await screen.findByRole("button", { name: /^Current partner meeting/i }));
    fireEvent.click(screen.getByRole("button", { name: "Can't attend", exact: true }));
    fireEvent.click(screen.getByRole("radio", { name: "Decline & offer another time", exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message to organizer", exact: true }), { target: { value: "Tomorrow would work better." } });
    fireEvent.click(screen.getByRole("button", { name: "Review", exact: true }));

    await screen.findByRole("heading", { name: "Review your response", exact: true });
    expect(mocks.reviewAttendance).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ongoing", offerTimes: true, message: "Tomorrow would work better." }));
    expect(screen.getByRole("link", { name: "Review recipient rescheduling link", exact: true })).toHaveAttribute("href", "https://one.example.com/calendar/reschedule#recipient-capability");
    expect(mocks.confirmAttendance).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Confirm", exact: true });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.confirmAttendance).toHaveBeenCalledOnce());
    expect(mocks.confirmAttendance).toHaveBeenCalledWith(expect.objectContaining({ vaultOwnerToken: "owner-token", firebaseIdToken: "firebase-owner-token", reviewId: "review-id", reviewToken: "review-token", isEffectCurrent: expect.any(Function) }));
    expect(screen.queryByText("Your attendance was declined.")).toBeNull();
    await act(async () => settle({ calendar: "declined", email: "unknown", calendar_error: null, email_error: "Email delivery could not be confirmed." }));
    expect(screen.getByText("Your attendance was declined.")).toBeInTheDocument();
    expect(screen.getByText("Email delivery could not be confirmed.")).toBeInTheDocument();
    expect(screen.queryByText("The organizer's email was sent.")).toBeNull();
  });

  it("does not carry a personalized organizer draft into a different invitation", async () => {
    mocks.today.mockResolvedValueOnce(dailyResponse(dailyEvents));
    render(workspace());
    fireEvent.click(await screen.findByRole("button", { name: /^Current partner meeting/i }));
    fireEvent.click(screen.getByRole("button", { name: "Can't attend", exact: true }));
    fireEvent.click(screen.getByRole("radio", { name: "Decline & offer another time", exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message to organizer", exact: true }), { target: { value: "Jamie, I need to move our private discussion." } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: /^Next planning session/i }));
    fireEvent.click(screen.getByRole("button", { name: "Can't attend", exact: true }));

    expect(screen.getByRole("radio", { name: "Decline only", exact: true })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Decline & offer another time", exact: true }));
    expect(screen.getByRole("textbox", { name: "Message to organizer", exact: true })).not.toHaveValue("Jamie, I need to move our private discussion.");
  });

  it("hides an old owners private event as soon as the account changes", async () => {
    mocks.today.mockResolvedValueOnce(dailyResponse(dailyEvents));
    let settleNew!: (value: unknown) => void;
    mocks.today.mockImplementationOnce(() => new Promise(resolve => { settleNew = resolve; }));
    const view = render(workspace("owner-a"));
    await screen.findByText("Current partner meeting");
    view.rerender(workspace("owner-b"));

    expect(screen.queryByText("Current partner meeting")).toBeNull();
    await waitFor(() => expect(mocks.today).toHaveBeenCalledTimes(2));
    await act(async () => settleNew(dailyResponse()));
    expect(screen.getByText("No events today.")).toBeInTheDocument();
  });

  it("abandons an old owners attendance action before its Firebase token resolves", async () => {
    mocks.today.mockResolvedValue(dailyResponse(dailyEvents));
    let settleToken!: (value: string) => void;
    const view = render(workspace("owner-a"));
    fireEvent.click(await screen.findByRole("button", { name: /^Current partner meeting/i }));
    mocks.getIdToken.mockClear();
    mocks.getIdToken.mockImplementationOnce(() => new Promise(resolve => { settleToken = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Can't attend", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Review", exact: true }));
    await waitFor(() => expect(mocks.getIdToken).toHaveBeenCalledOnce());
    view.rerender(workspace("owner-b"));
    await act(async () => settleToken("old-owners-firebase-token"));

    expect(mocks.reviewAttendance).not.toHaveBeenCalled();
    expect(mocks.confirmAttendance).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("abandons attendance when the vault session changes synchronously before token resolution", async () => {
    mocks.today.mockResolvedValue(dailyResponse(dailyEvents));
    let settleToken!: (value: string) => void;
    render(workspace());
    fireEvent.click(await screen.findByRole("button", { name: /^Current partner meeting/i }));
    mocks.getIdToken.mockClear();
    mocks.getIdToken.mockImplementationOnce(() => new Promise(resolve => { settleToken = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Can't attend", exact: true }));
    fireEvent.click(screen.getByRole("radio", { name: "Decline & offer another time", exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message to organizer", exact: true }), { target: { value: "Private organizer draft awaiting authority." } });
    fireEvent.click(screen.getByRole("button", { name: "Review", exact: true }));
    await waitFor(() => expect(mocks.getIdToken).toHaveBeenCalledOnce());

    await act(async () => {
      advanceVaultSessionEpoch();
      settleToken("token-from-a-previous-vault-session");
    });

    expect(mocks.reviewAttendance).not.toHaveBeenCalled();
    expect(mocks.confirmAttendance).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector('textarea[aria-label="Message to organizer"]')).toBeNull();
  });

  it("marks a cold connected Schedule loaded after Firebase read without a vault token", async () => {
    mocks.vaultOwnerToken = null;
    mocks.ownerTokenStatus = "locked";
    mocks.today.mockResolvedValueOnce(dailyResponse(dailyEvents));
    render(workspace());

    await screen.findByRole("button", { name: /^Current partner meeting/i });
    const beacon = screen.getByTestId("native-route-calendar");
    expect(beacon).toHaveAttribute("data-native-auth-state", "authenticated");
    expect(beacon).toHaveAttribute("data-native-data-state", "loaded");
    expect(mocks.today).toHaveBeenCalledWith(expect.objectContaining({ firebaseIdToken: "firebase-owner-token" }));
    expect(mocks.today.mock.calls[0][0]).not.toHaveProperty("vaultOwnerToken");
    expect(screen.queryByText("Calendar session unavailable.")).toBeNull();
    expect(screen.queryByRole("button", { name: /unlock/i })).toBeNull();
  });

  it("keeps a failed fetch visible as an error on the native beacon", async () => {
    mocks.today.mockRejectedValueOnce(new GoogleCalendarError("Calendar provider failed", "calendar_invalid_response", 502));
    render(workspace());

    await screen.findByText("Calendar provider failed");
    expect(screen.getByTestId("native-route-calendar")).toHaveAttribute("data-native-data-state", "error");
    expect(screen.queryByText("No events today.")).toBeNull();
  });

  it("keeps an editable organizer draft and selected window across same-owner token renewal", async () => {
    mocks.today.mockResolvedValue(dailyResponse(dailyEvents));
    const view = render(workspace());
    await screen.findByRole("button", { name: /^Current partner meeting/i });
    await openSettings();
    fireEvent.change(screen.getByRole("textbox", { name: "Time zone", exact: true }), { target: { value: "America/New_York" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings", exact: true }));
    await waitFor(() => expect(mocks.today).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /^Current partner meeting/i }));
    fireEvent.click(screen.getByRole("button", { name: "Can't attend", exact: true }));
    fireEvent.click(screen.getByRole("radio", { name: "Decline & offer another time", exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message to organizer", exact: true }), { target: { value: "Keep this reviewed organizer draft." } });
    fireEvent.change(screen.getByLabelText("Alternative date"), { target: { value: "2026-10-16" } });
    fireEvent.change(screen.getByLabelText("Alternative window start"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("Alternative window end"), { target: { value: "16:00" } });
    await act(async () => {
      mocks.vaultOwnerToken = null;
      mocks.ownerTokenStatus = "renewing";
      view.rerender(workspace());
    });
    expect(screen.getByRole("textbox", { name: "Message to organizer", exact: true })).toHaveValue("Keep this reviewed organizer draft.");
    expect(mocks.reviewAttendance).not.toHaveBeenCalled();
    expect(mocks.confirmAttendance).not.toHaveBeenCalled();
    await act(async () => {
      advanceVaultSessionEpoch();
      mocks.vaultOwnerToken = "renewed-token-for-the-same-owner";
      mocks.ownerTokenStatus = "valid";
      view.rerender(workspace());
    });

    await screen.findByRole("textbox", { name: "Message to organizer", exact: true });
    expect(screen.getByRole("textbox", { name: "Message to organizer", exact: true })).toHaveValue("Keep this reviewed organizer draft.");
    expect(screen.getByRole("radio", { name: "Decline & offer another time", exact: true })).toBeChecked();
    expect(screen.getByLabelText("Alternative date")).toHaveValue("2026-10-16");
    expect(screen.getByLabelText("Alternative window start")).toHaveValue("10:00");
    expect(screen.getByLabelText("Alternative window end")).toHaveValue("16:00");
    expect(screen.getByLabelText("Selected date")).toHaveValue("2026-10-14");
    expect(mocks.today).toHaveBeenLastCalledWith(expect.objectContaining({ timeZone: "America/New_York" }));
  });

  it("reloads after a verified reconnect even when the visible scope flags stay the same", async () => {
    const view = render(<CalendarConnectedWorkspace userId="owner" status={status} busy={false} connectionRevision={0}
      getIdToken={mocks.getIdToken} onConnect={mocks.onConnect} onChat={mocks.onChat} onDisconnect={mocks.onDisconnect} />);
    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    view.rerender(<CalendarConnectedWorkspace userId="owner" status={status} busy={false} connectionRevision={1}
      getIdToken={mocks.getIdToken} onConnect={mocks.onConnect} onChat={mocks.onChat} onDisconnect={mocks.onDisconnect} />);

    await waitFor(() => expect(mocks.today).toHaveBeenCalledTimes(2));
  });

  it("keeps attendance mutation protected when Firebase can read events without vault authority", async () => {
    mocks.vaultOwnerToken = null;
    mocks.ownerTokenStatus = "locked";
    mocks.today.mockResolvedValueOnce(dailyResponse(dailyEvents));
    render(workspace());
    fireEvent.click(await screen.findByRole("button", { name: /^Current partner meeting/i }));
    fireEvent.click(screen.getByRole("button", { name: "Can't attend", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Review", exact: true }));

    await screen.findByText("Calendar access changed. Reload this invitation.");
    expect(mocks.reviewAttendance).not.toHaveBeenCalled();
    expect(mocks.confirmAttendance).not.toHaveBeenCalled();
    expect(screen.queryByText(/No events/i)).toBeNull();
  });

  it("changes the selected day and opens that exact day in the connected provider account", async () => {
    render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Next day", exact: true }));
    await waitFor(() => expect(mocks.today).toHaveBeenLastCalledWith(expect.objectContaining({ date: "2026-10-15" })));
    expect(screen.getByLabelText("Selected date")).toHaveValue("2026-10-15");
    const provider = new URL(screen.getByRole("link", { name: "Open Google Calendar" }).getAttribute("href")!);
    expect(provider.pathname).toBe("/calendar/u/0/r/day/2026/10/15");
    expect(provider.searchParams.get("authuser")).toBe("owner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Previous day", exact: true }));
    await waitFor(() => expect(mocks.today).toHaveBeenLastCalledWith(expect.objectContaining({ date: "2026-10-14" })));
    fireEvent.change(screen.getByLabelText("Selected date"), { target: { value: "2026-10-18" } });
    fireEvent.click(screen.getByRole("button", { name: "Today", exact: true }));
    expect(screen.getByLabelText("Selected date")).toHaveValue("2026-10-14");
  });

  it("keeps same-provider event identifiers distinct and explains calendars that only share busy time", async () => {
    const events = [dailyEvents[0], { ...dailyEvents[0], calendar_id: "work@example.com", title: "Work copy of shared ID", can_decline: false }];
    mocks.today.mockResolvedValueOnce({ ...dailyResponse(events), unreadable_calendars: [{ id: "shared", name: "Shared busy calendar" }] });
    render(workspace());
    await screen.findByText("Work copy of shared ID");

    expect(screen.getByText(/Event details are not shared for Shared busy calendar/)).toBeInTheDocument();
    expect(document.querySelector('[data-calendar-event="primary:future"]')).toBeInTheDocument();
    expect(document.querySelector('[data-calendar-event="work@example.com:future"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Work copy of shared ID/ }));
    expect(screen.queryByRole("button", { name: "Can't attend", exact: true })).toBeNull();
    expect(mocks.reviewAttendance).not.toHaveBeenCalled();
  });

  it("opens event-menu details and the provider's actual event URL", async () => {
    const events = [{ ...dailyEvents[1], html_link: "https://calendar.google.com/calendar/event?eid=qa-specific-event" }];
    mocks.today.mockResolvedValueOnce(dailyResponse(events));
    render(workspace());
    const menu = await screen.findByRole("button", { name: "More options: Current partner meeting", exact: true });
    fireEvent.keyDown(menu, { key: "Enter" });
    const provider = await screen.findByRole("menuitem", { name: "Open in Google Calendar", exact: true });
    expect(provider).toHaveAttribute("href", "https://calendar.google.com/calendar/event?eid=qa-specific-event");
    fireEvent.click(screen.getByRole("menuitem", { name: "View details", exact: true }));
    expect(await screen.findByRole("dialog")).toContainElement(screen.getByText("Review the implementation and blockers."));
  });

  it("shows the complete availability count and maximal elapsed ranges rather than fixed-length slices", async () => {
    mocks.availability.mockResolvedValueOnce({ ...freeResponse(), full_count: 5, windows: [
      { start_at: "2026-10-14T06:15:00Z", end_at: "2026-10-14T07:00:00Z", duration_minutes: 45 },
      { start_at: "2026-10-14T08:00:00Z", end_at: "2026-10-14T08:30:00Z", duration_minutes: 30 },
      { start_at: "2026-10-14T09:00:00Z", end_at: "2026-10-14T11:00:00Z", duration_minutes: 120 },
    ] });
    render(workspace());
    fireEvent.click(control("Free time"));

    expect(await screen.findByRole("heading", { name: "5 available slots today", exact: true })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Ask One about/ })).toHaveLength(3);
    expect(screen.getByText("45 min", { exact: true })).toBeInTheDocument();
    expect(within(screen.getAllByRole("button", { name: /^Ask One about/ })[1]).getByText("30 min", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("2 hr", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Showing 3 of 5 available windows.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check availability" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Time zone" })).toBeNull();
  });

  it.each([15, 30, 60] as const)("hands a real whole-row window to chat with %s minutes", async duration => {
    mocks.availability.mockImplementation(async ({ date }) => ({ ...freeResponse(date, duration), full_count: 1,
      windows: [{ start_at: "2026-10-14T18:00:00Z", end_at: "2026-10-14T20:00:00Z", duration_minutes: 120 }] }));
    render(workspace());
    fireEvent.click(control("Free time"));
    fireEvent.click(control(`${duration} min`));
    const row = await screen.findByRole("button", { name: /^Ask One about/ });
    expect(row).toHaveTextContent("2 hr");
    fireEvent.click(row);
    expect(mocks.onChat).toHaveBeenCalledWith(undefined, expect.objectContaining({ durationMinutes: duration, ownerId: "owner", date: "2026-10-14" }));
    expect(mocks.reviewAttendance).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("invalidates Today and Free time only for the booking owner", async () => {
    render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalled());
    const reads = mocks.today.mock.calls.length;
    act(() => notifyCalendarChanged("someone-else"));
    expect(mocks.today).toHaveBeenCalledTimes(reads);
    act(() => notifyCalendarChanged("owner"));
    await waitFor(() => expect(mocks.today.mock.calls.length).toBeGreaterThan(reads));
    fireEvent.click(control("Free time"));
    await waitFor(() => expect(mocks.availability).toHaveBeenCalled());
    const checks = mocks.availability.mock.calls.length;
    act(() => notifyCalendarChanged("owner"));
    await waitFor(() => expect(mocks.availability.mock.calls.length).toBeGreaterThan(checks));
    fireEvent.click(control("Today"));
    await waitFor(() => expect(mocks.today.mock.calls.length).toBeGreaterThan(reads + 1));
  });

  it("labels the exclusive next midnight only in Free time and retains booking UTC bounds", async () => {
    mocks.today.mockImplementation(async ({ date, timeZone }) => ({
      ...dailyResponse([], date, timeZone),
      calendars: [{ id: "primary", primary: true, time_zone: "Asia/Kolkata" }],
    }));
    mocks.availability.mockResolvedValueOnce({ ...freeResponse(), full_count: 1, windows: [
      { start_at: "2026-10-14T18:00:00Z", end_at: "2026-10-14T18:30:00Z", duration_minutes: 30 },
    ] });
    render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenLastCalledWith(expect.objectContaining({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })));
    await openSettings();
    fireEvent.change(screen.getByRole("textbox", { name: "Time zone" }), { target: { value: "Asia/Kolkata" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings", exact: true }));
    fireEvent.click(control("Free time"));
    expect(await screen.findByText(/Midnight \(next day\)/)).toBeInTheDocument();
    expect(screen.queryByText(/24:00/)).toBeNull();
    expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ startTime: "00:00", endTime: "24:00" }));
    fireEvent.click(screen.getByRole("button", { name: /^Ask One about/ }));
    expect(mocks.onChat).toHaveBeenCalledWith(undefined, expect.objectContaining({ windowStart: "2026-10-14T18:00:00Z", windowEnd: "2026-10-14T18:30:00Z", durationMinutes: 15, timeZone: "Asia/Kolkata" }));
  });

  it("keeps a repeated-hour window's real UTC bounds in the Calendar chat handoff", async () => {
    mocks.availability.mockResolvedValueOnce({ ...freeResponse("2026-11-01"), time_zone: "America/New_York",
      time_min: "2026-11-01T04:00:00Z", time_max: "2026-11-01T09:00:00Z", full_count: 1, windows: [
      { start_at: "2026-11-01T05:30:00Z", end_at: "2026-11-01T06:30:00Z", duration_minutes: 60 },
    ] });
    render(workspace());
    fireEvent.change(screen.getByLabelText("Selected date"), { target: { value: "2026-11-01" } });
    await openSettings();
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "America/New_York" } });
    fireEvent.change(screen.getByLabelText("Availability window start"), { target: { value: "00:00" } });
    fireEvent.change(screen.getByLabelText("Availability window end"), { target: { value: "04:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings", exact: true }));
    fireEvent.click(control("Free time"));
    const add = await screen.findByRole("button", { name: /^Ask One about/ });
    expect(add).toHaveAccessibleName(/GMT-4.*GMT-5/);
    expect(screen.getByText(/GMT-4.*GMT-5/, { selector: "span" })).toBeInTheDocument();
    fireEvent.click(add);

    expect(mocks.onChat).toHaveBeenCalledOnce();
    expect(mocks.onChat).toHaveBeenCalledWith(undefined, {
      ownerId: "owner", accountEmail: status.google_email, date: "2026-11-01", timeZone: "America/New_York",
      windowStart: "2026-11-01T05:30:00Z", windowEnd: "2026-11-01T06:30:00Z", durationMinutes: 15,
    });
    expect(mocks.reviewAttendance).not.toHaveBeenCalled();
    expect(mocks.confirmAttendance).not.toHaveBeenCalled();
  });

  it("keeps the chosen Free time preferences and Firebase reads across vault token changes", async () => {
    mocks.vaultOwnerToken = null;
    mocks.ownerTokenStatus = "locked";
    const view = render(workspace());
    fireEvent.click(control("Free time"));
    fireEvent.change(screen.getByLabelText("Selected date"), { target: { value: "2026-10-15" } });
    fireEvent.click(control("60 min"));
    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ firebaseIdToken: "firebase-owner-token", date: "2026-10-15", durationMinutes: 60 })));
    expect(mocks.availability.mock.calls.at(-1)![0]).not.toHaveProperty("vaultOwnerToken");
    expect(screen.queryByRole("link", { name: "Return to One", exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: /unlock/i })).toBeNull();
    await act(async () => { advanceVaultSessionEpoch(); mocks.vaultOwnerToken = "owner-token-restored-elsewhere"; mocks.ownerTokenStatus = "valid"; view.rerender(workspace()); });

    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ firebaseIdToken: "firebase-owner-token", date: "2026-10-15", durationMinutes: 60 })));
    expect(screen.getByRole("tab", { name: "Free time", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Selected date")).toHaveValue("2026-10-15");
    expect(screen.getByRole("tab", { name: "60 min", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(mocks.onConnect).not.toHaveBeenCalled();
  });

  it("shows rejected Firebase credentials honestly and recovers on focus without a manual retry button", async () => {
    mocks.vaultOwnerToken = null;
    mocks.ownerTokenStatus = "locked";
    mocks.getIdToken.mockRejectedValueOnce(new Error("Firebase session expired"));
    mocks.today.mockResolvedValueOnce(dailyResponse(dailyEvents));
    render(workspace());

    await screen.findByText("Firebase session expired");
    expect(screen.getByTestId("native-route-calendar")).toHaveAttribute("data-native-data-state", "error");
    expect(mocks.today).not.toHaveBeenCalled();
    expect(screen.queryByText(/No events/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /unlock/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again", exact: true })).toBeNull();
    vi.setSystemTime(new Date("2026-10-14T06:00:04Z"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });

    await screen.findByRole("button", { name: /^Current partner meeting/i });
    expect(mocks.today).toHaveBeenCalledOnce();
    expect(mocks.today).toHaveBeenCalledWith(expect.objectContaining({ firebaseIdToken: "firebase-owner-token" }));
    expect(mocks.retryOwnerTokenRenewal).not.toHaveBeenCalled();
  });

  it("loads Calendar independently of background vault renewal and unavailable vault authority", async () => {
    mocks.vaultOwnerToken = null;
    mocks.ownerTokenStatus = "renewing";
    mocks.today.mockResolvedValueOnce(dailyResponse(dailyEvents));
    const view = render(workspace());
    await screen.findByRole("button", { name: /^Current partner meeting/i });
    mocks.ownerTokenStatus = "unavailable";
    view.rerender(workspace());
    fireEvent.click(control("Free time"));

    await waitFor(() => expect(mocks.availability).toHaveBeenCalledWith(expect.objectContaining({ firebaseIdToken: "firebase-owner-token" })));
    expect(screen.queryByText("Restoring Calendar access…")).toBeNull();
    expect(screen.queryByText("Calendar access could not be restored.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore access", exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: /unlock/i })).toBeNull();
    expect(mocks.retryOwnerTokenRenewal).not.toHaveBeenCalled();
  });

  it("abandons a prior owner's Schedule read before its Firebase token resolves", async () => {
    mocks.vaultOwnerToken = null;
    let settleOldToken!: (value: string) => void;
    mocks.getIdToken.mockImplementationOnce(() => new Promise(resolve => { settleOldToken = resolve; }));
    mocks.today.mockResolvedValueOnce(dailyResponse(dailyEvents));
    const view = render(workspace("owner-a"));
    await waitFor(() => expect(mocks.getIdToken).toHaveBeenCalledOnce());
    expect(mocks.today).not.toHaveBeenCalled();
    view.rerender(workspace("owner-b"));
    await screen.findByRole("button", { name: /^Current partner meeting/i });
    await act(async () => settleOldToken("prior-owners-firebase-token"));

    expect(mocks.today).toHaveBeenCalledOnce();
    expect(mocks.today).toHaveBeenCalledWith(expect.objectContaining({ firebaseIdToken: "firebase-owner-token" }));
    expect(mocks.today.mock.calls[0][0]).not.toHaveProperty("vaultOwnerToken");
  });

  it("fetches only the selected Schedule view and selected date", async () => {
    render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    fireEvent.click(control("Free time"));
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Selected date"), { target: { value: "2026-10-15" } });
    await waitFor(() => expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ date: "2026-10-15" })));
    expect(mocks.today).toHaveBeenCalledOnce();
    fireEvent.click(control("Today"));
    await waitFor(() => expect(mocks.today).toHaveBeenLastCalledWith(expect.objectContaining({ date: "2026-10-15" })));
    const calls = { today: mocks.today.mock.calls.length, free: mocks.availability.mock.calls.length };
    fireEvent.click(screen.getByRole("tab", { name: "Invitations", exact: true }));
    await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    expect(mocks.today).toHaveBeenCalledTimes(calls.today);
    expect(mocks.availability).toHaveBeenCalledTimes(calls.free);
  });

  it("deduplicates focus and online refreshes and keeps the last same-day events while a read is in flight", async () => {
    let resolveRefresh!: (value: unknown) => void;
    mocks.today.mockResolvedValueOnce(dailyResponse(dailyEvents));
    mocks.today.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    render(workspace());
    await screen.findByRole("button", { name: /^Current partner meeting/i });
    await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    expect(mocks.today).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date("2026-10-14T06:00:04Z"));
    await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    expect(mocks.today).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /^Current partner meeting/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Today's events" })).toHaveAttribute("aria-busy", "true");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(mocks.today).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-10-14T06:00:08Z"));
    await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    expect(mocks.today).toHaveBeenCalledTimes(2);
    await act(async () => resolveRefresh(dailyResponse([{ ...dailyEvents[1], title: "Fresh partner meeting" }])));
    expect(screen.getByRole("button", { name: /^Fresh partner meeting/i })).toBeInTheDocument();
    expect(screen.queryByText("Updating events…")).toBeNull();
    expect(mocks.availability).not.toHaveBeenCalled();
    mocks.today.mockRejectedValueOnce(new GoogleCalendarError("Calendar access was revoked", "calendar_reauthorization_required", 401));
    vi.setSystemTime(new Date("2026-10-14T06:00:12Z"));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(screen.queryByRole("button", { name: /^Fresh partner meeting/i })).toBeNull();
    expect(screen.getByText("Calendar access was revoked")).toBeInTheDocument();
    expect(screen.queryByText("No events today.")).toBeNull();
  });

  it("removes stale Free time booking actions while checking or after unavailable calendar data", async () => {
    let rejectRefresh!: (error: Error) => void;
    const checked = { ...freeResponse(), full_count: 1, windows: [
      { start_at: "2026-10-14T06:15:00Z", end_at: "2026-10-14T07:00:00Z", duration_minutes: 45 },
    ] };
    mocks.availability.mockResolvedValueOnce(checked);
    mocks.availability.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    render(workspace());
    fireEvent.click(control("Free time"));
    await screen.findByRole("button", { name: /^Ask One about/ });
    vi.setSystemTime(new Date("2026-10-14T06:00:04Z"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(mocks.availability).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: /^Ask One about/ })).toBeNull();
    await act(async () => rejectRefresh(new GoogleCalendarError("Calendar was unavailable", "calendar_invalid_response", 503)));
    expect(screen.getByText("Availability could not be checked.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Ask One about/ })).toBeNull();
    expect(screen.queryByText("No free slots in this window.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again", exact: true })).toBeNull();
    expect(mocks.onChat).not.toHaveBeenCalled();
  });

  it("polls the active view every thirty seconds while visible and refreshes once when returning", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(workspace());
    try {
      await act(async () => { await Promise.resolve(); });
      expect(mocks.today).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_032); });
      expect(mocks.today).toHaveBeenCalledTimes(2);
      expect(mocks.availability).not.toHaveBeenCalled();
      visibility.mockReturnValue("hidden");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(30_032); });
      expect(mocks.today).toHaveBeenCalledTimes(2);
      visibility.mockReturnValue("visible");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(32); });
      expect(mocks.today).toHaveBeenCalledTimes(3);
      await act(async () => { fireEvent.click(control("Free time")); });
      expect(mocks.availability).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_032); });
      expect(mocks.availability).toHaveBeenCalledTimes(2);
      expect(mocks.today).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      visibility.mockRestore();
      resetIdleSchedulerForTests();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["Today", "Free time"])("forwards deliberate Calendar chat and disconnect actions once in %s", async activeView => {
    render(workspace());
    await waitFor(() => expect(mocks.today).toHaveBeenCalledOnce());
    if (activeView === "Free time") fireEvent.click(control("Free time"));

    fireEvent.click(screen.getByRole("button", { name: "Try Calendar Agent with One", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Calendar", exact: true }));

    expect(mocks.onChat).toHaveBeenCalledOnce();
    expect(mocks.onDisconnect).toHaveBeenCalledOnce();
    expect(mocks.onConnect).not.toHaveBeenCalled();
  });
});


describe("Calendar Insights meeting library", () => {
  afterEach(cleanup);
  it("filters verified artifacts, keeps search on Back and hides revoked sources", async () => {
    mocks.getIdToken.mockResolvedValue("firebase-owner-token");
    mocks.today.mockResolvedValue(dailyResponse());
    mocks.insights.mockImplementation(async (path: string) => {
      if (path === "meetings") return { complete: true, window_days: 30, meetings: [
        { id: "notes", calendar_id: "primary", title: "Design review", artifact_kinds: ["notes"], start: { dateTime: "2026-10-14T10:00:00Z" } },
        { id: "video", calendar_id: "primary", title: "Product demo", artifact_kinds: ["recording"], start: { dateTime: "2026-10-14T09:00:00Z" } },
      ] };
      if (path === "meetings/detail") return { discovery: "permission_required", complete: false, event: { title: "Design review" }, artifacts: [{ file_id: "revoked", kind: "notes", state: "permission_required" }] };
      return { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 };
    });
    render(workspace());
    fireEvent.click(screen.getByRole("tab", { name: "Insights", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    await screen.findByRole("button", { name: /Design review/ });
    fireEvent.click(screen.getByRole("tab", { name: "Notes", exact: true }));
    expect(screen.queryByRole("button", { name: /Product demo/ })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Design" } });
    fireEvent.click(screen.getByRole("button", { name: /Design review/ }));
    expect(await screen.findByRole("button", { name: "Ask One about this meeting" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: /Open source/ })).toBeNull();
    act(() => { unwindBackLayer("/one/calendar"); });
    expect(screen.getByRole("searchbox")).toHaveValue("Design");
    await screen.findByRole("button", { name: /Design review/ });
    expect(screen.getByRole("tab", { name: "Notes", exact: true })).toHaveAttribute("aria-selected", "true");
  });
});

it("refreshes new artifacts and modified notes, removes revoked content, and stops hidden/offline requests", async () => {
  mocks.getIdToken.mockResolvedValue("firebase-owner-token");
  mocks.today.mockResolvedValue(dailyResponse());
  let generation = 0;
  let hidden = false;
  let online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => hidden ? "hidden" : "visible");
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  const overview = { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 };
  mocks.insights.mockImplementation(async (path: string) => path === "insights" ? overview : path === "meetings" ? {
    complete: true, window_days: 30, meetings: [{ id: "late", calendar_id: "primary", title: "Late files", artifact_kinds: generation ? ["recording", "notes"] : [], artifact_status: "processing" }],
  } : { discovery: "checked", complete: true, artifacts: generation === 3 ? [{ file_id: "n", kind: "notes", state: "permission_required" }] : generation ? [
    { file_id: "r", kind: "recording", state: "available", url: "https://drive.google.com/file/d/r/view" },
    { file_id: "n", kind: "notes", state: "available", text: generation === 1 ? "Original provider notes\nDecisions\nUse provider file IDs.\nFollow-ups\nVerify access." : "Updated provider notes", url: "https://docs.google.com/document/d/n", can_ask: true },
    { file_id: "t", kind: "transcript", state: "available", text: "Late provider transcript", url: "https://docs.google.com/document/d/t" },
  ] : [], availability: { recording: "processing", notes: "processing", transcript: "processing" } });
  render(workspace());
  fireEvent.click(screen.getByRole("tab", { name: "Insights", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Late files/ }));
  await screen.findByRole("button", { name: "Ask One about this meeting" });
  expect(screen.queryByRole("link", { name: "Watch recording" })).toBeNull();
  generation = 1;
  fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
  await screen.findByRole("link", { name: "Watch recording" });
  await screen.findByText(/Original provider notes/);
  expect(screen.getByText("Use provider file IDs.")).toBeInTheDocument();
  expect(screen.getByText("Verify access.")).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "Source: Meeting document" })).toHaveLength(2);
  fireEvent.click(screen.getByRole("tab", { name: "Transcript", exact: true }));
  await screen.findByText("Late provider transcript");
  fireEvent.click(screen.getByRole("tab", { name: "Notes", exact: true }));
  generation = 2;
  fireEvent(window, new Event("focus"));
  await screen.findByText("Updated provider notes");
  expect(screen.queryByText(/Original provider notes/)).toBeNull();
  generation = 3;
  fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
  await waitFor(() => expect(screen.queryByText("Updated provider notes")).toBeNull());
  await screen.findByText(/Permission required. Calendar access/);
  expect(screen.queryByRole("link", { name: "Watch recording" })).toBeNull();
  hidden = true;
  fireEvent(document, new Event("visibilitychange"));
  const before = mocks.insights.mock.calls.length;
  fireEvent(window, new Event("focus"));
  await act(async () => {});
  expect(mocks.insights).toHaveBeenCalledTimes(before);
  online = false; hidden = false;
  fireEvent(window, new Event("offline"));
  expect(screen.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
  online = true;
  fireEvent(window, new Event("online"));
  await waitFor(() => expect(mocks.insights.mock.calls.length).toBeGreaterThan(before));
  cleanup(); vi.restoreAllMocks();
});

it("bounds background checks to five visible refreshes and cancels stale account responses", async () => {
  mocks.getIdToken.mockResolvedValue("firebase-owner-token");
  mocks.today.mockResolvedValue(dailyResponse());
  const timers = new Map<number, () => void>();
  const setTimeout = window.setTimeout.bind(window), clearTimeout = window.clearTimeout.bind(window);
  let timerId = 900000;
  vi.spyOn(window, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === 60000) { timers.set(++timerId, callback); return timerId; }
    return setTimeout(callback, delay, ...args);
  }) as typeof window.setTimeout);
  vi.spyOn(window, "clearTimeout").mockImplementation(id => { timers.delete(id); clearTimeout(id); });
  mocks.insights.mockResolvedValue({ complete: true, meetings: [], days: [], recurring: [], focus: [], meeting_count: 0, meeting_minutes: 0 });
  const view = render(workspace());
  fireEvent.click(screen.getByRole("tab", { name: "Insights", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
  await screen.findByText("No linked meetings were returned for this period.");
  for (let index = 0; index < 5; index++) {
    await waitFor(() => expect(timers.size).toBe(1));
    const [id, callback] = [...timers][0]; timers.delete(id);
    await act(async () => callback());
    await screen.findByText("No linked meetings were returned for this period.");
  }
  expect(timers.size).toBe(0);
  let finish!: (value: unknown) => void;
  mocks.insights.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
  await waitFor(() => expect(finish).toBeDefined());
  const signal = mocks.insights.mock.calls.at(-1)?.[3] as AbortSignal;
  view.rerender(workspace("owner", { ...status, google_email: "new@example.com" }));
  await waitFor(() => expect(signal.aborted).toBe(true));
  await act(async () => finish({ complete: true, meetings: [{ id: "old", title: "Stale private meeting" }] }));
  expect(screen.queryByText("Stale private meeting")).toBeNull();
  cleanup(); vi.restoreAllMocks();
});
