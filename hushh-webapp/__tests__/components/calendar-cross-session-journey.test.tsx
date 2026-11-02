/**
 * CONTROLLED cross-session journey for Calendar recordings and notes.
 *
 * Two separate people, each with their own tokens and their own mounted page,
 * run against ONE shared in-memory model of the server (see
 * ../fixtures/calendar-meeting-world.ts). The real client services run against
 * it at the HTTP boundary. No local browser event crosses between them: the
 * organizer's page never dispatches anything the requester's page listens to,
 * so the requester only learns of the outcome by asking the server.
 *
 * This proves the client behaves correctly against the API contract. It is NOT
 * live Google sharing and it cannot show that a Drive file was really shared;
 * that still needs a run with real accounts.
 */
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarMeetingWorld } from "../fixtures/calendar-meeting-world";

const bridge = vi.hoisted(() => ({
  world: null as unknown as InstanceType<typeof import("../fixtures/calendar-meeting-world").CalendarMeetingWorld>,
  userId: "", token: "", getToken: () => bridge.token,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: bridge.userId }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true, getVaultOwnerToken: bridge.getToken }) }));
vi.mock("@/lib/services/drive-sharing-service", () => ({ DriveSharingService: {
  status: (token: string, id: string) => bridge.world.driveStatus(token, id),
  review: (token: string, id: string) => bridge.world.driveReview(token, id),
  approve: (token: string, id: string, review: { reviewDigest: string }, guard: unknown, files: string[]) =>
    bridge.world.driveApprove(token, id, review, guard, files),
  decide: (token: string, id: string) => bridge.world.driveDecide(token, id),
} }));
vi.mock("@/components/consent/document-share-review", () => ({ DocumentShareReview: () => <div data-testid="ordinary-drive-review" /> }));
vi.mock("@/components/calendar/calendar-followups", () => ({ CalendarFollowups: () => null }));

import { CalendarInsights } from "@/components/calendar/calendar-insights";
import { DocumentRequestReviewRouter } from "@/components/consent/calendar-meeting-review-card";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { ApiService } from "@/lib/services/api-service";
import { CacheService } from "@/lib/services/cache-service";
import { CalendarInsightsRequestError, CalendarInsightsService } from "@/lib/services/calendar-insights-service";
import { CalendarMeetingReviewService } from "@/lib/services/calendar-meeting-review-service";

const SHARING = "Checking access…";
const SENT = "Request sent · Waiting for organizer";
const UNVERIFIED = "Sharing finished, but this account's access isn't verified yet.";
const HINT = "Requests work once you're connected on One.";
const NO_RECORDING = "The organizer says they don't have the recording.";
let world: CalendarMeetingWorld;

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** Time passing in one-second steps, so React commits (and arms the next timer) between them. */
async function elapse(ms: number) { for (let spent = 0; spent < ms; spent += 1_000) await advance(1_000); }

/** The requester's own Calendar page, signed in as the requester only. */
function mountRequester() {
  const view = render(<CalendarInsights userId={world.requester.userId} today="2026-10-14" zone="UTC"
    account={{ account_id: "default", google_email: world.requester.googleEmail, status: "connected", connected: true,
      access_level: "read", calendar_list_access: true }}
    getIdToken={async () => world.requester.idToken} getVaultOwnerToken={() => world.requester.vaultToken} />);
  return { ...view, ui: within(view.container) };
}
async function openLibrary(ui: ReturnType<typeof within>) {
  fireEvent.click(ui.getByRole("button", { name: /Recordings & Notes/ }));
  await advance(50);
}
async function requesterSends(ui: ReturnType<typeof within>, kinds: ("Recording" | "Notes")[]) {
  if (!ui.queryByRole("button", { name: /Hussh Growth Sync/ })) await openLibrary(ui);
  fireEvent.click(ui.getByRole("button", { name: /Hussh Growth Sync/ }));
  await advance(50);
  await chooseAndAsk(ui, kinds);
}
/** What would you like to request? Recording, Notes or Both, then the one action: Ask organizer. */
async function chooseAndAsk(ui: ReturnType<typeof within>, kinds: ("Recording" | "Notes")[]) {
  const only = ui.queryByRole("tab", { name: "Both" }) === null;
  if (!only) fireEvent.click(ui.getByRole("tab", { name: kinds.length === 2 ? "Both" : kinds[0] }));
  fireEvent.click(ui.getByRole("button", { name: "Ask organizer" }));
  await advance(50);
}

/** An organizer page, signed in as `person` (the organizer by default). */
function mountOrganizer(person: { userId: string; vaultToken: string } = world.organizer, requestId = world.request().requestId) {
  bridge.userId = person.userId; bridge.token = person.vaultToken;
  const onChanged = vi.fn();
  const view = render(<DocumentRequestReviewRouter requestId={requestId} onChanged={onChanged} />);
  return { ...view, ui: within(view.container), onChanged };
}
async function organizerPrepares(ui: ReturnType<typeof within>) {
  await advance(50);
  // Give access starts the exact-file step; the files Google links to this meeting are checked for them.
  fireEvent.click(ui.getByRole("button", { name: "Give access" }));
  await advance(50);
  for (const checkbox of ui.getAllByRole("checkbox", { name: /Hussh Growth Sync (recording|notes)/ })) fireEvent.click(checkbox);
  fireEvent.click(ui.getByRole("checkbox", { name: /I confirm these exact files belong/ }));
  fireEvent.click(ui.getByRole("button", { name: "Prepare exact-file review" }));
  await advance(50);
  expect(ui.getByText("Final file and recipient review")).toBeInTheDocument();
}
function organizerConfirms(ui: ReturnType<typeof within>) {
  for (const checkbox of ui.getAllByRole("checkbox", { name: /^Hussh Growth Sync (recording|notes)$/ })) fireEvent.click(checkbox);
  fireEvent.click(ui.getByRole("checkbox", { name: /I confirm these selected files/ }));
}
const giveAccess = (ui: ReturnType<typeof within>) => fireEvent.click(ui.getByRole("button", { name: "Give access" }));

describe("Calendar recordings and notes: requester and organizer as separate sessions (controlled, not live Google)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheService.getInstance().clear();
    world = new CalendarMeetingWorld();
    bridge.world = world;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    vi.spyOn(ApiService, "apiFetch").mockImplementation((path: string, init?: RequestInit) => world.fetch(path, init));
  });
  afterEach(() => {
    // The model answers every call the client makes; a stray route means a contract drift.
    expect(world.unhandled).toEqual([]);
    cleanup(); vi.useRealTimers(); vi.restoreAllMocks();
  });

  it("carries a recording request from the requester to the organizer and back, updating the requester on its own", async () => {
    const requester = mountRequester();
    await openLibrary(requester.ui);
    // Already accessible: the meeting the selected account can open is Available without any request.
    expect(requester.ui.getByText("Available (1)")).toBeInTheDocument();
    expect(requester.ui.getByText("Not available yet (1)")).toBeInTheDocument();
    expect(world.requests.size).toBe(0);

    await requesterSends(requester.ui, ["Recording"]);
    const { requestId } = world.request();
    // The browser sends only the verified selection and the type. The organizer and the recipient are derived by the server.
    expect(world.sentBodies).toHaveLength(1);
    expect(Object.keys(world.sentBodies[0]).sort()).toEqual(
      ["account_id", "calendar_id", "date", "event_id", "expected_grant", "occurrence_id", "requested_types", "time_zone"]);
    expect(JSON.stringify(world.sentBodies[0])).not.toMatch(/@/);
    expect(world.sentBodies[0].requested_types).toEqual(["recording"]);
    // The selected Google account stays the recipient, not the account used to sign in to One.
    expect(world.request().recipientEmail).toBe(world.requester.googleEmail);
    expect(world.request().recipientEmail).not.toBe(world.requester.oneEmail);
    // Durable, and addressed to the verified organizer's Feed only.
    expect(world.feedFor(world.organizer)).toEqual([requestId]);
    expect(world.feedFor(world.requester)).toEqual([]);
    expect(requester.ui.getAllByText(SENT).length).toBeGreaterThan(0);
    // The organizer is asked in their own Feed; the requester's Feed says the request was sent.
    expect(world.eventsFor(world.organizer).map(event => event.type)).toEqual(["document_share_request"]);
    expect(world.eventsFor(world.requester).map(event => event.type)).toEqual(["document_share_request_sent"]);

    // The organizer opens the exact request in their own session.
    const organizer = mountOrganizer();
    await advance(50);
    expect(organizer.ui.getByText("Hussh Growth Sync")).toBeInTheDocument();
    expect(organizer.ui.getByText(world.requester.googleEmail)).toBeInTheDocument();
    expect(organizer.ui.queryByText(world.requester.oneEmail)).toBeNull();
    await organizerPrepares(organizer.ui);
    organizerConfirms(organizer.ui);
    // One clear final action; a second tap while it runs cannot approve twice.
    giveAccess(organizer.ui);
    expect(organizer.ui.getByRole("button", { name: "Give access" })).toBeDisabled();
    giveAccess(organizer.ui);
    await advance(50);
    expect(world.approvals).toEqual([requestId]);
    expect(organizer.ui.getByText("Sharing…")).toBeInTheDocument();
    expect(organizer.ui.getByRole("link", { name: "Back to Feed" })).toHaveAttribute("href", "/one/feed");
    // Approval and a queued job are not access.
    expect(world.shareCount()).toBe(0);

    // No event reaches the requester's page. Its own periodic check finds the approval, and says Sharing.
    await elapse(62_000);
    expect(requester.ui.getAllByText(SHARING).length).toBeGreaterThan(0);
    expect(requester.ui.queryByRole("button", { name: /^Open/ })).toBeNull();

    // Drive finishes. Still nothing is dispatched to the requester; its quick follow-up asks the server and finds out.
    world.finishSharing();
    await elapse(8_000);
    expect(organizer.ui.getByText("Access given")).toBeInTheDocument();
    expect(requester.ui.getByRole("button", { name: /^Open/ })).toBeInTheDocument();
    expect(requester.ui.queryAllByText(SHARING)).toHaveLength(0);
    // Only the requested recording was shared, with the selected account; metadata access alone is no Download.
    expect(world.shares).toEqual([{ requestId, fileId: world.target.files.recording, to: world.requester.googleEmail }]);
    expect(requester.ui.queryByRole("button", { name: /Download/ })).toBeNull();

    // A later visit restores the association from the server, with no client cache and no new request.
    requester.unmount();
    CacheService.getInstance().clear();
    const later = mountRequester();
    await openLibrary(later.ui);
    expect(later.ui.getByText("Available (2)")).toBeInTheDocument();
    fireEvent.click(later.ui.getByRole("button", { name: /Hussh Growth Sync/ }));
    await advance(50);
    expect(later.ui.getByRole("button", { name: /^Open/ })).toBeInTheDocument();
    expect(world.requests.size).toBe(1);
    later.unmount();

    // Revoked access retires Available on the next visit.
    world.revoke(world.target.files.recording);
    CacheService.getInstance().clear();
    const afterRevoke = mountRequester();
    await openLibrary(afterRevoke.ui);
    expect(afterRevoke.ui.getByText("Available (1)")).toBeInTheDocument();
    expect(afterRevoke.ui.getByText("Not available yet (1)")).toBeInTheDocument();
  });

  it("keeps a request idempotent and refuses a different occurrence or grant", async () => {
    const requester = mountRequester();
    await requesterSends(requester.ui, ["Recording"]);
    const first = world.request().requestId;
    const selection = { account_id: "default", calendar_id: world.target.calendarId, event_id: world.target.eventId,
      occurrence_id: world.target.occurrenceId, expected_grant: world.target.grantId, date: "2026-10-14", time_zone: "UTC" };
    const send = (extra: Partial<typeof selection>, kinds: ("recording" | "notes")[] = ["recording"]) =>
      CalendarInsightsService.requestFiles({ ...selection, ...extra }, kinds, world.requester.idToken, world.requester.vaultToken);

    // A retry, a second tab or a reload returns the same durable request.
    expect((await send({})).requestId).toBe(first);
    expect((await send({})).requestId).toBe(first);
    expect(world.requests.size).toBe(1);
    expect(world.feedFor(world.organizer)).toEqual([first]);

    // A different occurrence or a stale grant never creates or reuses a request.
    for (const wrong of [{ occurrence_id: "f".repeat(64) }, { expected_grant: "e".repeat(64) }, { event_id: "other-event" }]) {
      const failure = await send(wrong).catch(error => error);
      expect(failure).toBeInstanceOf(CalendarInsightsRequestError);
      expect(failure).toMatchObject({ status: 409, code: "calendar_occurrence_changed" });
    }
    expect(world.requests.size).toBe(1);
    // Asking for both after the recording only creates a request for what is outstanding: the notes.
    const both = await send({}, ["recording", "notes"]);
    expect(both.requestId).not.toBe(first);
    expect(both.requestedTypes).toEqual(["notes"]);
    expect(world.requests.size).toBe(2);
    // Asking for both again changes nothing; the organizer is not asked a third time.
    expect([first, both.requestId]).toContain((await send({}, ["recording", "notes"])).requestId);
    expect(world.requests.size).toBe(2);
    expect(world.feedFor(world.organizer)).toHaveLength(2);
  });

  it("offers no Send, and creates nothing, until the requester is connected to the organizer", async () => {
    world.organizerConnected = false;
    const requester = mountRequester();
    await openLibrary(requester.ui);
    fireEvent.click(requester.ui.getByRole("button", { name: /Hussh Growth Sync/ }));
    await advance(50);
    // Same controls as a connected person, but Ask cannot send, and one quiet line goes to Connect.
    fireEvent.click(requester.ui.getByRole("tab", { name: "Recording" }));
    expect(requester.ui.getByRole("button", { name: "Ask organizer" })).toBeDisabled();
    expect(requester.ui.getByRole("link", { name: HINT })).toHaveAttribute("href", "/one/connect");
    expect(requester.ui.queryByRole("button", { name: /^(Connect|Send request|Try again|Copy request|Invite to One)$/ })).toBeNull();
    expect(requester.ui.queryByRole("textbox", { name: "Request to send to the organizer" })).toBeNull();
    expect(requester.ui.queryByTestId("calendar-request-recovery")).toBeNull();
    expect(world.requests.size).toBe(0);
    expect(world.feedFor(world.organizer)).toEqual([]);
    expect(world.sentBodies).toEqual([]);
    expect(world.events).toEqual([]);
  });

  it("waits for a pending connection, then a durable request reaches the organizer's Feed once accepted", async () => {
    world.organizerConnected = false;
    world.connectionPending = true;
    const requester = mountRequester();
    await openLibrary(requester.ui);
    fireEvent.click(requester.ui.getByRole("button", { name: /Hussh Growth Sync/ }));
    await advance(50);
    expect(requester.ui.getByText("Waiting for connection approval.")).toBeInTheDocument();
    expect(requester.ui.getByRole("button", { name: "Ask organizer" })).toBeDisabled();
    expect(requester.ui.queryByRole("link", { name: HINT })).toBeNull();
    expect(world.sentBodies).toEqual([]);

    // The organizer accepts. The requester's page learns of it from the Feed change, not a reload.
    world.organizerConnected = true;
    act(() => dispatchFeedStateChanged("arrived"));
    await advance(50);
    expect(requester.ui.queryByText("Waiting for connection approval.")).toBeNull();
    // Connected now: nothing about connecting shows, and the same Ask sends.
    expect(requester.ui.queryByRole("link", { name: HINT })).toBeNull();
    await chooseAndAsk(requester.ui, ["Recording"]);

    expect(world.requests.size).toBe(1);
    expect(world.feedFor(world.organizer)).toEqual([world.request().requestId]);
    expect(world.request()).toMatchObject({ requester: world.requester.userId, organizer: world.organizer.userId,
      recipientEmail: world.requester.googleEmail, occurrenceId: world.target.occurrenceId, types: ["recording"] });
    expect(requester.ui.getAllByText(SENT).length).toBeGreaterThan(0);
  });

  it("a connection revoked after the check is still refused by the server at Send", async () => {
    const requester = mountRequester();
    await openLibrary(requester.ui);
    fireEvent.click(requester.ui.getByRole("button", { name: /Hussh Growth Sync/ }));
    await advance(50);
    fireEvent.click(requester.ui.getByRole("tab", { name: "Recording" }));
    expect(requester.ui.queryByRole("link", { name: HINT })).toBeNull(); // connected: nothing about connecting
    world.organizerConnected = false;
    fireEvent.click(requester.ui.getByRole("button", { name: "Ask organizer" }));
    await advance(50);
    expect(world.sentBodies).toHaveLength(1);
    // The server's refusal only brings back the one quiet hint; nothing was created.
    expect(requester.ui.getByRole("link", { name: HINT })).toHaveAttribute("href", "/one/connect");
    expect(requester.ui.getByRole("button", { name: "Ask organizer" })).toBeDisabled();
    expect(requester.ui.queryByTestId("calendar-request-recovery")).toBeNull();
    expect(world.requests.size).toBe(0);
    expect(world.feedFor(world.organizer)).toEqual([]);
  });

  it("shows request details only to the addressed organizer", async () => {
    const requester = mountRequester();
    await requesterSends(requester.ui, ["Recording"]);

    const stranger = mountOrganizer(world.stranger);
    await advance(50);
    expect(stranger.ui.getByRole("alert")).toHaveTextContent("could not be checked securely");
    expect(stranger.container).not.toHaveTextContent("Hussh Growth Sync");
    expect(stranger.container).not.toHaveTextContent(world.requester.googleEmail);
    expect(stranger.ui.queryByRole("button", { name: "Give access" })).toBeNull();
    stranger.unmount();

    // The requester can follow their own request but is never offered the organizer's actions.
    const own = mountOrganizer(world.requester);
    await advance(50);
    expect(own.ui.queryByRole("button", { name: "Give access" })).toBeNull();
    expect(own.ui.queryByRole("button", { name: "Check files linked to this meeting" })).toBeNull();
    expect(world.approvals).toEqual([]);
  });

  it("refuses a stale review and shares nothing", async () => {
    const requester = mountRequester();
    await requesterSends(requester.ui, ["Recording"]);
    const organizer = mountOrganizer();
    await organizerPrepares(organizer.ui);
    organizerConfirms(organizer.ui);
    world.supersedeReview();
    giveAccess(organizer.ui);
    await advance(50);
    expect(organizer.ui.getByText("This review changed. Refresh it before sharing.")).toBeInTheDocument();
    expect(world.approvals).toEqual([]);
    world.finishSharing();
    expect(world.shareCount()).toBe(0);
    expect(organizer.ui.queryByText("Sharing…")).toBeNull();
    await elapse(62_000);
    expect(requester.ui.queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(requester.ui.getAllByText(SENT).length).toBeGreaterThan(0);
  });

  it("refuses a replayed approval from a second page, leaving exactly one share", async () => {
    const requester = mountRequester();
    await requesterSends(requester.ui, ["Recording"]);
    const first = mountOrganizer();
    await organizerPrepares(first.ui);
    const second = mountOrganizer();
    await advance(50);
    organizerConfirms(first.ui);
    giveAccess(first.ui);
    await advance(50);
    expect(world.approvals).toHaveLength(1);

    // The second page still holds the same, now-spent review.
    organizerConfirms(second.ui);
    giveAccess(second.ui);
    await advance(50);
    expect(second.ui.getByText("This meeting request is no longer available.")).toBeInTheDocument();
    expect(world.approvals).toHaveLength(1);
    world.finishSharing();
    expect(world.shareCount()).toBe(1);
  });

  it("does not show Available when Drive shared with a different account than the one selected", async () => {
    const requester = mountRequester();
    await requesterSends(requester.ui, ["Recording"]);
    const organizer = mountOrganizer();
    await organizerPrepares(organizer.ui);
    organizerConfirms(organizer.ui);
    giveAccess(organizer.ui);
    await advance(50);
    await elapse(62_000);
    world.finishSharing({ grantTo: world.requester.oneEmail });
    expect(world.shares[0].to).toBe(world.requester.oneEmail);

    // The organizer's Drive says finished; the requester's own selected account still cannot open it.
    await elapse(150_000);
    expect(organizer.ui.getByText("Access given")).toBeInTheDocument();
    expect(requester.ui.queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(requester.ui.getAllByText(UNVERIFIED).length).toBeGreaterThan(0);
  });

  it("shows the shared notes, and still offers the missing recording, after a partial share", async () => {
    const requester = mountRequester();
    await requesterSends(requester.ui, ["Recording", "Notes"]);
    const organizer = mountOrganizer();
    await organizerPrepares(organizer.ui);
    organizerConfirms(organizer.ui);
    giveAccess(organizer.ui);
    await advance(50);
    await elapse(62_000);
    world.finishSharing({ only: ["notes"] });
    await elapse(8_000);

    expect(organizer.ui.getByText("Some files were shared")).toBeInTheDocument();
    expect(requester.ui.getByText("Meeting notes")).toBeInTheDocument();
    expect(requester.ui.getByRole("button", { name: /^Open/ })).toBeInTheDocument();
    expect(requester.ui.queryByText("Recordings")).toBeNull();
    expect(requester.ui.getAllByText("Some files are available; others could not be shared or verified.").length).toBeGreaterThan(0);
    expect(requester.ui.queryByRole("button", { name: "Ask organizer" })).toBeNull();
    expect(world.requests.size).toBe(1);
  });

  it("reports a failed share honestly to both people", async () => {
    const requester = mountRequester();
    await requesterSends(requester.ui, ["Recording"]);
    const organizer = mountOrganizer();
    await organizerPrepares(organizer.ui);
    organizerConfirms(organizer.ui);
    giveAccess(organizer.ui);
    await advance(50);
    await elapse(62_000);
    world.finishSharing({ failed: true });
    await elapse(8_000);
    expect(organizer.ui.getByText("Sharing did not complete")).toBeInTheDocument();
    expect(organizer.ui.getByRole("link", { name: "Back to Feed" })).toBeInTheDocument();
    expect(requester.ui.getAllByText("Sharing did not complete. Ask the organizer to review again.").length).toBeGreaterThan(0);
    expect(requester.ui.queryByRole("button", { name: /^Open/ })).toBeNull();
  });

  it("lets the organizer say they don't have the recording, without opening Drive, and tells the requester", async () => {
    const requester = mountRequester();
    await requesterSends(requester.ui, ["Recording"]);
    const organizer = mountOrganizer();
    await advance(50);
    expect(organizer.ui.getByText("Requested: recording")).toBeInTheDocument();
    expect(organizer.ui.getByText(world.requester.googleEmail)).toBeInTheDocument();
    expect(organizer.ui.getByRole("button", { name: "Give access" })).toBeEnabled();
    fireEvent.click(organizer.ui.getByRole("button", { name: "Don't have" }));
    expect(organizer.ui.getByRole("checkbox", { name: "The recording" })).toBeChecked();
    expect(organizer.ui.getByText(`Nothing in your Drive is opened. They'll see: "${NO_RECORDING}"`)).toBeInTheDocument();
    fireEvent.click(organizer.ui.getByRole("button", { name: "Confirm" }));
    await advance(50);
    expect(world.request()).toMatchObject({ status: "declined", notAvailable: ["recording"] });
    expect(world.driveReads).toEqual([]);
    expect(world.shareCount()).toBe(0);
    expect(organizer.ui.getByTestId("calendar-review-outcome")).toHaveTextContent("Saved");
    expect(organizer.ui.getByRole("link", { name: "Back to Feed" })).toHaveAttribute("href", "/one/feed");
    expect(organizer.onChanged).toHaveBeenCalled();
    expect(world.eventsFor(world.requester, "document_share_decided")).toHaveLength(1);
    expect(world.eventsFor(world.organizer, "document_share_decided")).toEqual([]);
    await elapse(62_000);
    expect(requester.ui.getAllByText(NO_RECORDING).length).toBeGreaterThan(0);
    expect(requester.ui.queryByText(/does not exist|doesn't exist|no recording exists/i)).toBeNull();
    expect(requester.ui.queryByText(SENT)).toBeNull();
    expect(requester.ui.queryByRole("tab", { name: "Recording" })).toBeNull();
    await chooseAndAsk(requester.ui, ["Notes"]);
    expect(world.sentBodies.at(-1)?.requested_types).toEqual(["notes"]);
    expect(world.requests.size).toBe(2);
  });

  it("answers each type on its own: Don't have for the recording leaves the notes to share", async () => {
    const requester = mountRequester();
    await requesterSends(requester.ui, ["Recording", "Notes"]);
    const organizer = mountOrganizer();
    await advance(50);
    fireEvent.click(organizer.ui.getByRole("button", { name: "Don't have" }));
    expect(organizer.ui.getByRole("button", { name: "Confirm" })).toBeDisabled();
    fireEvent.click(organizer.ui.getByRole("checkbox", { name: "The recording" }));
    expect(organizer.ui.getByRole("checkbox", { name: "The notes" })).not.toBeChecked();
    fireEvent.click(organizer.ui.getByRole("button", { name: "Confirm" }));
    await advance(50);
    expect(world.request()).toMatchObject({ status: "pending", notAvailable: ["recording"], revision: 1 });
    expect(world.driveReads).toEqual([]);
    expect(organizer.ui.getByText("You said you don't have the recording.")).toBeInTheDocument();
    expect(organizer.ui.getByRole("link", { name: "Back to Feed" })).toBeInTheDocument();
    await elapse(62_000);
    expect(requester.ui.getByText(/The organizer says they don't have the recording\. Request sent for the notes\. Waiting for organizer\./)).toBeInTheDocument();
    await organizerPrepares(organizer.ui);
    expect(organizer.ui.queryByText(/Hussh Growth Sync recording/)).toBeNull();
    organizerConfirms(organizer.ui);
    giveAccess(organizer.ui);
    await advance(50);
    world.finishSharing();
    await elapse(70_000);
    expect(organizer.ui.getByText("Access given")).toBeInTheDocument();
    expect(world.shares).toEqual([{ requestId: world.request().requestId, fileId: world.target.files.notes, to: world.requester.googleEmail }]);
    // Available only because the requester's own account can open it; the recording stays an honest "don't have".
    expect(requester.ui.getByRole("button", { name: /^Open/ })).toBeInTheDocument();
    expect(requester.ui.getAllByText(NO_RECORDING).length).toBeGreaterThan(0);
  });

  it("refuses Don't have from anyone but the addressed organizer, and for a stale or unrequested type", async () => {
    const requester = mountRequester();
    await requesterSends(requester.ui, ["Recording"]);
    const { requestId } = world.request();
    const say = (person: { vaultToken: string }, revision: number, types: ("recording" | "notes")[]) =>
      CalendarMeetingReviewService.markUnavailable(requestId, person.vaultToken, revision, types);
    await expect(say(world.stranger, 0, ["recording"])).rejects.toMatchObject({ code: "request_unavailable" });
    // The requester can follow their request but cannot answer for the organizer.
    await expect(say(world.requester, 0, ["recording"])).rejects.toMatchObject({ code: "request_unavailable" });
    await expect(say(world.organizer, 0, ["notes"])).rejects.toMatchObject({ code: "invalid_selection" });
    await expect(say(world.organizer, 9, ["recording"])).rejects.toMatchObject({ code: "review_changed" });
    expect(world.request()).toMatchObject({ status: "pending", notAvailable: [], revision: 0 });
    expect(world.eventsFor(world.requester, "document_share_decided")).toEqual([]);
    // Saying it again is a harmless repeat: same state, and the requester is not notified twice.
    const first = await say(world.organizer, 0, ["recording"]);
    expect(await say(world.organizer, 1, ["recording"])).toEqual(first);
    expect(world.eventsFor(world.requester, "document_share_decided")).toHaveLength(1);
  });
});
