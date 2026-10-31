import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ insights: vi.fn(), requestStatuses: vi.fn(), approvedDetail: vi.fn(), getIdToken: vi.fn() }));
vi.mock("@/lib/services/calendar-insights-service", () => ({
  CalendarInsightsService: { read: mocks.insights, fileAction: vi.fn(), requestFiles: vi.fn(),
    requestStatuses: mocks.requestStatuses, approvedDetail: mocks.approvedDetail, approvedFileAction: vi.fn() },
  CalendarInsightsRequestError: class extends Error { constructor(message: string, readonly status: number, readonly code?: string) { super(message); } },
  safeMeetingProviderUrl: (value: unknown) => typeof value === "string" && value.startsWith("https://docs.google.com/") ? value : null,
}));
vi.mock("@/components/calendar/calendar-followups", () => ({ CalendarFollowups: () => null }));

import { CalendarInsights } from "@/components/calendar/calendar-insights";
import { CacheService } from "@/lib/services/cache-service";

const grant = "b".repeat(64);
const occurrence = "a".repeat(64);
const row = {
  id: "a", title: "Growth Sync", calendar_id: "primary", account_id: "default", occurrence_id: occurrence, grant_id: grant,
  sources: [{ calendar_id: "primary", event_id: "a" }], artifact_kinds: [] as string[], availability: {},
  discovery: "checked", file_state: "unknown", start: { dateTime: "2026-10-14T10:00:00Z" },
};
const account = { account_id: "default", google_email: "owner@example.com", status: "connected" as const, connected: true,
  access_level: "manage" as const, calendar_list_access: true, grant_generation: "g" };
const requestId = "11111111-1111-4111-8111-111111111111";
const outcome = (status: string, available = false) => ({
  occurrence_id: occurrence,
  requests: status ? [{ requestId, status, requestedTypes: ["notes"] }] : [],
  artifacts: available ? [{ kind: "notes", state: "available" }] : [],
});
const SHARING = "Sharing · checking access with your selected Google account.";
const CHECKING = "Drive finished sharing · checking access with your selected Google account.";
const SETTLED_UNVERIFIED = "Drive finished sharing, but file access is not currently verified for this account.";

async function openLibrary() {
  render(<CalendarInsights userId="owner" account={account} today="2026-10-14" zone="UTC"
    getIdToken={mocks.getIdToken} getVaultOwnerToken={() => "vault-owner-token"} />);
  fireEvent.click(screen.getByRole("button", { name: /Recordings & Notes/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const statusReads = () => mocks.requestStatuses.mock.calls.length;

describe("requester Calendar follows an approved request until access is verified", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    CacheService.getInstance().clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-14T18:00:00Z"));
    mocks.getIdToken.mockResolvedValue("firebase-owner-token");
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string }) =>
      path === "meetings"
        ? { complete: true, calendar_complete: true, next_cursor: null, date: body.date, time_zone: body.time_zone, account_id: "default",
            limitations: [], checked_events: 1, meetings: [row], meeting_file_access: "ready" }
        : { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    mocks.approvedDetail.mockResolvedValue({ event: { title: "Growth Sync" }, discovery: "checked", complete: true, artifacts: [] });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("shows Sharing, not Available, while approved, then Available once the requester's own access verifies", async () => {
    let verified = false;
    mocks.requestStatuses.mockImplementation(async () => [verified ? outcome("completed", true) : outcome("approved")]);
    await openLibrary();
    expect(screen.getByText(SHARING)).toBeInTheDocument();
    expect(screen.getByText("Not available yet (1)")).toBeInTheDocument();
    expect(screen.queryByText(/Available \(/)).toBeNull();

    // A queued job or approval alone never makes it Available.
    await advance(6_000);
    expect(statusReads()).toBeGreaterThan(1);
    expect(screen.getByText(SHARING)).toBeInTheDocument();
    expect(screen.queryByText(/Available \(/)).toBeNull();

    verified = true;
    await advance(6_000);
    expect(screen.getByText(/Available \(1\)/)).toBeInTheDocument();
    expect(screen.queryByText(SHARING)).toBeNull();

    // Verified, so the fast follow-up stops by itself.
    const reads = statusReads();
    await advance(30_000);
    expect(statusReads()).toBe(reads);
  });

  it("says Drive finished while it checks, and does not call that failure", async () => {
    mocks.requestStatuses.mockResolvedValue([outcome("completed")]);
    await openLibrary();
    expect(screen.getByText(CHECKING)).toBeInTheDocument();
    expect(screen.queryByText(SETTLED_UNVERIFIED)).toBeNull();
  });

  it("stops after a bounded number of checks and then states the unverified result honestly", async () => {
    mocks.requestStatuses.mockResolvedValue([outcome("completed")]);
    await openLibrary();
    // One step per check: React must commit between timers for the next check to be armed.
    for (let step = 0; step < 25; step += 1) await advance(6_000);
    expect(screen.getByText(SETTLED_UNVERIFIED)).toBeInTheDocument();
    expect(screen.queryByText(CHECKING)).toBeNull();
    // The fast follow-up is bounded (the slower periodic refresh is separate).
    const reads = statusReads();
    for (let step = 0; step < 5; step += 1) await advance(6_000);
    expect(statusReads() - reads).toBeLessThanOrEqual(1);
    expect(screen.queryByText(/Available \(/)).toBeNull();
  });

  it.each(["pending", "preparing", "review_ready", "declined", "failed", ""])(
    "does not poll quickly for a request that is %j", async status => {
      mocks.requestStatuses.mockResolvedValue([outcome(status)]);
      await openLibrary();
      const reads = statusReads();
      await advance(30_000);
      expect(statusReads()).toBe(reads);
    });

  it("keeps the meeting visible and the list in place through each re-check", async () => {
    mocks.requestStatuses.mockResolvedValue([outcome("approved")]);
    await openLibrary();
    const link = screen.getByRole("button", { name: /Growth Sync/ });
    await advance(6_000);
    await advance(6_000);
    expect(screen.getByRole("button", { name: /Growth Sync/ })).toBe(link);
    expect(screen.queryByText(/Checking your meetings/)).toBeNull();
  });
});

describe("requester stays on the meeting while access is verified", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    CacheService.getInstance().clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-14T18:00:00Z"));
    mocks.getIdToken.mockResolvedValue("firebase-owner-token");
    mocks.insights.mockImplementation(async (path: string, body: { date: string; time_zone: string }) =>
      path === "meetings"
        ? { complete: true, calendar_complete: true, next_cursor: null, date: body.date, time_zone: body.time_zone, account_id: "default",
            limitations: [], checked_events: 1, meetings: [row], meeting_file_access: "ready" }
        : { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  const file = { file_id: "approvednote123", kind: "notes", state: "available", title: "Approved note",
    url: "https://docs.google.com/document/d/approvednote123/edit", can_download: false };

  it("moves the visible request status to the verified outcome and stops checking", async () => {
    let verified = false;
    mocks.requestStatuses.mockImplementation(async () => [verified ? outcome("completed", true) : outcome("approved")]);
    mocks.approvedDetail.mockImplementation(async () => ({ event: { title: "Growth Sync" }, discovery: "checked", complete: true,
      artifacts: verified ? [file] : [] }));
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: /Growth Sync/ }));
    await advance(50);
    expect(screen.getAllByText(SHARING).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();

    verified = true;
    await advance(6_000);
    expect(screen.getByRole("button", { name: /^Open/ })).toBeInTheDocument();
    // The status line must not keep claiming that access is still being checked.
    expect(screen.queryAllByText(SHARING)).toHaveLength(0);
    expect(screen.queryAllByText(CHECKING)).toHaveLength(0);

    const reads = mocks.approvedDetail.mock.calls.length;
    await advance(30_000);
    expect(mocks.approvedDetail.mock.calls.length).toBe(reads);
  });
});
