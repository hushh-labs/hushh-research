import { clearAgentChatHistoryCache } from "@/lib/agent/agent-chat-history-cache";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import * as connections from "@/lib/connections/google-connect-in-place";
import result from "../../../consent-protocol/tests/fixtures/calendar/chat_proposal_result.json";
import { calendarChatStream as sse } from "../fixtures/calendar-chat-stream";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";
import { AgentDockProvider, AgentDockVoiceBoundary } from "@/components/agent/agent-dock";
import { AgentBarSurface } from "@/components/agent/agent-bar-surface";
import { ApiService } from "@/lib/services/api-service";
import { GoogleCalendarService, GoogleCalendarError } from "@/lib/services/google-calendar-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const fixture = vi.hoisted(() => {
  const user = { uid: "owner", email: "owner@example.com", displayName: "Owner", getIdToken: async () => "test-id-token" };
  return {
    captureReady: false,
    auth: { user, loading: false, sessionVerificationRequired: false },
    vault: { isVaultUnlocked: true, vaultKey: "12".repeat(32), vaultOwnerToken: "test-owner-token", tokenExpiresAt: Date.now() + 3600000, getVaultOwnerToken: () => "test-owner-token" },
    persona: { activePersona: "investor", primaryNavPersona: "investor", personaTransitionTarget: null, riaSetupAvailable: false, riaSwitchAvailable: false, riaOnboardingStatus: null, switchPersona: vi.fn() },
    onboarding: { turns: [], shownTurns: new Map(), shownTurnTimes: new Map(), captureComposerText: () => false, dailyTip: null },
    memory: { text: "", domains: [], totalAttributes: 0, updatedAt: null },
    router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
    search: new URLSearchParams(),
    gmail: { status: null, loadingStatus: false, presentation: {} },
  };
});
vi.mock("@/components/vault/vault-unlock-dialog", () => ({ VaultUnlockDialog: () => null }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => fixture.auth }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => fixture.vault }));
vi.mock("@/lib/persona/persona-context", () => ({ usePersonaState: () => fixture.persona }));
vi.mock("@/lib/agent/chat-onboarding/use-chat-onboarding", () => ({ useChatOnboarding: () => fixture.onboarding }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({ useGmailConnectorStatus: () => fixture.gmail }));
vi.mock("@/lib/navigation/use-root-chat-deferred-ready", () => ({ useRootChatDeferredReady: () => true }));
vi.mock("@/lib/one-voice/readiness", () => ({ useOneVoiceLiveEnabled: () => false }));
vi.mock("@/hooks/use-effective-avatar-url", () => ({ useEffectiveAvatarUrl: () => null }));
vi.mock("@/lib/agent/use-one-display-name", () => ({ useOneDisplayName: () => "One" }));
vi.mock("@/lib/services/model-preference-service", () => ({ ModelPreferenceService: { get: async () => ({ choices: [], effective_model: "test" }) } }));
vi.mock("@/lib/agent/use-entry-welcome", () => ({ useEntryWelcome: () => null }));
vi.mock("@/lib/agent/agent-pkm-capture-runtime", async importOriginal => ({ ...await importOriginal<object>(), isAgentPkmProcessingReady: () => fixture.captureReady }));
vi.mock("@/lib/agent/agent-pkm-memory", async importOriginal => ({ ...await importOriginal<object>(), loadAgentPkmContext: async () => fixture.memory, peekAgentPkmContext: () => fixture.memory, warmAgentPkmContext: async () => fixture.memory }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => fixture.search, useRouter: () => fixture.router }));



beforeEach(() => {
  configure({ asyncUtilTimeout: 5000 });
  useOneConversationSession.getState().clearSession();
  Element.prototype.scrollTo = vi.fn();
  vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({}));
  fixture.captureReady = false;
  fixture.vault.isVaultUnlocked = true;
  fixture.auth.user.uid = "owner";
  publishValidatedAuthSessionOwner("owner");
  vi.spyOn(GoogleCalendarService, "status").mockResolvedValue({ connected: true, google_email: "owner@example.com", access_level: "manage" } as never);
  vi.spyOn(ApiService, "getPendingConsents").mockResolvedValue({ pending: [] } as never);
  // The owner-aware facade owns routing; this suite supplies its stream port.
  vi.spyOn(ApiService, "agentChatRequest").mockImplementation((path, init, streaming) =>
    streaming ? ApiService.apiFetchStream(path, init) : Promise.resolve(Response.json({})));
  vi.spyOn(ApiService, "listAgentChatConversations").mockResolvedValue(Response.json({ conversations: [] }));
  vi.spyOn(ApiService, "getAgentChatHistory").mockResolvedValue(Response.json({ messages: [] }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); publishValidatedAuthSessionOwner(null); });

function workspace() {
  return render(<AgentDockProvider><AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary><AgentChatWorkspace /></AgentDockProvider>);
}

describe("full Calendar workspace with real AG-UI stream handling", { timeout: 30000 }, () => {
  it.each(["result", "error"] as const)("shows working during a tool call and settles after its %s", async outcome => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    let channel!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { channel = controller; } }),
      { headers: { "Content-Type": "text/event-stream" } });
    const fetchStream = vi.spyOn(ApiService, "apiFetchStream").mockResolvedValue(response);
    const push = (event: Record<string, unknown>) => act(() => channel.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)));
    const view = workspace();
    const avatar = () => view.container.querySelector("[data-agent-chat-one-profile-trigger] [data-one-presence-state]");
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    fireEvent.change(composer, { target: { value: "Check my calendar" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(fetchStream).toHaveBeenCalledOnce());
    push({ type: "RUN_STARTED", threadId: "same-conversation", runId: "run-presence" });
    await waitFor(() => expect(avatar()).toHaveAttribute("data-one-presence-state", "thinking"));
    push({ type: "TOOL_CALL_START", toolCallId: "presence-tool", toolCallName: "propose_calendar_event" });
    await waitFor(() => expect(avatar()).toHaveAttribute("data-one-presence-state", "working"));
    if (outcome === "result") {
      push({ type: "TOOL_CALL_RESULT", messageId: "presence-result", toolCallId: "presence-tool", role: "tool", content: JSON.stringify(result) });
      await waitFor(() => expect(avatar()).toHaveAttribute("data-one-presence-state", "thinking"));
      push({ type: "TEXT_MESSAGE_START", messageId: "presence-answer", role: "assistant" });
      push({ type: "TEXT_MESSAGE_CONTENT", messageId: "presence-answer", delta: "Your calendar proposal is ready." });
      await waitFor(() => expect(avatar()).toHaveAttribute("data-one-presence-state", "answering"));
      push({ type: "TEXT_MESSAGE_END", messageId: "presence-answer" });
      push({ type: "RUN_FINISHED", threadId: "same-conversation", runId: "run-presence" });
    } else {
      push({ type: "RUN_ERROR", code: "TOOL_FAILED", message: "Calendar request failed." });
    }
    act(() => channel.close());
    await waitFor(() => expect(avatar()).toHaveAttribute("data-one-presence-state", "connected"));
  });

  it.each(["active slot", "expired slot", "proposal"])("replaces %s context with a generic invitation request in the same conversation", async previous => {
    const start = new Date(Date.now() + 60000).toISOString();
    const proposal = structuredClone(result);
    Object.assign(proposal.directive.payload, { startAt: start, endAt: new Date(Date.parse(start) + 1800000).toISOString(), timeZone: "UTC" });
    const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("state", proposal));
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal");
    const invitations = vi.spyOn(GoogleCalendarService, "invitations").mockResolvedValue({ events: [], pending_count: 0, unreadable_calendars: [], time_zone: "UTC", start_at: start, end_at: new Date(Date.parse(start) + 86400000).toISOString(), complete: true });
    workspace();
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarSlot: {
      ownerId: "owner", accountEmail: "owner@example.com", date: start.slice(0, 10), windowStart: start,
      windowEnd: new Date(Date.parse(start) + 1800000).toISOString(), durationMinutes: 30, timeZone: "UTC",
    } }); });
    await screen.findByText("Who should join?");
    if (previous === "proposal") {
      fireEvent.change(composer, { target: { value: "guest@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await screen.findByRole("button", { name: "Schedule meeting" });
    }
    if (previous === "expired slot") vi.spyOn(Date, "now").mockReturnValue(Date.parse(start) + 1860000);
    stream.mockImplementation(async () => sse("state", { directive: { kind: "action", delegateAgentId: "agent_calendar", payload: { type: "calendar.invitations", filter: "pending" } } }));
    act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: {
      ownerId: "owner", request: "Show my pending invitations.",
    } }); });
    await waitFor(() => expect(invitations).toHaveBeenCalled());
    const wire = JSON.parse(String(stream.mock.calls.at(-1)?.[1]?.body));
    expect(wire.messages.at(-1).content).toBe("Show my pending invitations.");
    if (previous === "proposal") expect(wire.threadId).toBe(JSON.parse(String(stream.mock.calls[0][1]?.body)).threadId);
    expect(screen.queryByRole("button", { name: "Schedule meeting" })).toBeNull();
    expect(screen.queryByText("That free window has passed. What time would work for you?")).toBeNull();
    expect(useOneConversationSession.getState().pendingHandoff).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.router.push).not.toHaveBeenCalledWith("/one/calendar");
  });

  it("retains an invitation through cold history failure and resumes the same chat after retry", async () => {
    clearAgentChatHistoryCache("owner");
    vi.mocked(ApiService.listAgentChatConversations).mockRejectedValueOnce(new Error("temporary history failure"));
    vi.spyOn(GoogleCalendarService, "invitations").mockResolvedValue({ events: [{
      id: "invite", calendar_id: "primary", title: "Client Sync", start: { dateTime: "2030-10-14T10:00:00Z" }, end: { dateTime: "2030-10-14T10:30:00Z" },
      response_status: "needsAction", can_respond: true, conflicts: [], attendees: [], organizer: { email: "organizer@example.com" },
    }], pending_count: 1, unreadable_calendars: [], time_zone: "UTC", start_at: "2030-10-14T00:00:00Z", end_at: "2031-01-12T00:00:00Z", complete: true });
    const fetchStream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("state", { directive: { kind: "action", delegateAgentId: "agent_calendar", payload: { type: "calendar.invitations", eventId: "invite", calendarId: "primary", decision: "accepted", filter: "all", startAt: "2030-10-14T00:00:00Z", endAt: "2030-10-15T00:00:00Z" } } }));
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal");
    useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarInvitation: {
      ownerId: "owner", accountEmail: "owner@example.com", eventId: "invite", calendarId: "primary",
      decision: "accepted", request: "Accept this meeting after checking conflicts", startAt: "2030-10-14T00:00:00Z", endAt: "2030-10-15T00:00:00Z",
    } });
    workspace();
    fireEvent.click(await screen.findByRole("button", { name: "Retry conversation" }));
    await screen.findByRole("button", { name: "Accept", exact: true });
    expect(screen.getByText("Accept this meeting after checking conflicts")).toBeInTheDocument();
    expect(GoogleCalendarService.invitations).toHaveBeenCalledWith(expect.objectContaining({ startAt: "2030-10-14T00:00:00Z", endAt: "2030-10-15T00:00:00Z" }));
    const wire = JSON.parse(String(fetchStream.mock.calls[0][1]?.body));
    const selection = Buffer.from(wire.messages.at(-1).content.find((part: { type: string }) => part.type === "document").source.value, "base64").toString();
    expect(selection).toContain('"eventId":"invite"');
    expect(wire.messages.at(-1).content).toContainEqual({ type: "text", text: "Accept this meeting after checking conflicts" });
    expect(useOneConversationSession.getState().pendingHandoff).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.router.push).not.toHaveBeenCalledWith("/one/calendar");
  });

  it.each(["tool", "state"] as const)("shows invitation controls from %s after the account check inside the existing conversation", async delivery => {
    let settleStatus!: () => void;
    vi.mocked(GoogleCalendarService.status).mockImplementation(() => new Promise(resolve => {
      settleStatus = () => resolve({ connected: true, google_email: "owner@example.com", access_level: "manage" } as never);
    }));
    const invitation = { id: "invite", calendar_id: "primary", title: "Client Sync", start: { dateTime: "2030-10-14T10:00:00Z" }, end: { dateTime: "2030-10-14T10:30:00Z" }, response_status: "needsAction" as const, can_respond: true, conflicts: [], attendees: [], organizer: { email: "organizer@example.com" } };
    vi.spyOn(GoogleCalendarService, "invitations").mockResolvedValue({ events: [invitation], pending_count: 1, unreadable_calendars: [], time_zone: "UTC", start_at: "2030-10-14T00:00:00Z", end_at: "2031-01-12T00:00:00Z", complete: true, account_email: "owner@example.com" });
    const directive = { directive: { kind: "action", delegateAgentId: "agent_calendar", payload: { type: "calendar.invitations", accountEmail: "owner@example.com", eventId: "invite", calendarId: "primary", filter: "all", decision: "accepted", timeZone: "UTC" } }, message: "Review the invitation." };
    vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse(delivery, directive));
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal");
    const review = vi.spyOn(GoogleCalendarService, "reviewAttendance").mockResolvedValue({ review_id: "review", review_token: "browser-memory-only", title: "Client Sync", response_status: "accepted", conflicts: [], recipient: null, subject: null, message: null, rescheduling_link: null, sender_label: null, expires_at: "2030-10-14T09:00:00Z" });
    const confirm = vi.spyOn(GoogleCalendarService, "confirmAttendance").mockResolvedValue({ calendar: "accepted", email: "not_sent", calendar_error: null, email_error: null });
    workspace();
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    fireEvent.change(composer, { target: { value: "Accept tomorrow's client meeting" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(GoogleCalendarService.status).toHaveBeenCalled());
    // A late initial account observation must not replace an interactive review.
    expect(screen.queryByRole("button", { name: "Accept", exact: true })).toBeNull();
    expect(GoogleCalendarService.invitations).not.toHaveBeenCalled();
    await act(async () => settleStatus());
    fireEvent.click(await screen.findByRole("button", { name: "Accept", exact: true }));
    await waitFor(() => expect(review).toHaveBeenCalledWith(expect.objectContaining({ eventId: "invite", calendarId: "primary", expectedAccountEmail: "owner@example.com", responseStatus: "accepted" })));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm accept" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(screen.getByText("Accept tomorrow's client meeting")).toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.router.push).not.toHaveBeenCalledWith("/one/calendar");
  });

  it("retains a cold slot through failed history and resumes after explicit retry", async () => {
    clearAgentChatHistoryCache("owner");
    vi.mocked(ApiService.listAgentChatConversations).mockRejectedValueOnce(new Error("temporary history failure"));
    const start = new Date(Date.now() + 3600000).toISOString();
    useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarSlot: {
      ownerId: "owner", accountEmail: "owner@example.com", date: start.slice(0, 10), windowStart: start,
      windowEnd: new Date(Date.parse(start) + 7200000).toISOString(), durationMinutes: 30, timeZone: "UTC",
    } });
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal");
    workspace();
    fireEvent.click(await screen.findByRole("button", { name: "Retry conversation" }));
    await screen.findByText("Who should join?");
    expect(useOneConversationSession.getState().pendingHandoff).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["tool", "state"] as const)("continues the existing conversation through attendee entry, change-time and confirmation (%s)", async delivery => {
    const start = new Date(Date.now() + 3600000).toISOString();
    let proposedStart = start;
    const fetchStream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => {
      const proposal = structuredClone(result);
      Object.assign(proposal.directive.payload, { startAt: proposedStart, endAt: new Date(Date.parse(proposedStart) + 1800000).toISOString(), timeZone: "UTC" });
      return sse(delivery, proposal);
    });
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal").mockResolvedValue({ action: "create", event: { id: "event", title: "Call" } });
    workspace();
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    fireEvent.change(composer, { target: { value: "Earlier conversation" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Schedule meeting" });
    act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarSlot: {
      ownerId: "owner", accountEmail: "owner@example.com", date: start.slice(0, 10), windowStart: start,
      windowEnd: new Date(Date.parse(start) + 7200000).toISOString(), durationMinutes: 30, timeZone: "UTC",
    } }); });
    await screen.findByText("Who should join?", {}, { timeout: 10000 });
    expect(screen.getByText("Earlier conversation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schedule meeting" })).toBeNull();
    expect(fetchStream).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    fireEvent.change(composer, { target: { value: "guest@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Change time" });
    const body = JSON.parse(String(fetchStream.mock.calls[1][1]?.body));
    expect(body.threadId).toBe(JSON.parse(String(fetchStream.mock.calls[0][1]?.body)).threadId);
    const parts = body.messages.at(-1).content;
    expect(parts).toContainEqual({ type: "text", text: "guest@example.com" });
    const context = Buffer.from(parts.find((part: { type: string }) => part.type === "document").source.value, "base64").toString();
    expect(context).toContain('"durationMinutes":30');
    expect(context).toContain('"timeZone":"UTC"');
    expect(context).toContain(start);
    expect(screen.getByTestId("agent-calendar-proposal-card")).toHaveTextContent("guest@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Change time" }));
    expect(screen.getByRole("button", { name: "Schedule meeting" })).toBeDisabled();
    expect(execute).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Choose a start inside your free window" }), { key: "ArrowDown" });
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(7);
    proposedStart = new Date(Date.parse(start) + 900000).toISOString();
    fireEvent.click(options[1]);
    await waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(3));
    const confirm = await screen.findByRole("button", { name: "Schedule meeting" });
    const changedBody = JSON.parse(String(fetchStream.mock.calls[2][1]?.body));
    expect(changedBody.threadId).toBe(body.threadId);
    expect(changedBody.messages.at(-1).content).toContain(proposedStart);
    expect(changedBody.messages.at(-1).content).toContain('"guest@example.com"');
    expect(changedBody.messages.at(-1).content).toContain('"Call"');
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(fixture.router.push).not.toHaveBeenCalledWith("/one/calendar");
  }, 30000);

  it.each(["tool", "state"] as const)("blocks an out-of-window %s proposal without creating an event", async delivery => {
    vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse(delivery));
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal");
    workspace();
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    const start = new Date(Date.now() + 3600000).toISOString();
    act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarSlot: {
      ownerId: "owner", accountEmail: "owner@example.com", date: start.slice(0,10), windowStart: start,
      windowEnd: new Date(Date.parse(start) + 7200000).toISOString(), durationMinutes: 30, timeZone: "UTC",
    } }); });
    await screen.findByText("Who should join?", {}, { timeout: 10000 });
    fireEvent.change(composer, { target: { value: "guest@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const confirm = await screen.findByRole("button", { name: "Schedule meeting" });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("does not fit");
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(execute).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Schedule meeting" })).toBeNull();
  });

  it.each(["conflict", "account change"])("fails closed after %s during confirmation", async failure => {
    const start = new Date(Date.now() + 3600000).toISOString();
    const proposal = structuredClone(result);
    Object.assign(proposal.directive.payload, { startAt: start, endAt: new Date(Date.parse(start)+1800000).toISOString(), timeZone: "UTC" });
    const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool", proposal));
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal").mockRejectedValue(new GoogleCalendarError("Calendar availability changed; review the proposed time again before confirming", null, 409));
    workspace();
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarSlot: {
      ownerId: "owner", accountEmail: "owner@example.com", date: start.slice(0,10), windowStart: start,
      windowEnd: new Date(Date.parse(start)+7200000).toISOString(), durationMinutes: 30, timeZone: "UTC",
    } }); });
    await screen.findByText("Who should join?", {}, { timeout: 10000 });
    fireEvent.change(composer, { target: { value: "guest@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    if (failure === "account change") vi.mocked(GoogleCalendarService.status).mockResolvedValue({ connected: true, google_email: "different@example.com", access_level: "manage" } as never);
    fireEvent.click(await screen.findByRole("button", { name: "Schedule meeting" }));
    if (failure === "account change") {
      await screen.findByText("The connected Calendar account changed. Ask One to check this meeting again before scheduling.");
      expect(execute).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Schedule meeting" })).toBeNull();
      return;
    }
    await screen.findByText("Calendar availability changed; review the proposed time again before confirming");
    expect(execute).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Schedule meeting" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Find newly available times/ }));
    expect((composer as HTMLTextAreaElement).value).toContain("guest@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["tool", "state"] as const)("renders %s response and confirms once without reconnecting", async delivery => {
    const fetchStream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse(delivery));
    let resolveExecution!: (value: never) => void;
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal").mockImplementation(() => new Promise(resolve => { resolveExecution = resolve; }));
    workspace();
    fireEvent.change(await screen.findByRole("textbox", { name: "Message One" }), { target: { value: "Book a call with guest@example.com at 2pm for 30 minutes" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const confirm = await screen.findByRole("button", { name: "Schedule meeting" }, { timeout: 15000 });
    expect(fetchStream).toHaveBeenCalledOnce();
    expect(screen.getByTestId("agent-calendar-proposal-card")).toHaveTextContent("guest@example.com");
    expect(screen.getByTestId("agent-calendar-proposal-card")).toHaveTextContent("Asia/Kolkata · 30 min");
    expect(screen.queryByRole("button", { name: "Allow Calendar scheduling" })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith({ vaultOwnerToken: "test-owner-token", userId: "owner", proposalId: "gcal_local_review" });
    resolveExecution({ action: "create", event: { id: "local-event", title: "Call" } } as never);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Schedule meeting" })).toBeNull());
    fireEvent.change(screen.getByRole("textbox", { name: "Message One" }), { target: { value: "Book another call with the still-valid Calendar permission" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Schedule meeting" });
    expect(fetchStream).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Allow Calendar scheduling" })).toBeNull();
    expect(execute).toHaveBeenCalledOnce();
  }, 30000);
  it("keeps an included-calendar failure out of authorization and execution", async () => {
    const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool", {
      status: "failed", reason_code: "calendar_unreadable", message: "Calendar availability could not be checked",
    }));
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal");
    workspace();
    fireEvent.change(await screen.findByRole("textbox", { name: "Message One" }), { target: { value: "Book a call" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(stream).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole("textbox", { name: "Message One" }), { target: { value: "Another request" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).not.toBeDisabled());
    expect(screen.queryByTestId("agent-calendar-proposal-card")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow Calendar scheduling" })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("denied consent retains one actionable authorization card without continuing or executing", async () => {
    const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool", {
      status: "connection_required", directive: { kind: "action", delegateAgentId: "agent_calendar", payload: {
        type: "calendar.connect", accessLevel: "manage", summary: "Allow Calendar scheduling", confirmLabel: "Allow Calendar scheduling",
      } },
    }));
    const connect = vi.spyOn(connections, "connectCalendarInPlace").mockReturnValue({ surface: "window", result: Promise.resolve("not_connected") });
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal");
    workspace();
    fireEvent.change(await screen.findByRole("textbox", { name: "Message One" }), { target: { value: "Book a call" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Allow Calendar scheduling" }));
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow Calendar scheduling" })).not.toBeDisabled());
    expect(screen.getAllByRole("button", { name: "Allow Calendar scheduling" })).toHaveLength(1);
    expect(stream).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an in-flight Calendar confirmation after the owner changes", async () => {
    const start = new Date(Date.now() + 3600000).toISOString();
    const proposal = structuredClone(result);
    Object.assign(proposal.directive.payload, { startAt: start, endAt: new Date(Date.parse(start) + 1800000).toISOString(), timeZone: "UTC" });
    vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool", proposal));
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal");
    const view = workspace();
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarSlot: {
      ownerId: "owner", accountEmail: "owner@example.com", date: start.slice(0, 10), windowStart: start,
      windowEnd: new Date(Date.parse(start) + 7200000).toISOString(), durationMinutes: 30, timeZone: "UTC",
    } }); });
    await screen.findByText("Who should join?", {}, { timeout: 10000 });
    fireEvent.change(composer, { target: { value: "guest@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    let resolveStatus!: (value: Awaited<ReturnType<typeof GoogleCalendarService.status>>) => void;
    vi.mocked(GoogleCalendarService.status).mockImplementationOnce(() => new Promise(resolve => { resolveStatus = resolve; }));
    fireEvent.click(await screen.findByRole("button", { name: "Schedule meeting" }));
    await waitFor(() => expect(resolveStatus).toBeTypeOf("function"));

    fixture.auth.user.uid = "replacement";
    publishValidatedAuthSessionOwner("replacement");
    view.rerender(<AgentDockProvider><AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary><AgentChatWorkspace /></AgentDockProvider>);
    await waitFor(() => expect(screen.queryByTestId("agent-calendar-proposal-card")).toBeNull());
    await act(async () => { resolveStatus({ connected: true, google_email: "owner@example.com", access_level: "manage" } as never); });

    expect(execute).not.toHaveBeenCalled();
    expect(screen.queryByText("The conversation changed before scheduling.")).toBeNull();
  });

  it("account replacement clears the pending preview before it can execute", async () => {
    vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool"));
    const execute = vi.spyOn(GoogleCalendarService, "executeProposal");
    const view = workspace();
    fireEvent.change(await screen.findByRole("textbox", { name: "Message One" }), { target: { value: "Book a call" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Schedule meeting" });
    fixture.auth.user.uid = "replacement";
    publishValidatedAuthSessionOwner("replacement");
    view.rerender(<AgentDockProvider><AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary><AgentChatWorkspace /></AgentDockProvider>);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Schedule meeting" })).toBeNull());
    expect(execute).not.toHaveBeenCalled();
  });

});

it("interprets a selected Live request in the same existing chat and preserves proposed terms", async () => {
  const event = { id: "invite", calendar_id: "primary", title: "Client Sync", start: { dateTime: "2030-10-14T10:00:00Z" }, end: { dateTime: "2030-10-14T10:30:00Z" }, response_status: "needsAction" as const, can_respond: true, conflicts: [], attendees: [], organizer: { email: "organizer@example.com" } };
  vi.spyOn(GoogleCalendarService, "invitations").mockResolvedValue({ events: [event], pending_count: 1, unreadable_calendars: [], time_zone: "UTC", start_at: "2030-10-14T00:00:00Z", end_at: "2030-10-15T00:00:00Z", complete: true });
  const directive = { directive: { kind: "action", delegateAgentId: "agent_calendar", payload: { type: "calendar.invitations", calendarId: "primary", eventId: "invite", decision: "offer_times", filter: "all", terms: { date: "2030-10-18", startTime: "15:00", endTime: "18:00", durationMinutes: 45, message: "Could we meet Friday after 3 PM?" } } } };
  const fetchStream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("state", directive));
  const review = vi.spyOn(GoogleCalendarService, "reviewAttendance");
  workspace();
  const composer = await screen.findByRole("textbox", { name: "Message One" });
  fireEvent.change(composer, { target: { value: "Earlier conversation" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("textbox", { name: "Message to organiser" });
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarInvitation: { ownerId: "owner", accountEmail: "owner@example.com", calendarId: "primary", eventId: "invite", decision: "offer_times", request: "Ask for next Friday after 3 PM", startAt: "2030-10-14T00:00:00Z", endAt: "2030-10-15T00:00:00Z" } }); });
  await waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(2));
  const first = JSON.parse(String(fetchStream.mock.calls[0][1]?.body)), second = JSON.parse(String(fetchStream.mock.calls[1][1]?.body));
  expect(second.threadId).toBe(first.threadId);
  expect(second.messages.at(-1).content).toContainEqual({ type: "text", text: "Ask for next Friday after 3 PM" });
  expect(await screen.findByLabelText("Alternative date")).toHaveValue("2030-10-18");
  expect(screen.getByLabelText("Alternative start time")).toHaveValue("15:00");
  expect(screen.getByLabelText("Alternative duration in minutes")).toHaveValue(45);
  expect(screen.getByRole("textbox", { name: "Message to organiser" })).toHaveValue("Could we meet Friday after 3 PM?");
  expect(screen.getByText("Earlier conversation")).toBeInTheDocument();
  expect(review).not.toHaveBeenCalled();
});

it("rejects a changed Google account even if the model returns the same invitation under that account", async () => {
  vi.mocked(GoogleCalendarService.status).mockResolvedValue({ connected: true, google_email: "changed@example.com", access_level: "manage" } as never);
  const payload = { type: "calendar.invitations", calendarId: "primary", eventId: "invite", decision: "accepted", filter: "all", accountEmail: "changed@example.com" };
  vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("state", { directive: { kind: "action", delegateAgentId: "agent_calendar", payload } }));
  vi.spyOn(GoogleCalendarService, "invitations").mockRejectedValue(new Error("No selected-account read allowed"));
  const confirm = vi.spyOn(GoogleCalendarService, "confirmAttendance");
  useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarInvitation: { ownerId: "owner", accountEmail: "owner@example.com", calendarId: "primary", eventId: "invite", request: "Accept this invitation" } });
  workspace();
  await screen.findByText("The connected Calendar account changed. Close this review and ask One to check the invitation again.");
  expect(screen.queryByRole("button", { name: "Confirm accept" })).toBeNull();
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close invitations" }));
  expect(screen.queryByText(/The connected Calendar account changed/)).toBeNull();
});


it("binds invitation reconnect to the unlocked owner and retires its capability on unmount", async () => {
  vi.spyOn(GoogleCalendarService, "invitations").mockRejectedValue(new GoogleCalendarError("Connect Calendar", "calendar_not_connected", 409));
  vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("state", { directive: {
    kind: "action", delegateAgentId: "agent_calendar", payload: { type: "calendar.invitations", filter: "pending" },
  } }));
  const connect = vi.spyOn(connections, "connectCalendarInPlace").mockReturnValue({ surface: "native", result: new Promise(() => {}) });
  const view = workspace();
  fireEvent.change(await screen.findByRole("textbox", { name: "Message One" }), { target: { value: "Review my invitations" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  fireEvent.click(await screen.findByRole("button", { name: "Allow Calendar access" }));
  expect(connect).toHaveBeenCalledOnce();
  const controls = connect.mock.calls[0][0];
  expect(controls.vaultOwnerCapability).toBe(fixture.vault.vaultOwnerToken);
  expect(controls.isCurrent?.()).toBe(true);
  view.unmount();
  expect(controls.isCurrent?.()).toBe(false);
  expect(controls.signal?.aborted).toBe(true);
});

it("meeting context continues the current conversation with source attachments and no automatic PKM capture", async () => {
  const { CalendarInsightsService } = await import("@/lib/services/calendar-insights-service");
  const ingestion = await import("@/lib/pkm/pkm-natural-language-ingestion");
  fixture.captureReady = true;
  const preparation = vi.spyOn(ingestion, "prepareNaturalLanguagePkm").mockResolvedValue({ cards: [] } as never);
  const contextRead = vi.spyOn(CalendarInsightsService, "read").mockResolvedValue({ title: "QA Review", sources: [{ title: "Verified notes", url: "https://docs.google.com/document/d/verified", text: "Private meeting source", truncated: false }] });
  const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool"));
  workspace();
  const composer = await screen.findByRole("textbox", { name: "Message One" });
  fireEvent.change(composer, { target: { value: "Earlier conversation" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
  await screen.findByRole("button", { name: "Schedule meeting" });
  await waitFor(() => expect(preparation).toHaveBeenCalledTimes(1));
  preparation.mockClear();
  const earlierThread = JSON.parse(String(stream.mock.calls[0][1]?.body)).threadId;
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: { ownerId: "owner", request: "Summarize this meeting.", meeting: { calendar_id: "primary", event_id: "verified-event", expected_account_email: "owner@example.com" } } }); });
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
  expect(contextRead).toHaveBeenCalledWith("meetings/context", { calendar_id: "primary", event_id: "verified-event", expected_account_email: "owner@example.com" }, "test-id-token", expect.any(AbortSignal), expect.any(String));
  const wire = JSON.parse(String(stream.mock.calls.at(-1)?.[1]?.body));
  expect(wire.threadId).toBe(earlierThread);
  expect(screen.getByText("Earlier conversation")).toBeInTheDocument();
  const source = Buffer.from(wire.messages.at(-1).content.find((part: { type: string }) => part.type === "document").source.value, "base64").toString("utf8");
  expect(source).toContain("Private meeting source");
  expect(source).toContain("https://docs.google.com/document/d/verified");
  expect(preparation).not.toHaveBeenCalled();
  expect(useOneConversationSession.getState().pendingHandoff).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Meeting sources.txt/ }));
  await screen.findByTestId("text-attachment-viewer");
  expect(screen.queryByRole("button", { name: "Edit and send again" })).toBeNull();
});

it("discards pending meeting context when the workspace owner changes", async () => {
  const { CalendarInsightsService } = await import("@/lib/services/calendar-insights-service");
  let finish!: (value: unknown) => void;
  const contextRead = vi.spyOn(CalendarInsightsService, "read").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const stream = vi.spyOn(ApiService, "apiFetchStream");
  const view = workspace();
  await screen.findByRole("textbox", { name: "Message One" });
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: { ownerId: "owner", request: "Summarize this meeting.", meeting: { calendar_id: "primary", event_id: "event", expected_account_email: "owner@example.com" } } }); });
  await waitFor(() => expect(contextRead).toHaveBeenCalled());
  const signal = contextRead.mock.calls[0][3];
  fixture.auth.user.uid = "replacement";
  publishValidatedAuthSessionOwner("replacement");
  view.rerender(<AgentDockProvider><AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary><AgentChatWorkspace /></AgentDockProvider>);
  await waitFor(() => expect(signal?.aborted).toBe(true));
  await act(async () => finish({ title: "Private", sources: [{ title: "Notes", url: "https://docs.google.com/document/d/f", text: "Must be discarded" }] }));
  expect(stream).not.toHaveBeenCalled();
  expect(screen.queryByText(/Meeting access changed/)).toBeNull();
});

it("rechecks meeting permission on retry without copying source text into Memory", async () => {
  const { CalendarInsightsService } = await import("@/lib/services/calendar-insights-service");
  const ingestion = await import("@/lib/pkm/pkm-natural-language-ingestion");
  fixture.captureReady = true;
  const preparation = vi.spyOn(ingestion, "prepareNaturalLanguagePkm").mockResolvedValue({ cards: [] } as never);
  const contextRead = vi.spyOn(CalendarInsightsService, "read").mockResolvedValue({ title: "Review", sources: [{ title: "Notes", url: "https://docs.google.com/document/d/f", text: "Authorized first read", truncated: false }] });
  const stream = vi.spyOn(ApiService, "apiFetchStream").mockRejectedValueOnce(new Error("Network failure")).mockImplementation(async () => sse("tool"));
  workspace();
  await screen.findByRole("textbox", { name: "Message One" });
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: { ownerId: "owner", request: "Summarize this meeting.", meeting: { calendar_id: "primary", event_id: "event", expected_account_email: "owner@example.com" } } }); });
  const retry = await screen.findByRole("button", { name: "Try again" });
  contextRead.mockRejectedValueOnce(new Error("Permission revoked"));
  fireEvent.click(retry);
  await screen.findByText("Meeting access changed or could not be verified. Open Calendar and check the meeting again.");
  expect(contextRead).toHaveBeenCalledTimes(2);
  expect(stream).toHaveBeenCalledTimes(1);
  expect(preparation).not.toHaveBeenCalled();
});

it("cancels pending meeting context when the same owner starts another chat", async () => {
  const { CalendarInsightsService } = await import("@/lib/services/calendar-insights-service");
  let finish!: (value: unknown) => void;
  const contextRead = vi.spyOn(CalendarInsightsService, "read").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool"));
  workspace();
  await screen.findByRole("textbox", { name: "Message One" });
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: { ownerId: "owner", request: "Summarize this meeting.", meeting: { calendar_id: "primary", event_id: "event", expected_account_email: "owner@example.com" } } }); });
  await waitFor(() => expect(contextRead).toHaveBeenCalled());
  const signal = contextRead.mock.calls[0][3];
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", transcript: "Start another conversation" }); });
  await waitFor(() => expect(signal?.aborted).toBe(true));
  await act(async () => finish({ title: "Private", sources: [{ title: "Notes", url: "https://docs.google.com/document/d/f", text: "Discarded meeting source" }] }));
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
  const wire = JSON.parse(String(stream.mock.calls[0][1]?.body));
  expect(wire.messages.at(-1).content).toBe("Start another conversation");
  expect(JSON.stringify(wire)).not.toContain("Meeting sources.txt");
  expect(screen.queryByText("Summarize this meeting.")).toBeNull();
});

it("retries the meeting after initial permission denial, never the preceding ordinary request", async () => {
  const { CalendarInsightsService } = await import("@/lib/services/calendar-insights-service");
  const read = vi.spyOn(CalendarInsightsService, "read").mockRejectedValueOnce(new Error("Permission required")).mockResolvedValue({ title: "Review", sources: [{ title: "Notes", url: "https://docs.google.com/document/d/f", text: "Fresh authorized notes" }] });
  const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool"));
  workspace();
  const composer = await screen.findByRole("textbox", { name: "Message One" });
  fireEvent.change(composer, { target: { value: "Ordinary request" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("button", { name: "Schedule meeting" });
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: { ownerId: "owner", request: "Summarize this meeting.", meeting: { calendar_id: "primary", event_id: "event", expected_account_email: "owner@example.com" } } }); });
  await screen.findByText(/Meeting access changed/);
  fireEvent.click(screen.getAllByRole("button", { name: "Try again" }).at(-1)!);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(stream.mock.calls[1][1]?.body)).messages.at(-1).content).toContainEqual({ type: "text", text: "Summarize this meeting." });
});

it("does not replay a refused meeting stream after unlock; an explicit request rechecks sources", async () => {
  const { CalendarInsightsService } = await import("@/lib/services/calendar-insights-service");
  const { noteChatKeyAccepted } = await import("@/lib/vault/one-chat-key");
  noteChatKeyAccepted();
  const { rememberInAppChat } = await import("@/lib/agent/in-app-chat-selection");
  rememberInAppChat("owner", "same-conversation");
  clearAgentChatHistoryCache("owner");
  vi.mocked(ApiService.listAgentChatConversations).mockImplementation(async () => Response.json({ conversations: [{ id: "same-conversation", title: "Existing chat", status: "active", message_count: 1 }] }));
  vi.mocked(ApiService.getAgentChatHistory).mockImplementation(async () => Response.json({ messages: [{ id: "history-user", conversation_id: "same-conversation", role: "user", status: "complete", content: "Earlier conversation" }] }));
  const read = vi.spyOn(CalendarInsightsService, "read").mockResolvedValue({ title: "Review", sources: [{ title: "Notes", url: "https://docs.google.com/document/d/f", text: "Private recovery source" }] });
  const stream = vi.spyOn(ApiService, "apiFetchStream").mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ type: "RUN_ERROR", code: "CHAT_KEY_REQUIRED", message: "Unlock" })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })).mockImplementation(async () => sse("tool"));
  const view = workspace();
  await screen.findByRole("textbox", { name: "Message One" });
  await screen.findByText("Earlier conversation");
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: { ownerId: "owner", request: "Summarize this meeting.", meeting: { calendar_id: "primary", event_id: "event", expected_account_email: "owner@example.com" } } }); });
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message One" })).toHaveValue("Summarize this meeting."));
  expect(screen.queryByTestId("agent-chat-text-attachment-size")).toBeNull();
  fixture.vault.isVaultUnlocked = false;
  view.rerender(<AgentDockProvider><AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary><AgentChatWorkspace /></AgentDockProvider>);
  fixture.vault.isVaultUnlocked = true;
  view.rerender(<AgentDockProvider><AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary><AgentChatWorkspace /></AgentDockProvider>);
  await screen.findByText("Earlier conversation");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message One" })).toHaveValue(""));
  expect(read).toHaveBeenCalledTimes(1);
  expect(stream).toHaveBeenCalledTimes(1);
  // A streaming refusal cannot prove the first turn did not execute. Only a
  // fresh user request may read the current authorized meeting sources again.
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: { ownerId: "owner", request: "Summarize this meeting.", meeting: { calendar_id: "primary", event_id: "event", expected_account_email: "owner@example.com" } } }); });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId("agent-chat-text-attachment-size")).toBeNull();
  expect(JSON.parse(String(stream.mock.calls[1][1]?.body)).threadId).toBe("same-conversation");
});

it("does not borrow an active Mail reply workflow for a meeting turn", async () => {
  const { CalendarInsightsService } = await import("@/lib/services/calendar-insights-service");
  vi.spyOn(CalendarInsightsService, "read").mockResolvedValue({ title: "Review", sources: [{ title: "Notes", url: "https://docs.google.com/document/d/f", text: "Verified notes" }] });
  const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool"));
  workspace();
  await screen.findByRole("textbox", { name: "Message One" });
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", gmailInformationRequest: { workflow_id: "mail-workflow", requested_field_labels: [], candidate_scopes: [], attachment_review_required: false } }); });
  await screen.findByRole("button", { name: "Schedule meeting" });
  const first = JSON.parse(String(stream.mock.calls[0][1]?.body));
  expect(JSON.stringify(first)).toContain("mail-workflow");
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: { ownerId: "owner", request: "Summarize this meeting.", meeting: { calendar_id: "primary", event_id: "event", expected_account_email: "owner@example.com" } } }); });
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
  const next = JSON.parse(String(stream.mock.calls[1][1]?.body));
  expect(next.threadId).toBe(first.threadId);
  expect(JSON.stringify(next.context)).not.toContain("mail-workflow");
  expect(next.gmailInformationRequestWorkflowId).toBeUndefined();
});
