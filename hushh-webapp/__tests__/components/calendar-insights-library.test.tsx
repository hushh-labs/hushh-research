import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ insights: vi.fn(), fileAction: vi.fn(), getIdToken: vi.fn() }));
vi.mock("@/lib/services/calendar-insights-service", () => ({
  CalendarInsightsService: { read: mocks.insights, fileAction: mocks.fileAction },
  CalendarInsightsRequestError: class extends Error { constructor(message: string, readonly status: number) { super(message); } },
  safeMeetingProviderUrl: (value: unknown) => typeof value === "string" && /^https:\/\/(docs|drive)\.google\.com\//.test(value) ? value : null,
}));

import { CalendarInsights } from "@/components/calendar/calendar-insights";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

function insights() {
  return <CalendarInsights userId="owner" account={{ account_id: "default", google_email: "owner@example.com", status: "connected", connected: true, access_level: "manage", calendar_list_access: true }} today="2026-10-14" zone="UTC" getIdToken={mocks.getIdToken} />;
}

const meetingGrant = "b".repeat(64);
function meetingRow(id: string, title: string, kinds: ("recording" | "notes")[]) {
  return { id, title, calendar_id: "primary", account_id: "default", occurrence_id: id.repeat(64).slice(0, 64), grant_id: meetingGrant,
    sources: [{ calendar_id: "primary", event_id: id }], artifact_kinds: kinds,
    start: { dateTime: "2026-10-14T10:00:00Z" } };
}
function meetingPage(meetings: ReturnType<typeof meetingRow>[], complete = true, date = "2026-10-14", timeZone = "UTC") {
  return { complete, next_cursor: null, date, time_zone: timeZone, account_id: "default",
    limitations: complete ? [] : ["processing"], checked_events: meetings.length, meetings };
}

describe("Calendar Insights meeting library", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    mocks.getIdToken.mockResolvedValue("firebase-owner-token");
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(["second", "third"])("binds %s account list, detail, open and download to its day and grant", async accountId => {
    const account = { account_id: accountId, google_email: `${accountId}@example.com`,
      status: "connected" as const, connected: true, access_level: "read" as const,
      calendar_list_access: true, grant_generation: accountId };
    const row = { ...meetingRow("a", "Account meeting", ["recording"]), account_id: accountId };
    mocks.insights.mockImplementation(async (path: string, body: { account_id: string; date: string; time_zone: string }) =>
      path === "meetings" ? { ...meetingPage([row], true, body.date, body.time_zone), account_id: body.account_id } :
      path === "meetings/detail" ? { discovery: "checked", complete: true, event: { title: row.title }, artifacts: [
        { file_id: "recording-file", kind: "recording", state: "available", title: "Recording", url: "https://drive.google.com/file/d/recording-file/view", can_download: true },
      ] } : { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    mocks.fileAction.mockResolvedValue("https://drive.google.com/file/d/recording-file/view");
    const replace = vi.fn();
    vi.spyOn(window, "open").mockImplementation(() => ({ location: { replace }, closed: false, close: vi.fn(), opener: null }) as unknown as Window);
    render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC" getIdToken={mocks.getIdToken} />);
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Account meeting/ }));
    await screen.findByText("Recording");
    expect(mocks.insights).toHaveBeenCalledWith("meetings/detail", expect.objectContaining({
      account_id: accountId, calendar_id: "primary", event_id: "a", date: "2026-10-14",
      time_zone: "UTC", expected_grant: meetingGrant, occurrence_id: row.occurrence_id,
    }), "firebase-owner-token", expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(mocks.fileAction).toHaveBeenCalledWith("open", expect.objectContaining({
      account_id: accountId, file_id: "recording-file", date: "2026-10-14", expected_grant: meetingGrant,
    }), "firebase-owner-token", expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(mocks.fileAction).toHaveBeenCalledWith("download", expect.objectContaining({
      account_id: accountId, file_id: "recording-file", date: "2026-10-14", expected_grant: meetingGrant,
    }), "firebase-owner-token", expect.any(AbortSignal)));
    expect(replace).toHaveBeenCalled();
  });

  it("drops a late response after switching Google accounts", async () => {
    let resolveSecond!: (value: ReturnType<typeof meetingPage>) => void;
    const secondPending = new Promise<ReturnType<typeof meetingPage>>(resolve => { resolveSecond = resolve; });
    const account = (id: string) => ({ account_id: id, google_email: `${id}@example.com`,
      status: "connected" as const, connected: true, access_level: "read" as const, calendar_list_access: true });
    mocks.insights.mockImplementation(async (path: string, body: { account_id: string; date: string; time_zone: string }) =>
      path === "meetings" ? body.account_id === "second" ? secondPending :
        { ...meetingPage([meetingRow("t", "Third account file", ["notes"])], true, body.date, body.time_zone), account_id: "third" } :
        { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    const view = render(<CalendarInsights key="second" userId="owner" account={account("second")} today="2026-10-14" zone="UTC" getIdToken={mocks.getIdToken} />);
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    await waitFor(() => expect(mocks.insights).toHaveBeenCalledWith("meetings", expect.objectContaining({ account_id: "second" }), expect.any(String), expect.any(AbortSignal)));
    view.rerender(<CalendarInsights key="third" userId="owner" account={account("third")} today="2026-10-14" zone="UTC" getIdToken={mocks.getIdToken} />);
    resolveSecond(meetingPage([meetingRow("s", "Second account file", ["recording"])], true));
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    expect(await screen.findByRole("button", { name: /Third account file/ })).toBeInTheDocument();
    expect(screen.queryByText("Second account file")).toBeNull();
  });

  it("resolves a sparse continuation before showing a complete empty day", async () => {
    let finish!: (value: ReturnType<typeof meetingPage>) => void;
    const later = new Promise<ReturnType<typeof meetingPage>>(resolve => { finish = resolve; });
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string; cursor?: string }) =>
      path === "meetings" ? body.cursor ? later.then(page => ({ ...page, date: body.date, time_zone: body.time_zone })) : {
        ...meetingPage([], false, body.date, body.time_zone),
        next_cursor: "sealed-next-page", limitations: ["request_budget"],
      } : { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    render(insights());
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    expect(await screen.findByRole("button", { name: "Continue checking this day" })).toBeInTheDocument();
    expect(screen.queryByText("No recordings or notes for this day.")).toBeNull();
    await act(async () => { finish(meetingPage([], true)); });
    expect(await screen.findByText("No recordings or notes for this day.")).toBeInTheDocument();
    expect(screen.queryByText("More meetings remain to be checked. Continue this day.")).toBeNull();
  });

  it("queries the selected local day and filters verified rows on the server", async () => {
    mocks.getIdToken.mockResolvedValue("firebase-owner-token");
    const notes = meetingRow("n", "Design review", ["notes"]);
    const recording = meetingRow("r", "Product demo", ["recording"]);
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string; kind: string; query: string }) => {
      if (path === "meetings") return meetingPage([notes, recording].filter(row =>
        (body.kind === "all" || row.artifact_kinds.includes(body.kind as "notes" | "recording")) &&
        row.title.toLowerCase().includes((body.query || "").toLowerCase())), true, body.date, body.time_zone);
      if (path === "meetings/detail") return { discovery: "permission_required", complete: false, event: { title: "Design review" }, artifacts: [{ file_id: "revoked", kind: "notes", state: "permission_required" }] };
      return { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 };
    });
    render(insights());
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    await screen.findByRole("button", { name: /Design review/ });
    expect(mocks.insights).toHaveBeenCalledWith("meetings", expect.objectContaining({ account_id: "default", date: "2026-10-14", time_zone: expect.any(String) }), "firebase-owner-token", expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("tab", { name: "Notes", exact: true }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Product demo/ })).toBeNull());
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Design" } });
    fireEvent.click(await screen.findByRole("button", { name: /Design review/ }));
    expect(await screen.findByText(/Allow recording and notes access/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ask One about this meeting/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    act(() => { unwindBackLayer("/one/calendar"); });
    expect(screen.getByRole("searchbox")).toHaveValue("Design");
  });

  it("shows complete empty only after a complete check and switches the local day", async () => {
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string }) => path === "meetings" ?
      { ...meetingPage([], true, body.date, body.time_zone), complete: body.date === "2026-10-15", limitations: body.date === "2026-10-15" ? [] : ["permission_required"] } :
      { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    render(insights());
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    await screen.findByText(/Allow recording and notes access/);
    expect(screen.queryByText("No recordings or notes for this day.")).toBeNull();
    fireEvent.change(screen.getByLabelText("Recording and notes date"), { target: { value: "2026-10-15" } });
    expect(await screen.findByText("No recordings or notes for this day.")).toBeInTheDocument();
    expect(mocks.insights).toHaveBeenCalledWith("meetings", expect.objectContaining({ date: "2026-10-15" }), expect.any(String), expect.any(AbortSignal));
  });

  it("refreshes late notes and removes revoked detail without showing transcript or chat actions", async () => {
    let generation = 0;
    const row = meetingRow("l", "Late files", ["recording", "notes"]);
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string }) => path === "meetings" ? meetingPage(generation ? [row] : [], generation > 0, body.date, body.time_zone) : path === "meetings/detail" ?
      { discovery: generation === 3 ? "permission_required" : "checked", complete: generation !== 3, event: { title: "Late files" },
        artifacts: generation === 3 ? [{ file_id: "n", kind: "notes", state: "permission_required" }] : [
          { file_id: "r", kind: "recording", state: "available", title: "Recording", url: "https://drive.google.com/file/d/r/view", can_download: true },
          { file_id: "n", kind: "notes", state: "available", title: "Meeting notes", text: generation === 1 ? "Original provider notes" : "Updated provider notes", text_format: "plain", url: "https://docs.google.com/document/d/n", can_download: false },
          { file_id: "t", kind: "transcript", state: "available", text: "Transcript must stay hidden" },
        ] } : { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    render(insights());
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    await screen.findByText(/Google is still preparing meeting files/);
    generation = 1;
    fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: /Late files/ }));
    await screen.findByText("Original provider notes");
    expect(screen.queryByText("Transcript must stay hidden")).toBeNull();
    expect(screen.queryByRole("button", { name: /Ask One about this meeting/ })).toBeNull();
    generation = 2;
    fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
    await screen.findByText("Updated provider notes");
    generation = 3;
    fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
    await waitFor(() => expect(screen.queryByText("Updated provider notes")).toBeNull());
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });
});
