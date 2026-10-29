import { fixture, resetCalendarChatFixture } from "./calendar-chat-workspace-fixture";
import { clearAgentChatHistoryCache } from "@/lib/agent/agent-chat-history-cache";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import * as connections from "@/lib/connections/google-connect-in-place";
import result from "../../../consent-protocol/tests/fixtures/calendar/chat_proposal_result.json";
import { calendarChatStream as sse } from "../fixtures/calendar-chat-stream";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";
import { AgentDockProvider, AgentDockVoiceBoundary } from "@/components/agent/agent-dock";
import { AgentBarSurface } from "@/components/agent/agent-bar-surface";
import { ApiService } from "@/lib/services/api-service";
import { GoogleCalendarService, GoogleCalendarError } from "@/lib/services/google-calendar-service";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { useChatOnboardingSession } from "@/lib/agent/chat-onboarding/use-chat-onboarding";
import { reduceChatOnboarding } from "@/lib/agent/chat-onboarding/chat-onboarding-machine";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { calendarDaySearchRequest } from "@/lib/calendar/calendar-day-search-request";

beforeEach(() => resetCalendarChatFixture());
afterEach(() => { cleanup(); vi.restoreAllMocks(); publishValidatedAuthSessionPrincipal(null); });

function workspace() {
  return render(<AgentDockProvider><AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary><AgentChatWorkspace /></AgentDockProvider>);
}

it.each(["Create new chat", "Start new chat"])("allows %s to reset a locked-vault draft without reading saved history", async entry => {
  fixture.vault.isVaultUnlocked = false;
  Object.assign(fixture.vault, { vaultKey: null, vaultOwnerToken: null });
  vi.spyOn(fixture.vault, "getVaultOwnerToken").mockReturnValue(null);
  try {
    workspace();
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    fireEvent.change(composer, { target: { value: "A fresh question 👋" } });
    fireEvent.click(screen.getByRole("button", { name: "Open chat history" }));
    const create = await screen.findByRole("button", { name: entry });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close chat history" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Message One" })).toHaveValue("");
    expect(ApiService.listAgentChatConversations).not.toHaveBeenCalled();
    expect(ApiService.getAgentChatHistory).not.toHaveBeenCalled();
  } finally {
    Object.assign(fixture.vault, { vaultKey: "12".repeat(32), vaultOwnerToken: "test-owner-token" });
  }
}, 15_000);

describe("full Calendar workspace with real AG-UI stream handling", { timeout: 30000 }, () => {
  it.each(["completed", "failed", "stale", "meeting"] as const)("commits an ordinary chosen name only from an eligible %s stream", async outcome => {
    fixture.captureReady = true;
    const ingestion = await import("@/lib/pkm/pkm-natural-language-ingestion");
    vi.spyOn(ingestion, "prepareNaturalLanguagePkm").mockResolvedValue({ cards: [] } as never);
    let channel!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const fetchStream = vi.spyOn(ApiService, "apiFetchStream").mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({ start(controller) { channel = controller; } }),
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    workspace();
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    if (outcome === "meeting") {
      const { CalendarInsightsService } = await import("@/lib/services/calendar-insights-service");
      vi.spyOn(CalendarInsightsService, "read").mockResolvedValue({ title: "Meeting", sources: [] });
      act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: {
        ownerId: "owner", request: "Summarize this meeting.",
        meeting: { calendar_id: "primary", event_id: "event", expected_account_email: "owner@example.com" },
      } }); });
    } else {
      fireEvent.change(composer, { target: { value: "Please call me Ruby" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    }
    await waitFor(() => expect(fetchStream).toHaveBeenCalledOnce());
    const push = (event: Record<string, unknown>) => act(() => channel.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)));
    const writes = () => vi.mocked(PkmWriteCoordinator.saveMergedDomain).mock.calls
      .filter(([params]) => params.confirmation.source === "one_chat_preferred_name");
    push({ type: "RUN_STARTED", threadId: "same-conversation", runId: "ordinary-name" });
    push({ type: "TOOL_CALL_START", toolCallId: "name-call", toolCallName: "propose_style_settings" });
    push({ type: "TOOL_CALL_ARGS", toolCallId: "name-call", delta: "{}" });
    push({ type: "TOOL_CALL_END", toolCallId: "name-call" });
    push({ type: "TOOL_CALL_RESULT", toolCallId: "name-call", messageId: "name-result", role: "tool",
      content: JSON.stringify({ result: { status: "preferred_name_update_ready", preferred_name: "Ruby", ...(outcome === "completed" ? { proposed: { tone: "warm", length: "short" } } : {}) } }) });
    expect(writes()).toHaveLength(0);
    if (outcome === "stale") advanceVaultSessionEpoch();
    push(outcome === "failed" ? { type: "RUN_ERROR", code: "MODEL_FAILED", message: "Please try again." }
      : { type: "RUN_FINISHED", threadId: "same-conversation", runId: "ordinary-name" });
    await act(async () => { channel.close(); });
    if (outcome === "completed") {
      await waitFor(() => expect(writes()).toHaveLength(1));
      const request = writes()[0][0];
      expect(request.mayPublish?.()).toBe(true);
      advanceVaultSessionEpoch();
      expect(request.mayPublish?.()).toBe(false);
      await expect(request.beforeEffect?.()).rejects.toMatchObject({ name: "AbortError" });
    } else {
      await waitFor(() => expect(screen.getByRole("button", { name: "Start voice mode" })).toBeInTheDocument());
      expect(writes()).toHaveLength(0);
    }
    expect(Boolean(screen.queryByRole("button", { name: "Review in Settings" }))).toBe(outcome === "completed");
  });

  it.each(["completed", "failed"] as const)("applies a semantic onboarding name only after a %s stream", async outcome => {
    fixture.nameOnboarding = true;
    const started = reduceChatOnboarding(null, { type: "start", displayName: "Owner", firstName: "Owner", anchor: null }).state;
    const pending = reduceChatOnboarding(started, { type: "chip", chipId: "name_other", firstName: "Owner", anchor: null, today: "2026-10-16" }).state;
    useChatOnboardingSession.getState().reset("owner");
    useChatOnboardingSession.getState().patch({ machine: pending, durable: null });
    let channel!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const fetchStream = vi.spyOn(ApiService, "apiFetchStream").mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({ start(controller) { channel = controller; } }),
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    workspace();
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    fireEvent.change(composer, { target: { value: "Please call me Roopmann" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(fetchStream).toHaveBeenCalledOnce());
    const wire = JSON.parse(String(fetchStream.mock.calls[0][1]?.body));
    const requestId = wire.forwardedProps.screenContext.screen_state.onboarding_name_request;
    expect(requestId).toMatch(/^[a-p]{32}$/);
    const push = (event: Record<string, unknown>) => act(() => channel.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)));
    const nameWrites = () => vi.mocked(PkmWriteCoordinator.saveMergedDomain).mock.calls
      .filter(([params]) => params.confirmation.source === "one_chat_onboarding");
    push({ type: "RUN_STARTED", threadId: "same-conversation", runId: "name-run" });
    push({ type: "TOOL_CALL_START", toolCallId: "name-call", toolCallName: "propose_style_settings" });
    push({ type: "TOOL_CALL_ARGS", toolCallId: "name-call", delta: "{}" });
    push({ type: "TOOL_CALL_END", toolCallId: "name-call" });
    push({ type: "TOOL_CALL_RESULT", toolCallId: "name-call", messageId: "name-result", role: "tool", content: JSON.stringify({
      status: "onboarding_name_assessed", request_id: requestId, decision: "name", preferred_name: "Roopmann",
    }) });
    expect(nameWrites()).toHaveLength(0);
    push(outcome === "completed"
      ? { type: "RUN_FINISHED", threadId: "same-conversation", runId: "name-run" }
      : { type: "RUN_ERROR", code: "MODEL_FAILED", message: "Please try again." });
    act(() => channel.close());
    if (outcome === "completed") {
      await waitFor(() => expect(nameWrites()).toHaveLength(1));
      expect(useChatOnboardingSession.getState().machine?.progress.questions.name).toBe("answered");
    } else {
      await screen.findByRole("button", { name: "Try again" });
      expect(nameWrites()).toHaveLength(0);
    }
    expect(screen.queryByRole("button", { name: "Review in Settings" })).toBeNull();
  });

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
      await waitFor(() => expect(avatar()).toHaveAttribute("data-one-presence-state", "working"));
      push({ type: "TEXT_MESSAGE_END", messageId: "presence-answer" });
      push({ type: "RUN_FINISHED", threadId: "same-conversation", runId: "run-presence" });
    } else {
      push({ type: "RUN_ERROR", code: "TOOL_FAILED", message: "Calendar request failed." });
    }
    act(() => channel.close());
    await waitFor(() => expect(avatar()).toHaveAttribute("data-one-presence-state", "connected"));
  });

  it("shows Working for written output in both avatars and recovers after a failed draft", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const channels: ReadableStreamDefaultController<Uint8Array>[] = [];
    const encoder = new TextEncoder();
    const fetchStream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () =>
      new Response(new ReadableStream<Uint8Array>({ start(controller) { channels.push(controller); } }),
        { headers: { "Content-Type": "text/event-stream" } }));
    const push = (event: Record<string, unknown>) => act(() => channels.at(-1)!.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)));
    const view = workspace();
    const avatar = () => view.container.querySelector("[data-agent-chat-one-profile-trigger] [data-one-presence-state]");
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    fireEvent.change(composer, { target: { value: "Write a TypeScript greeting function" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(fetchStream).toHaveBeenCalledOnce());
    push({ type: "RUN_STARTED", threadId: "same-conversation", runId: "writing" });
    await waitFor(() => expect(avatar()).toHaveAttribute("data-one-presence-state", "thinking"));
    fireEvent.click(screen.getByRole("button", { name: "Open One profile" }));
    const profile = await screen.findByRole("dialog", { name: "One" });
    const expectBoth = (state: string) => {
      expect(avatar()).toHaveAttribute("data-one-presence-state", state);
      expect(profile.querySelector("[data-one-presence-state]")).toHaveAttribute("data-one-presence-state", state);
    };
    await waitFor(() => expectBoth("thinking"));
    push({ type: "TEXT_MESSAGE_START", messageId: "written-answer", role: "assistant" });
    push({ type: "TEXT_MESSAGE_CONTENT", messageId: "written-answer", delta: "Here is the function:\n" });
    await waitFor(() => expectBoth("working"));
    push({ type: "TEXT_MESSAGE_CONTENT", messageId: "written-answer", delta: "```ts\nfunction greet() { return 'Hi'; }\n```" });
    await waitFor(() => expect(view.container.textContent).toContain("function greet()"));
    expectBoth("working");
    push({ type: "RUN_ERROR", code: "STREAM_FAILED", message: "The response was interrupted." });
    act(() => channels[0].close());
    await waitFor(() => expectBoth("connected"));
    fireEvent.click(screen.getByRole("button", { name: "Close One profile" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(2));
    push({ type: "RUN_STARTED", threadId: "same-conversation", runId: "writing-retry" });
    await waitFor(() => expect(avatar()).toHaveAttribute("data-one-presence-state", "thinking"));
    push({ type: "TEXT_MESSAGE_START", messageId: "retried-answer", role: "assistant" });
    push({ type: "TEXT_MESSAGE_CONTENT", messageId: "retried-answer", delta: "function greet() { return 'Hi'; }" });
    await waitFor(() => expect(avatar()).toHaveAttribute("data-one-presence-state", "working"));
    push({ type: "TEXT_MESSAGE_END", messageId: "retried-answer" });
    push({ type: "RUN_FINISHED", threadId: "same-conversation", runId: "writing-retry" });
    act(() => channels[1].close());
    await waitFor(() => expect(avatar()).toHaveAttribute("data-one-presence-state", "connected"));
  });

  it.each(["active slot", "expired slot", "proposal"])("replaces %s context with a generic invitation request in the same conversation", async previous => {
    const start = new Date(Date.now() + 900000).toISOString();
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
    await screen.findByText("Who should join?", {}, { timeout: 10000 });
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
    expect(screen.getByTestId("agent-calendar-proposal-card")).toHaveTextContent("UTC+05:30 · 30 min");
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
    publishValidatedAuthSessionPrincipal({ firebaseUid: "replacement", ownerId: "replacement", accountGeneration: 0 });
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
    publishValidatedAuthSessionPrincipal({ firebaseUid: "replacement", ownerId: "replacement", accountGeneration: 0 });
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
  expect(screen.queryByLabelText("Alternative duration in minutes")).not.toBeInTheDocument();
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

it.each(["navigation", "vault lock", "owner change", "verification required"])(
  "finishes pasted-profile capture after %s only while its original vault session is authorized",
  async boundary => {
    const ingestion = await import("@/lib/pkm/pkm-natural-language-ingestion");
    const markdown = await import("@/lib/pkm/markdown-memory");
    fixture.captureReady = true;
    const profile = Array.from({ length: 33 }, (_, index) =>
      `Synthetic profile line ${index}: I study mechanical engineering and build robots.`).join("\n");
    let finish!: (value: Awaited<ReturnType<typeof ingestion.prepareNaturalLanguagePkm>>) => void;
    const preparation = vi.spyOn(ingestion, "prepareNaturalLanguagePkm").mockImplementation(
      () => new Promise(resolve => { finish = resolve; }),
    );
    const stage = vi.spyOn(markdown, "stageMarkdownMemoryFacts").mockImplementation(async params => {
      await params.beforeEffect?.();
      return { success: true, saved: 1, markdown: "## Facts\n- I build robots.\n" };
    });
    const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool"));
    const view = workspace();
    const composer = await screen.findByRole("textbox", { name: "Message One" });
    fireEvent.change(composer, { target: { value: "Save this about me" } });
    fireEvent.paste(composer, { clipboardData: { getData: () => profile } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(preparation).toHaveBeenCalledOnce());
    await waitFor(() => expect(stream).toHaveBeenCalledOnce());
    expect(preparation.mock.calls[0][0].message).toBe(`Save this about me\n\n${profile}`);
    // The answer can finish while the independent semantic preparation is pending.
    await screen.findByRole("button", { name: "Schedule meeting" });
    view.unmount();
    if (boundary === "vault lock") advanceVaultSessionEpoch();
    if (boundary === "owner change") publishValidatedAuthSessionPrincipal({ firebaseUid: "replacement", ownerId: "replacement", accountGeneration: 0 });
    if (boundary === "verification required") fixture.tokenAccess.available = false;
    await act(async () => finish({ cards: [{
      card_id: "robotics", source_text: "I build robots.", write_mode: "can_save",
      candidate_payload: { soul_section: "Facts", soul_text: "I build robots." },
    }] } as never));
    expect(stage).toHaveBeenCalledTimes(boundary === "navigation" ? 1 : 0);
  },
  15_000,
);

it.each(["capture", "read", "locked"] as const)("keeps a background memory %s failure out of the answer unless the vault is locked", async failure => {
  const [ingestion, markdown, { morphyToast }, observability] = await Promise.all([import("@/lib/pkm/pkm-natural-language-ingestion"),
    import("@/lib/pkm/markdown-memory"), import("@/lib/morphy-ux/morphy"), import("@/lib/observability/client")]);
  const [failureToast, track] = [vi.spyOn(morphyToast, "error"), vi.spyOn(observability, "trackEvent")];
  Object.assign(fixture, { captureReady: true, memoryReadFails: failure !== "capture" });
  if (failure === "locked") fixture.vault.vaultKey = null as never;
  const preparation = vi.spyOn(ingestion, "prepareNaturalLanguagePkm").mockResolvedValue({ cards: [], previews: [], sourceCoverage: [{ sourceBlockId: "profile",
    preparationIssue: "preparation_timeout", disposition: "review_required", detectedFactCount: 0, accountedFactCount: 0 }] } as never);
  const stage = vi.spyOn(markdown, "stageMarkdownMemoryFacts");
  const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool"));
  workspace();
  fireEvent.change(await screen.findByRole("textbox", { name: "Message One" }), { target: { value: "I study robotics at Example University." } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  const blocked = "One couldn't load your private memory for this turn. Keep your vault unlocked and try again.";
  await (failure === "locked" ? screen.findByText(blocked) : screen.findByRole("button", { name: "Schedule meeting" }));
  expect(preparation).toHaveBeenCalledTimes(failure === "capture" ? 1 : 0);
  expect(stage).not.toHaveBeenCalled(); expect(failureToast).not.toHaveBeenCalled();
  if (failure === "capture") expect(track).toHaveBeenCalledWith("agent_pkm_save_confirmation_completed", expect.objectContaining({ result: "error" }));
  expect(stream).toHaveBeenCalledTimes(failure === "locked" ? 0 : 1);
  expect(Boolean(screen.queryByText(blocked))).toBe(failure === "locked");
  expect(screen.queryByText(/memory\.md status/)).toBeNull(); expect(Boolean(screen.queryByText("Private memory could not load."))).toBe(failure === "read");
  if (failure === "read") expect(JSON.parse(String(stream.mock.calls[0][1]?.body)).forwardedProps.pkmContext)
    .toContain("memory.md status: could not be read for this turn; its contents are unknown, not empty.");
  if (failure !== "capture") expect(track).toHaveBeenCalledWith("agent_pkm_context_unavailable",
    expect.objectContaining({ reason: failure === "read" ? "load_failed" : "vault_locked" }));
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
  publishValidatedAuthSessionPrincipal({ firebaseUid: "replacement", ownerId: "replacement", accountGeneration: 0 });
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

it.each(["untouched", "edited-and-cleared", "edited-inflight", "owner-replaced", "permission-revoked"] as const)(
  "keeps meeting sources private during chat-key recovery: %s", async scenario => {
  const { CalendarInsightsService } = await import("@/lib/services/calendar-insights-service");
  const { noteChatKeyAccepted } = await import("@/lib/vault/one-chat-key");
  noteChatKeyAccepted();
  const { rememberInAppChat } = await import("@/lib/agent/in-app-chat-selection");
  rememberInAppChat("owner", "same-conversation");
  clearAgentChatHistoryCache("owner");
  vi.mocked(ApiService.listAgentChatConversations).mockImplementation(async () => Response.json({ conversations: [{ id: "same-conversation", title: "Existing chat", status: "active", message_count: 1 }] }));
  vi.mocked(ApiService.getAgentChatHistory).mockImplementation(async () => Response.json({ messages: [{ id: "history-user", conversation_id: "same-conversation", role: "user", status: "complete", content: "Earlier conversation" }] }));
  const read = vi.spyOn(CalendarInsightsService, "read").mockResolvedValue({ title: "Review", sources: [{ title: "Notes", url: "https://docs.google.com/document/d/f", text: "Private recovery source" }] });
  const refusal = new Response(`data: ${JSON.stringify({ type: "RUN_ERROR", code: "CHAT_KEY_REQUIRED", message: "Unlock" })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  let releaseRefusal!: (response: Response) => void;
  const firstResponse = scenario === "edited-inflight" ? new Promise<Response>(resolve => { releaseRefusal = resolve; }) : Promise.resolve(refusal);
  const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementationOnce(() => firstResponse).mockImplementation(async () => sse("tool"));
  const view = workspace();
  await screen.findByRole("textbox", { name: "Message One" });
  await screen.findByText("Earlier conversation");
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: { ownerId: "owner", request: "Summarize this meeting.", meeting: { calendar_id: "primary", event_id: "event", expected_account_email: "owner@example.com" } } }); });
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
  if (scenario === "edited-inflight") {
    const composer = screen.getByRole("textbox", { name: "Message One" });
    fireEvent.change(composer, { target: { value: "A newer intention" } });
    fireEvent.change(composer, { target: { value: "" } });
    await act(async () => releaseRefusal(refusal));
    await screen.findByText(/Check the previous result before sending another request\./);
    expect(composer).toHaveValue("");
  } else {
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message One" })).toHaveValue("Summarize this meeting."));
  }
  expect(screen.queryByTestId("agent-chat-text-attachment-size")).toBeNull();
  fixture.vault.isVaultUnlocked = false;
  view.rerender(<AgentDockProvider><AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary><AgentChatWorkspace /></AgentDockProvider>);
  expect(useOneConversationSession.getState().composerDraft).toBeNull();
  expect(screen.queryByText("Earlier conversation")).toBeNull();
  if (scenario === "edited-and-cleared") {
    const lockedComposer = screen.getByRole("textbox", { name: "Message One" });
    fireEvent.change(lockedComposer, { target: { value: "A newer intention" } });
    fireEvent.change(lockedComposer, { target: { value: "" } });
  } else if (scenario === "owner-replaced") {
    // ABA must not inherit an earlier authentication generation's operation.
    publishValidatedAuthSessionPrincipal({ firebaseUid: "another-owner", ownerId: "another-owner", accountGeneration: 0 });
    publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 });
  }
  if (scenario === "permission-revoked") read.mockRejectedValueOnce(new Error("Permission revoked"));
  else read.mockResolvedValueOnce({ title: "Review", sources: [{ title: "Notes", url: "https://docs.google.com/document/d/f", text: "Fresh recovery source" }] });
  fixture.vault.isVaultUnlocked = true;
  view.rerender(<AgentDockProvider><AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary><AgentChatWorkspace /></AgentDockProvider>);
  await screen.findByText("Earlier conversation");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message One" })).toHaveValue(""));
  expect(read).toHaveBeenCalledTimes(1);
  expect(stream).toHaveBeenCalledTimes(1);
  if (scenario === "edited-and-cleared" || scenario === "edited-inflight" || scenario === "owner-replaced") {
    return;
  }
  // A streaming refusal cannot prove the first turn did not execute. Only a
  // fresh user request may read the current authorized meeting sources again.
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: { ownerId: "owner", request: "Summarize this meeting.", meeting: { calendar_id: "primary", event_id: "event", expected_account_email: "owner@example.com" } } }); });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  if (scenario === "permission-revoked") {
    await screen.findByText("Meeting access changed or could not be verified. Open Calendar and check the meeting again.");
    expect(stream).toHaveBeenCalledTimes(1);
    return;
  }
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId("agent-chat-text-attachment-size")).toBeNull();
  const retried = JSON.parse(String(stream.mock.calls[1][1]?.body));
  expect(retried.threadId).toBe("same-conversation");
  const source = retried.messages.at(-1).content.find((part: { type: string }) => part.type === "document");
  const sourceText = atob(source.source.value);
  expect(sourceText).toContain("Fresh recovery source");
  expect(sourceText).not.toContain("Private recovery source");
});

it("keeps the selected Calendar zone in the wire while the visible request uses UTC offsets", async () => {
  const stream = vi.spyOn(ApiService, "apiFetchStream").mockImplementation(async () => sse("tool"));
  workspace();
  await screen.findByRole("textbox", { name: "Message One" });
  act(() => { useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarRequest: {
    ownerId: "owner", request: "Find another time on Nov 1 in New York (UTC-04:00 → UTC-05:00).", timeZone: "America/New_York",
  } }); });
  await waitFor(() => expect(stream).toHaveBeenCalledOnce());
  const wire = JSON.parse(String(stream.mock.calls[0][1]?.body));
  expect(wire.forwardedProps.timezone).toBe("America/New_York");
  expect(JSON.stringify(wire.messages.at(-1).content)).not.toContain("America/New_York");
  expect(JSON.stringify(wire.messages.at(-1).content)).toContain("UTC-04:00");
});

it("does not retry a restored Calendar day search in the device time zone", async () => {
  const { noteChatKeyAccepted } = await import("@/lib/vault/one-chat-key");
  const { morphyToast } = await import("@/lib/morphy-ux/morphy");
  noteChatKeyAccepted();
  const notice = vi.spyOn(morphyToast, "info");
  const { rememberInAppChat } = await import("@/lib/agent/in-app-chat-selection");
  rememberInAppChat("owner", "same-conversation");
  clearAgentChatHistoryCache("owner");
  const request = calendarDaySearchRequest("2026-11-01", "America/New_York", 30);
  vi.mocked(ApiService.listAgentChatConversations).mockResolvedValue(Response.json({ conversations: [
    { id: "same-conversation", title: "Calendar chat", status: "active", message_count: 2 },
  ] }));
  vi.mocked(ApiService.getAgentChatHistory).mockResolvedValue(Response.json({ messages: [
    { id: "calendar-day-user", conversation_id: "same-conversation", role: "user", status: "complete", content: request },
    { id: "calendar-day-answer", conversation_id: "same-conversation", role: "assistant", status: "complete", content: "I found an opening." },
  ] }));
  const stream = vi.spyOn(ApiService, "apiFetchStream");
  workspace();
  await screen.findByText(request);
  fireEvent.click((await screen.findAllByRole("button", { name: "Try again" })).at(-1)!);
  expect(notice).toHaveBeenCalledWith("Open Calendar and choose the day again.");
  expect(stream).not.toHaveBeenCalled();
}, 15_000);

it("preserves retry for an ordinary chat request with similar words", async () => {
  const request = calendarDaySearchRequest("2026-11-01", "America/New_York", 30)
    .replace(/^Calendar request: /, "");
  const stream = vi.spyOn(ApiService, "apiFetchStream")
    .mockRejectedValueOnce(new Error("Network failure"))
    .mockImplementation(async () => sse("tool"));
  workspace();
  const composer = await screen.findByRole("textbox", { name: "Message One" });
  fireEvent.change(composer, { target: { value: request } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  fireEvent.click((await screen.findAllByRole("button", { name: "Try again" })).at(-1)!);
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
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

it.each([false, true])("reports authorized Calendar/Mail settlement without repeating effects (history retry: %s)", async retryHistory => {
  const { snapshotVaultSessionEpoch } = await import("@/lib/vault/session-epoch");
  let settle!: (value: { result: { calendar: "declined"; email: "sent"; calendar_error: null; email_error: null } }) => void;
  const outcome = new Promise<{ result: { calendar: "declined"; email: "sent"; calendar_error: null; email_error: null } }>(resolve => { settle = resolve; });
  if (retryHistory) {
    clearAgentChatHistoryCache("owner");
    vi.mocked(ApiService.listAgentChatConversations).mockRejectedValueOnce(new Error("temporary history failure"));
  }
  const stream = vi.spyOn(ApiService, "apiFetchStream");
  const confirm = vi.spyOn(GoogleCalendarService, "confirmAttendance");
  useOneConversationSession.getState().createHandoff({ reason: "user_requested", calendarAttendance: { ownerId: "owner", epoch: snapshotVaultSessionEpoch(), title: "Client Sync", recipient: "organizer@example.com", outcome } });
  workspace();
  if (retryHistory) fireEvent.click(await screen.findByRole("button", { name: "Retry conversation" }));
  await screen.findByText(/Declining Client Sync and sending your email/);
  await act(async () => { settle({ result: { calendar: "declined", email: "sent", calendar_error: null, email_error: null } }); });
  await screen.findByText(/Your email was sent to the organizer/);
  expect(stream).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(useOneConversationSession.getState().pendingHandoff).toBeNull();
});
