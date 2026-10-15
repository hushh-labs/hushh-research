import * as connections from "@/lib/connections/google-connect-in-place";
import result from "../../../consent-protocol/tests/fixtures/calendar/chat_proposal_result.json";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";
import { AgentDockProvider, AgentDockVoiceBoundary } from "@/components/agent/agent-dock";
import { AgentBarSurface } from "@/components/agent/agent-bar-surface";
import { ApiService } from "@/lib/services/api-service";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
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
  else events.push({ type: "STATE_DELTA", delta: [{ op: "add", path: "/hussh:pending_directive:calendar", value: result.directive }] });
  events.push({ type: "RUN_FINISHED", threadId: "same-conversation", runId: "run-calendar" });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({}));
  fixture.auth.user.uid = "owner";
  publishValidatedAuthSessionOwner("owner");
  vi.spyOn(ApiService, "getPendingConsents").mockResolvedValue({ pending: [] } as never);
  vi.spyOn(ApiService, "listAgentChatConversations").mockResolvedValue(Response.json({ conversations: [] }));
  vi.spyOn(ApiService, "getAgentChatHistory").mockResolvedValue(Response.json({ messages: [] }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); publishValidatedAuthSessionOwner(null); });

function workspace() {
  return render(<AgentDockProvider><AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary><AgentChatWorkspace /></AgentDockProvider>);
}

describe("full Calendar workspace with real AG-UI stream handling", () => {
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
