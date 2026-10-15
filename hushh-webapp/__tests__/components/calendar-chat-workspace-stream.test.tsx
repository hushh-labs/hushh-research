import { clearAgentChatHistoryCache } from "@/lib/agent/agent-chat-history-cache";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import * as connections from "@/lib/connections/google-connect-in-place";
import result from "../../../consent-protocol/tests/fixtures/calendar/chat_proposal_result.json";
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
vi.mock("@/lib/agent/agent-pkm-capture-runtime", async importOriginal => ({ ...await importOriginal<object>(), isAgentPkmProcessingReady: () => false }));
vi.mock("@/lib/agent/agent-pkm-memory", async importOriginal => ({ ...await importOriginal<object>(), loadAgentPkmContext: async () => fixture.memory, peekAgentPkmContext: () => fixture.memory, warmAgentPkmContext: async () => fixture.memory }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => fixture.search, useRouter: () => fixture.router }));


function sse(delivery: "tool" | "state", toolResult: unknown = result) {
  const events: unknown[] = [{ type: "RUN_STARTED", threadId: "same-conversation", runId: "run-calendar" }];
  if (delivery === "tool") events.push(
    { type: "TOOL_CALL_START", toolCallId: "call-calendar", toolCallName: "propose_calendar_event" },
    { type: "TOOL_CALL_ARGS", toolCallId: "call-calendar", delta: "{}" },
    { type: "TOOL_CALL_END", toolCallId: "call-calendar" },
    { type: "TOOL_CALL_RESULT", messageId: "result-calendar", toolCallId: "call-calendar", role: "tool", content: JSON.stringify(toolResult) },
  );
  else events.push({ type: "STATE_DELTA", delta: [{ op: "add", path: "/hussh:pending_directive:calendar", value: (toolResult as typeof result).directive }] });
  events.push({ type: "RUN_FINISHED", threadId: "same-conversation", runId: "run-calendar" });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
  configure({ asyncUtilTimeout: 5000 });
  useOneConversationSession.getState().clearSession();
  Element.prototype.scrollTo = vi.fn();
  vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({}));
  fixture.auth.user.uid = "owner";
  publishValidatedAuthSessionOwner("owner");
  vi.spyOn(GoogleCalendarService, "status").mockResolvedValue({ connected: true, google_email: "owner@example.com", access_level: "manage" } as never);
  vi.spyOn(ApiService, "getPendingConsents").mockResolvedValue({ pending: [] } as never);
  vi.spyOn(ApiService, "listAgentChatConversations").mockResolvedValue(Response.json({ conversations: [] }));
  vi.spyOn(ApiService, "getAgentChatHistory").mockResolvedValue(Response.json({ messages: [] }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); publishValidatedAuthSessionOwner(null); });

function workspace() {
  return render(<AgentDockProvider><AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary><AgentChatWorkspace /></AgentDockProvider>);
}

describe("full Calendar workspace with real AG-UI stream handling", { timeout: 30000 }, () => {
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
