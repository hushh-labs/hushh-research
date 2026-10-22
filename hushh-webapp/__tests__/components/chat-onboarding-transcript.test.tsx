import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentBubble } from "@/components/agent/agent-chat-workspace";
import { ChatOnboardingTurns } from "@/components/agent/chat-onboarding/chat-onboarding-transcript";
import { AgentSuggestionList } from "@/components/agent/agent-follow-up-suggestions";
import {
  useChatOnboarding,
  useChatOnboardingSession,
  beginChatOnboardingNameTurn,
  runChatOnboardingEvent,
} from "@/lib/agent/chat-onboarding/use-chat-onboarding";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { clearConnectorStatus, primeConnectorStatus, useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: { getStatus: vi.fn(async () => ({
    configured: true, connected: false, status: "disconnected", scope_csv: "",
    auto_sync_enabled: false, revoked: false,
  })) },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: vi.fn() },
}));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: vi.fn(),
    syncOneChatOnboarding: vi.fn(),
  },
}));

const onConnect = vi.fn();
const onStarter = vi.fn();
const onCompletionShown = vi.fn();
/** Every (turn id, status) the transcript hands to the real assistant bubble. */
const bubbleCalls: { id: string; status: string; role: string }[] = [];

function Harness({ messages = [] as { id: string }[], startSignal = true, userId = "u1" }) {
  const gmail = useGmailConnectorStatus({ userId: "u1", enabled: false });
  const controller = useChatOnboarding({
    userId,
    displayName: "Kushal",
    vaultKey: "vault-key",
    vaultOwnerToken: "owner-token",
    isVaultUnlocked: true,
    startSignal,
    messages,
    conversationId: null,
    onFocusComposer: () => undefined,
    visiblePrompts: [],
  });
  return (
    <>
      <ChatOnboardingTurns
        controller={controller}
        slot={{ kind: "top" }}
        onCompletionShown={onCompletionShown}
        renderBubble={(message) => {
          bubbleCalls.push({ id: message.id, status: message.status, role: message.role });
          return <AgentBubble message={message} />;
        }}
        onConnect={onConnect}
        gmailConnected={Boolean(gmail.status?.connected && !gmail.status.revoked && !gmail.status.needs_reauth)}
        completion={!messages.length ? <AgentSuggestionList suggestions={["What's on my calendar this week?", "Which emails need a reply?", "What do you remember about me?"]}
          layout="starter-grid" label="Start a conversation" onSelect={onStarter} /> : undefined}
      />
      <ChatOnboardingTurns
        controller={controller}
        slot={{ kind: "end", visibleMessageIds: messages.map((message) => message.id) }}
        renderBubble={(message) => <AgentBubble message={message} />}
        onConnect={onConnect}
        gmailConnected={Boolean(gmail.status?.connected && !gmail.status.revoked && !gmail.status.needs_reauth)}
      />
      <output data-testid="capture">{String(controller.composerPlaceholder)}</output>
      <output data-testid="onboarding-resolved">{String(controller.resolved)}</output>
      <button type="button" onClick={() => controller.captureComposerText("What's on my calendar?")}>
        type-unrelated
      </button>
    </>
  );
}

function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

function assistantBubbles() {
  return Array.from(document.querySelectorAll('[data-message-role="assistant"]'));
}

beforeEach(() => {
  clearConnectorStatus("u1");
  useChatOnboardingSession.getState().reset(null);
  vi.mocked(PreVaultUserStateService.bootstrapState).mockResolvedValue(
    { oneChatOnboarding: null } as Awaited<ReturnType<typeof PreVaultUserStateService.bootstrapState>>,
  );
  vi.mocked(PreVaultUserStateService.syncOneChatOnboarding).mockResolvedValue(
    {} as Awaited<ReturnType<typeof PreVaultUserStateService.syncOneChatOnboarding>>,
  );
  vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockReset().mockResolvedValue({
    saveState: "saved",
    success: true,
    fullBlob: {},
  });
  onConnect.mockReset();
  onStarter.mockReset();
  onCompletionShown.mockReset();
  bubbleCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("first onboarding message", () => {
  it("types out through the ordinary assistant bubble, not a welcome card", async () => {
    setReducedMotion(false);
    render(<Harness />);

    const bubble = await waitFor(() => {
      const [first] = assistantBubbles();
      expect(first).toBeTruthy();
      return first!;
    });
    // Negative control: the retired card and its tiles are gone.
    expect(screen.queryByTestId("post-setup-welcome-card")).toBeNull();
    expect(screen.queryByTestId("agent-first-run-actions")).toBeNull();
    // A scripted turn is not a model answer: no rating controls on it.
    expect(screen.queryByRole("button", { name: "Like response" })).toBeNull();

    await waitFor(() =>
      expect(bubble.textContent).toContain("Welcome, Kushal. I'm One, your private agent on Hussh."),
    );
    await waitFor(() => expect(bubble.getAttribute("data-message-status")).toBe("done"));
    // Typed out: the welcome mounted streaming (the bubble's own typing hook
    // starts from empty) and then settled.
    const welcomeStatuses = bubbleCalls.filter((call) => call.id === "onboarding-1").map((c) => c.status);
    expect(welcomeStatuses[0]).toBe("streaming");
    expect(welcomeStatuses.at(-1)).toBe("done");
    // Chips appear once the text has typed out.
    await waitFor(() => expect(screen.getByRole("button", { name: "Call me Kushal" })).toBeTruthy());
  });

  it("shows the whole text at once under reduced motion", async () => {
    setReducedMotion(true);
    render(<Harness />);
    const bubble = await waitFor(() => {
      const [first] = assistantBubbles();
      expect(first).toBeTruthy();
      return first!;
    });
    expect(bubble.getAttribute("data-message-status")).toBe("done");
    expect(bubbleCalls.filter((call) => call.id === "onboarding-1").map((c) => c.status)).not.toContain(
      "streaming",
    );
    expect(bubble.textContent).toContain("First, what should I call you?");
    expect(screen.getByRole("button", { name: "Call me Kushal" })).toBeTruthy();
  });
});

describe("onboarding conversation", () => {
  it("recovers a failed progress read on reconnect without assuming onboarding is complete", async () => {
    vi.mocked(PreVaultUserStateService.bootstrapState).mockRejectedValueOnce(new Error("Temporary bootstrap failure"));
    render(<Harness startSignal={false} />);
    await waitFor(() => expect(PreVaultUserStateService.bootstrapState).toHaveBeenCalledOnce());
    expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("false");
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("true"));
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();
  });
  it("holds profile discovery through questions, confirmation, saving and failure, then releases after success", async () => {
    setReducedMotion(true);
    let finishSave!: (value: { saveState: string; success: boolean; fullBlob: object }) => void;
    vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    render(<Harness messages={[{ id: "ordinary-question" }]} />);
    const resolved = () => screen.getByTestId("onboarding-resolved").textContent;
    expect(resolved()).toBe("false");
    expect(screen.queryByRole("group", { name: "Start a conversation" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Call me Kushal" }));
    expect(resolved()).toBe("false");
    fireEvent.click(await screen.findByRole("button", { name: "Mail" }));
    expect(resolved()).toBe("false");
    fireEvent.click(await screen.findByRole("button", { name: "Short and direct" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save to memory" }));
    await waitFor(() => expect(finishSave).toBeTypeOf("function"));
    expect(resolved()).toBe("false");
    expect(screen.queryByRole("group", { name: "Start a conversation" })).toBeNull();
    await act(async () => finishSave({ saveState: "failed", success: false, fullBlob: {} }));
    await screen.findByRole("button", { name: "Try again" });
    expect(resolved()).toBe("false");
    expect(screen.queryByRole("group", { name: "Start a conversation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(resolved()).toBe("true"));
  });
  it("releases profile discovery only after the whole optional conversation is skipped", async () => {
    setReducedMotion(true);
    render(<Harness />);
    for (let question = 0; question < 3; question++) {
      expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("false");
      await screen.findByText(`Question ${question + 1} of 3`);
      expect(screen.queryByRole("group", { name: "Start a conversation" })).toBeNull();
      expect(onCompletionShown).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Skip this question" }));
    }
    await waitFor(() => expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("true"));
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "What do you remember about me?" }));
    expect(onStarter).toHaveBeenCalledWith("What do you remember about me?");
    expect(onCompletionShown).toHaveBeenCalledOnce();
  });
  it("waits for owner progress and does not inherit another owner's completed onboarding", async () => {
    let finishLoad!: (value: Awaited<ReturnType<typeof PreVaultUserStateService.bootstrapState>>) => void;
    vi.mocked(PreVaultUserStateService.bootstrapState).mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve; }));
    const root = render(<Harness startSignal={false} />);
    expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("false");
    await act(async () => finishLoad({ oneChatOnboarding: null } as Awaited<ReturnType<typeof PreVaultUserStateService.bootstrapState>>));
    await waitFor(() => expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("true"));
    root.rerender(<Harness userId="new-owner" startSignal />);
    expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("false");
  });
  it("asks each question in turn, connects read-first, and saves only on confirmation", async () => {
    setReducedMotion(true);
    render(<Harness />);

    fireEvent.click(await screen.findByRole("button", { name: "Call me Kushal" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mail" }));

    const connect = await screen.findByTestId("chat-onboarding-connect");
    expect(connect.textContent).toContain("Connect Gmail");
    fireEvent.click(connect);
    expect(onConnect).toHaveBeenCalledWith(
      { kind: "connector", provider: "gmail", label: "Connect Gmail" },
      connect,
    );

    // The shared OAuth result changes the transcript without a reload or
    // advancing onboarding/Memory merely because the connection succeeded.
    act(() => primeConnectorStatus({ userId: "u1", source: "oauth_return", status: {
      configured: true, connected: true, status: "connected", scope_csv: "gmail.readonly",
      auto_sync_enabled: false, revoked: false,
    } }));
    expect(await screen.findByText("Gmail connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).toBeNull();
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();

    act(() => primeConnectorStatus({ userId: "u1", source: "status", status: {
      configured: true, connected: false, status: "disconnected", scope_csv: "",
      auto_sync_enabled: false, revoked: true,
    } }));
    expect(await screen.findByRole("button", { name: "Connect Gmail" })).toBeInTheDocument();
    expect(screen.queryByText("Gmail connected")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Short and direct" }));
    await screen.findByRole("button", { name: "Save to memory" });
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    });
    await waitFor(() => expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1));
    await screen.findByText(/Saved\. You can change it anytime in Memory\./);
    fireEvent.click(await screen.findByRole("button", { name: "What's on my calendar this week?" }));
    expect(onStarter).toHaveBeenCalledWith("What's on my calendar this week?");

    // The durable record never carries an answer value.
    for (const [, record] of vi.mocked(PreVaultUserStateService.syncOneChatOnboarding).mock.calls) {
      expect(JSON.stringify(record)).not.toMatch(/Kushal|short/i);
    }
    expect(vi.mocked(PreVaultUserStateService.syncOneChatOnboarding).mock.calls.at(-1)?.[1]).toMatchObject({
      status: "completed",
      answered: ["name", "focus", "tone"],
    });
  });

  it("Something else opens an explicit name question and leaves interpretation to One", async () => {
    setReducedMotion(true);
    render(<Harness />);
    await screen.findByRole("button", { name: "Call me Kushal" });
    expect(screen.getByTestId("capture").textContent).toBe("null");

    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    await waitFor(() =>
      expect(screen.getByTestId("capture").textContent).toBe("Type what I should call you"),
    );
    expect(await screen.findByText("Okay. What should I call you?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "type-unrelated" }));
    await waitFor(() => expect(screen.getByTestId("capture").textContent).toBe("Type what I should call you"));
    expect(screen.queryByRole("button", { name: "Call me Kushal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Skip this question" })).toBeInTheDocument();
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("moves between chips with the arrow keys", async () => {
    setReducedMotion(true);
    render(<Harness />);
    const first = await screen.findByRole("button", { name: "Call me Kushal" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Something else" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Skip this question" }));
  });
});

describe("semantic name assessment and encrypted write boundary", () => {
  const host = {
    anchor: () => "answer",
    vault: () => ({ vaultKey: "vault-key", vaultOwnerToken: "owner-token" }),
    focusComposer: () => undefined,
  };
  function pending() {
    useChatOnboardingSession.getState().reset("u1");
    runChatOnboardingEvent({ type: "start", displayName: "Owner", firstName: "Owner", anchor: null }, host);
    runChatOnboardingEvent({ type: "chip", chipId: "name_other", firstName: "Owner", anchor: null, today: "2026-10-16" }, host);
    return beginChatOnboardingNameTurn(host)!;
  }
  function answer(turn: ReturnType<typeof pending>, extra: Record<string, unknown> = {}) {
    return { status: "onboarding_name_assessed", request_id: turn.screenState.onboarding_name_request,
      decision: "name", preferred_name: "Roopmann", ...extra };
  }

  it.each(["Roopmann", "Love", "Zoë 🦋", "نور", "李 小龍", "A".repeat(64)])("saves %s only after a successful turn, then advances", async name => {
    const turn = pending();
    turn.stage(JSON.stringify(answer(turn, { preferred_name: name })), "call");
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();
    turn.finish(true);
    turn.finish(true);
    await waitFor(() => expect(useChatOnboardingSession.getState().machine?.step).toBe("focus"));
    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledOnce();
    const write = vi.mocked(PkmWriteCoordinator.saveMergedDomain).mock.calls[0][0];
    expect(write).toMatchObject({ userId: "u1", domain: "identity", confirmation: { source: "one_chat_onboarding" } });
    const built = await write.build({ currentDomainData: { communication_preferences: { tone: "warm" }, untouched: true } } as never);
    expect(built.domainData).toMatchObject({ untouched: true, communication_preferences: { preferred_name: name, tone: "warm" } });
    expect(JSON.stringify(built.summary)).not.toContain(name);
    expect(JSON.stringify(vi.mocked(PreVaultUserStateService.syncOneChatOnboarding).mock.calls)).not.toContain(name);
  });

  it.each([
    null, { status: "invalid" }, { preferred_name: "" }, { preferred_name: "A".repeat(65) },
    { preferred_name: " Kay " }, { preferred_name: "K\u0000ay" },
    { request_id: "stale" }, { decision: "guessed" }, { decision: "skip" },
  ])("never saves malformed or mismatched model output: %j", async invalid => {
    const turn = pending();
    turn.stage(invalid === null ? null : answer(turn, invalid), "call");
    turn.finish(true);
    await Promise.resolve();
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();
    expect(useChatOnboardingSession.getState().machine?.step).toBe("name_typing");
  });

  it.each(["error", "missing", "skip", "owner", "epoch", "new answer", "conflict", "question changed"])("rejects an obsolete answer after %s", async reason => {
    const turn = pending();
    if (reason !== "missing") turn.stage(answer(turn), "call");
    if (reason === "owner") useChatOnboardingSession.getState().reset("u2");
    if (reason === "epoch") advanceVaultSessionEpoch();
    if (reason === "new answer") beginChatOnboardingNameTurn(host);
    if (reason === "conflict") turn.stage(answer(turn, { preferred_name: "Other" }), "second-call");
    if (reason === "skip" || reason === "question changed")
      runChatOnboardingEvent({ type: "chip", chipId: "skip", firstName: "Owner", anchor: null, today: "2026-10-16" }, host);
    turn.finish(reason !== "error");
    await Promise.resolve();
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("deduplicates a repeated result and rejects a write if the vault changes before dispatch", async () => {
    const turn = pending();
    turn.stage(answer(turn), "call");
    turn.stage(answer(turn), "call");
    vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockImplementationOnce(async params => {
      advanceVaultSessionEpoch();
      await params.beforeEffect?.();
      throw new Error("must not reach storage");
    });
    turn.finish(true);
    await waitFor(() => expect(useChatOnboardingSession.getState().machine?.step).toBe("name_save_failed"));
    runChatOnboardingEvent({ type: "chip", chipId: "retry_save", firstName: "Owner", anchor: null, today: "2026-10-16" }, host);
    await waitFor(() => expect(useChatOnboardingSession.getState().machine?.step).toBe("focus"));
    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(2);
  });

  it("does not claim nothing was stored when navigation changes after dispatch", async () => {
    pending();
    let current = true;
    let finishWrite!: (value: never) => void;
    vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockImplementationOnce(async params => {
      await params.beforeEffect?.();
      return new Promise(resolve => { finishWrite = resolve; });
    });
    const turn = beginChatOnboardingNameTurn({ ...host, isCurrent: () => current })!;
    turn.stage(answer(turn), "call");
    turn.finish(true);
    await waitFor(() => expect(finishWrite).toBeTypeOf("function"));
    current = false;
    finishWrite({ success: true, saveState: "saved", fullBlob: {} } as never);
    await waitFor(() => expect(useChatOnboardingSession.getState().machine?.step).toBe("name_save_failed"));
    const text = useChatOnboardingSession.getState().machine!.turns.at(-1)!.text;
    expect(text).toContain("couldn't confirm");
    expect(text).not.toContain("nothing was stored");
  });
});
