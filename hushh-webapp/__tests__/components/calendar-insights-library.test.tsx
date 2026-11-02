import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ insights: vi.fn(), fileAction: vi.fn(), getIdToken: vi.fn(),
  requestFiles: vi.fn(), requestReadiness: vi.fn(), requestStatuses: vi.fn(), approvedDetail: vi.fn(), approvedFileAction: vi.fn() }));
vi.mock("@/lib/services/calendar-insights-service", () => ({
  CalendarInsightsService: { read: mocks.insights, fileAction: mocks.fileAction,
    requestFiles: mocks.requestFiles, requestReadiness: mocks.requestReadiness, requestStatuses: mocks.requestStatuses,
    approvedDetail: mocks.approvedDetail, approvedFileAction: mocks.approvedFileAction },
  CalendarInsightsRequestError: class extends Error { constructor(message: string, readonly status: number, readonly code?: string) { super(message); } },
  safeMeetingProviderUrl: (value: unknown) => typeof value === "string" && /^https:\/\/(docs|drive)\.google\.com\//.test(value) ? value : null,
}));
// Meeting-library regressions keep the separate Follow-ups detail surface out
// of this fixture; its account and consent behavior has dedicated tests.
vi.mock("@/components/calendar/calendar-followups", () => ({ CalendarFollowups: () => null }));

import { CalendarInsights } from "@/components/calendar/calendar-insights";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { CacheService } from "@/lib/services/cache-service";

function insights(onAllowMeetingFiles?: (accountId: string) => void) {
  return <CalendarInsights userId="owner" account={{ account_id: "default", google_email: "owner@example.com", status: "connected", connected: true, access_level: "manage", calendar_list_access: true }} today="2026-10-14" zone="UTC" getIdToken={mocks.getIdToken} onAllowMeetingFiles={onAllowMeetingFiles} />;
}

const meetingGrant = "b".repeat(64);
function meetingRow(id: string, title: string, kinds: ("recording" | "notes")[]) {
  return { id, title, calendar_id: "primary", account_id: "default", occurrence_id: id.repeat(64).slice(0, 64), grant_id: meetingGrant,
    sources: [{ calendar_id: "primary", event_id: id }], artifact_kinds: kinds,
    availability: {}, discovery: "checked", file_state: kinds.length ? "available" : "unknown",
    start: { dateTime: "2026-10-14T10:00:00Z" } };
}
function meetingPage(meetings: ReturnType<typeof meetingRow>[], complete = true, date = "2026-10-14", timeZone = "UTC") {
  return { complete, calendar_complete: complete, next_cursor: null, date, time_zone: timeZone, account_id: "default",
    limitations: complete ? [] : ["processing"], checked_events: meetings.length, meetings,
    meeting_file_access: "ready" as const };
}

describe("Calendar Insights meeting library", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    CacheService.getInstance().clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    mocks.getIdToken.mockResolvedValue("firebase-owner-token");
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(["calendar-B", "calendar-C"])("requests from selected %s without making approval look available", async accountId => {
    const account = { account_id: accountId, google_email: `${accountId.toLowerCase()}@example.invalid`,
      status: "connected" as const, connected: true, access_level: "read" as const,
      calendar_list_access: true, grant_generation: accountId };
    const rows = ["a", "b", "c", "d", "e"].map((id, index) => ({
      ...meetingRow(id, `Meeting ${index + 1}`, []), account_id: accountId,
    }));
    let accessVerified = false;
    mocks.insights.mockImplementation(async (path: string, body: { account_id: string; date: string; time_zone: string }) =>
      path === "meetings" ? { ...meetingPage(rows, true, body.date, body.time_zone), account_id: body.account_id } :
      { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    mocks.approvedDetail.mockResolvedValue({ event: { title: "Meeting 1" }, discovery: "checked", complete: true, artifacts: [] });
    mocks.requestStatuses.mockImplementation(async (selections: { occurrence_id: string }[]) => selections.map(selection => ({
      occurrence_id: selection.occurrence_id,
      requests: accessVerified && selection.occurrence_id === rows[0]?.occurrence_id ?
        [{ requestId: "11111111-1111-4111-8111-111111111111", status: "completed", requestedTypes: ["notes"] }] : [],
      artifacts: accessVerified && selection.occurrence_id === rows[0]?.occurrence_id ? [{ kind: "notes", state: "available" }] : [],
    })));
    mocks.requestReadiness.mockResolvedValue("ready");
    mocks.requestFiles.mockResolvedValue({ requestId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: account.google_email, status: "pending" });
    render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
      getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"} />);
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    expect(await screen.findByText("Not available yet (5)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Meeting 1/ }));
    // What would you like to request? Notes, then the one action: Ask organizer.
    fireEvent.click(await screen.findByRole("tab", { name: "Notes" }));
    // The connection is checked silently for the selected account's own meeting before Ask can send.
    await waitFor(() => expect(mocks.requestReadiness).toHaveBeenCalled());
    expect(mocks.requestReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: accountId, event_id: "a", occurrence_id: rows[0]?.occurrence_id,
        expected_grant: meetingGrant, date: "2026-10-14", time_zone: "UTC" }),
      "firebase-owner-token", "vault-owner-token", expect.anything());
    expect(mocks.requestFiles).not.toHaveBeenCalled(); // choosing is not asking
    fireEvent.click(await screen.findByRole("button", { name: "Ask organizer" }));
    await waitFor(() => expect(mocks.requestFiles).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: accountId, event_id: "a", occurrence_id: rows[0]?.occurrence_id,
        expected_grant: meetingGrant }), ["notes"], "firebase-owner-token", "vault-owner-token",
    ));
    fireEvent.click(screen.getByRole("button", { name: "Back to recordings and notes" }));
    expect(screen.getByText("Not available yet (5)")).toBeInTheDocument();
    accessVerified = true;
    act(() => dispatchFeedStateChanged("arrived"));
    expect(await screen.findByText("Available (1)")).toBeInTheDocument();
    expect(screen.getByText("Not available yet (4)")).toBeInTheDocument();
  });

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

  it("shows both files from two verified Calendar copies and downloads through the file's source", async () => {
    const row = { ...meetingRow("a", "Shared occurrence", ["recording", "notes"]),
      sources: [{ calendar_id: "primary", event_id: "a" }, { calendar_id: "shared", event_id: "copy-a" }] };
    mocks.insights.mockImplementation(async (path: string, body: { event_id?: string; date: string; time_zone: string }) => {
      if (path === "meetings") return meetingPage([row], true, body.date, body.time_zone);
      if (path === "meetings/detail") return { discovery: "checked", complete: true, event: { title: row.title }, artifacts: [
        body.event_id === "a"
          ? { file_id: "recording-file", kind: "recording", state: "available", title: "Recording", url: "https://drive.google.com/file/d/recording-file/view", can_download: true }
          : { file_id: "note-file", kind: "notes", state: "available", title: "Meeting notes", url: "https://docs.google.com/document/d/note-file/edit", can_download: true },
      ] };
      return { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 };
    });
    mocks.fileAction.mockResolvedValue("https://docs.google.com/document/d/note-file/export?format=pdf");
    vi.spyOn(window, "open").mockReturnValue({ location: { replace: vi.fn() }, closed: false, close: vi.fn(), opener: null } as unknown as Window);
    render(insights());
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Shared occurrence/ }));
    expect(await screen.findByText("Recording")).toBeInTheDocument();
    expect(await screen.findAllByText("Meeting notes")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Download" })[1]);
    await waitFor(() => expect(mocks.fileAction).toHaveBeenCalledWith("download", expect.objectContaining({
      calendar_id: "shared", event_id: "copy-a", file_id: "note-file", occurrence_id: row.occurrence_id,
    }), "firebase-owner-token", expect.any(AbortSignal)));
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
    expect(screen.queryByText("No timed meetings for this day.")).toBeNull();
    await act(async () => { finish(meetingPage([], true)); });
    expect(await screen.findByText("No timed meetings for this day.")).toBeInTheDocument();
    expect(screen.queryByText("More meetings remain to be checked. Continue this day.")).toBeNull();
  });

  it("queries the selected local day and keeps meetings visible when focusing a file type", async () => {
    mocks.getIdToken.mockResolvedValue("firebase-owner-token");
    const notes = meetingRow("n", "Design review", ["notes"]);
    const recording = meetingRow("r", "Product demo", ["recording"]);
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string; kind: string; query: string }) => {
      if (path === "meetings") return meetingPage([notes, recording].filter(row =>
        row.title.toLowerCase().includes((body.query || "").toLowerCase())), true, body.date, body.time_zone);
      if (path === "meetings/detail") return { discovery: "permission_required", complete: false, event: { title: "Design review" }, artifacts: [{ file_id: "revoked", kind: "notes", state: "permission_required" }] };
      return { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 };
    });
    render(insights());
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    await screen.findByRole("button", { name: /Design review/ });
    expect(mocks.insights).toHaveBeenCalledWith("meetings", expect.objectContaining({ account_id: "default", date: "2026-10-14", time_zone: expect.any(String) }), "firebase-owner-token", expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("tab", { name: "Notes", exact: true }));
    expect(await screen.findByRole("button", { name: /Product demo/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Design" } });
    fireEvent.click(await screen.findByRole("button", { name: /Design review/ }));
    expect(await screen.findByText(/Allow recording and notes access/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ask One about this meeting/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    act(() => { unwindBackLayer("/one/calendar"); });
    expect(screen.getByRole("searchbox")).toHaveValue("Design");
  });

  it("shows complete empty only after a complete check and switches the local day", async () => {
    const allow = vi.fn();
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string }) => path === "meetings" ?
      { ...meetingPage([], true, body.date, body.time_zone), complete: body.date === "2026-10-15", limitations: body.date === "2026-10-15" ? [] : ["permission_required"], meeting_file_access: body.date === "2026-10-15" ? "ready" : "missing" } :
      { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    render(insights(allow));
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    await screen.findByRole("button", { name: "Allow recording and notes access" });
    fireEvent.click(screen.getByRole("button", { name: "Allow recording and notes access" }));
    expect(allow).toHaveBeenCalledWith("default", expect.objectContaining({ day: "2026-10-14", timeZone: "UTC" }));
    expect(screen.getByText("No timed meetings for this day.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Recording and notes date"), { target: { value: "2026-10-15" } });
    expect(await screen.findByText("No timed meetings for this day.")).toBeInTheDocument();
    expect(mocks.insights).toHaveBeenCalledWith("meetings", expect.objectContaining({ date: "2026-10-15" }), expect.any(String), expect.any(AbortSignal));
  });

  it("never offers another consent when a ready account hits a resource denial", async () => {
    const allow = vi.fn();
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string }) => path === "meetings" ?
      { ...meetingPage([], false, body.date, body.time_zone), limitations: ["meet_discovery_denied"] } :
      { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    render(insights(allow));
    fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
    expect(await screen.findByText(/Google denied the Meet discovery check/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow recording and notes access" })).toBeNull();
    expect(screen.queryByText("No timed meetings for this day.")).toBeNull();
    expect(allow).not.toHaveBeenCalled();
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

  it("keeps library controls in place during a cold check without large loading cards", () => {
    mocks.insights.mockReturnValue(new Promise(() => undefined));
    render(<CalendarInsights userId="owner" account={{ account_id: "default", connected: true, status: "connected", access_level: "read" }}
      today="2026-10-14" zone="UTC" getIdToken={mocks.getIdToken}
      initialLibrary={{ accountId: "default", day: "2026-10-14", timeZone: "UTC", query: "", filter: "all" }} />);
    expect(screen.getByRole("heading", { name: "Recordings & Notes" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search meetings on this day" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Notes", exact: true })).toBeInTheDocument();
    expect(screen.getByText("Checking meetings…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Insights loading")).toBeNull();
  });

  it("shows a warm same-grant day immediately and replaces it after refresh", async () => {
    const old = meetingRow("o", "Older verified meeting", ["notes"]);
    const newer = meetingRow("n", "Updated verified meeting", ["recording"]);
    let resolveRefresh!: (value: ReturnType<typeof meetingPage>) => void;
    let meetingReads = 0;
    mocks.insights.mockImplementation((path: string) => path === "meetings"
      ? ++meetingReads === 1 ? Promise.resolve(meetingPage([old])) :
        new Promise(resolve => { resolveRefresh = resolve; })
      : Promise.resolve({ complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 }));
    const props = { userId: "owner", account: { account_id: "default", connected: true, status: "connected" as const, access_level: "read" as const, grant_generation: "grant-one" },
      today: "2026-10-14", zone: "UTC", getIdToken: mocks.getIdToken,
      initialLibrary: { accountId: "default", day: "2026-10-14", timeZone: "UTC", query: "", filter: "all" as const } };
    const first = render(<CalendarInsights {...props} />);
    await screen.findByRole("button", { name: /Older verified meeting/ });
    first.unmount();
    render(<CalendarInsights {...props} />);
    expect(screen.getByRole("button", { name: /Older verified meeting/ })).toBeInTheDocument();
    await waitFor(() => expect(meetingReads).toBe(2));
    await act(async () => resolveRefresh(meetingPage([newer])));
    expect(await screen.findByRole("button", { name: /Updated verified meeting/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Older verified meeting/ })).toBeNull();
  });

  it("keeps a same-context snapshot visible after its fresh TTL while revalidating", async () => {
    const row = meetingRow("w", "Warm meeting", ["notes"]);
    let resolveRefresh!: (value: ReturnType<typeof meetingPage>) => void;
    let reads = 0;
    mocks.insights.mockImplementation((path: string) => path === "meetings"
      ? ++reads === 1 ? Promise.resolve(meetingPage([row])) : new Promise(resolve => { resolveRefresh = resolve; })
      : Promise.resolve({ complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 }));
    const props = { userId: "owner", account: { account_id: "default", connected: true, status: "connected" as const, access_level: "read" as const },
      today: "2026-10-14", zone: "UTC", getIdToken: mocks.getIdToken,
      initialLibrary: { accountId: "default", day: "2026-10-14", timeZone: "UTC", query: "", filter: "all" as const } };
    const first = render(<CalendarInsights {...props} />);
    await screen.findByRole("button", { name: /Warm meeting/ });
    first.unmount();
    vi.setSystemTime(new Date("2026-10-14T06:01:01Z"));
    render(<CalendarInsights {...props} />);
    expect(screen.getByRole("button", { name: /Warm meeting/ })).toBeInTheDocument();
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => resolveRefresh(meetingPage([row])));
  });

  it("retires approved availability when request-status verification fails on refresh", async () => {
    const row = meetingRow("v", "Revoked request meeting", []);
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string }) =>
      path === "meetings" ? meetingPage([row], true, body.date, body.time_zone) :
        { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    let denied = false;
    mocks.requestStatuses.mockImplementation(async (selections: { occurrence_id: string }[]) => {
      if (denied) throw new Error("Access could not be verified");
      return selections.map(item => ({ occurrence_id: item.occurrence_id, requests: [], artifacts: [{ kind: "notes", state: "available" }] }));
    });
    render(<CalendarInsights userId="owner" account={{ account_id: "default", connected: true, status: "connected", access_level: "read" }}
      today="2026-10-14" zone="UTC" getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"}
      initialLibrary={{ accountId: "default", day: "2026-10-14", timeZone: "UTC", query: "", filter: "all" }} />);
    expect(await screen.findByText("Available (1)")).toBeInTheDocument();
    denied = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
    expect(await screen.findByText("Not available yet (1)")).toBeInTheDocument();
    expect(screen.queryByText("Available (1)")).toBeNull();
    expect(screen.getByText(/request status could not be verified/)).toBeInTheDocument();
  });

  it("retains the last overview through a transient refresh failure", async () => {
    let reads = 0;
    mocks.insights.mockImplementation(async () => {
      if (++reads > 1) throw new Error("temporary network failure");
      return { complete: true, meeting_count: 7, meeting_minutes: 420, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 };
    });
    render(insights());
    expect(await screen.findByText("7", { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent("temporary network failure");
    expect(screen.getByText("7", { exact: true })).toBeInTheDocument();
  });

  it("debounces typing into one selected-day request", async () => {
    const row = meetingRow("a", "Alpha meeting", []);
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string; query?: string }) =>
      path === "meetings" ? meetingPage(body.query ? [row] : [row], true, body.date, body.time_zone) :
      { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    render(<CalendarInsights userId="owner" account={{ account_id: "default", connected: true, status: "connected", access_level: "read" }}
      today="2026-10-14" zone="UTC" getIdToken={mocks.getIdToken}
      initialLibrary={{ accountId: "default", day: "2026-10-14", timeZone: "UTC", query: "", filter: "all" }} />);
    await screen.findByRole("button", { name: /Alpha meeting/ });
    const reads = () => mocks.insights.mock.calls.filter(([path]) => path === "meetings").length;
    const initialReads = reads();
    for (const value of ["A", "Al", "Alpha"]) fireEvent.change(screen.getByRole("searchbox"), { target: { value } });
    expect(reads()).toBe(initialReads);
    expect(screen.getByText("Searching meetings…")).toBeInTheDocument();
    await waitFor(() => expect(reads()).toBe(initialReads + 1));
  });
});
