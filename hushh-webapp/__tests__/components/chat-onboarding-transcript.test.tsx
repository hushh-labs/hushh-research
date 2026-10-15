import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentBubble } from "@/components/agent/agent-chat-workspace";
import { ChatOnboardingTurns } from "@/components/agent/chat-onboarding/chat-onboarding-transcript";
import {
  useChatOnboarding,
  useChatOnboardingSession,
} from "@/lib/agent/chat-onboarding/use-chat-onboarding";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { dispatchLocalPkmDomainChanged } from "@/lib/pkm/pkm-domain-change-events";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
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

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { peek: vi.fn(), getStaleFirst: vi.fn(), invalidateDomain: vi.fn() },
}));
const onEndConversation = vi.fn();
const onConnect = vi.fn();
/** Every (turn id, status) the transcript hands to the real assistant bubble. */
const bubbleCalls: { id: string; status: string; role: string }[] = [];

function Harness({ messages = [] as { id: string }[], startSignal = true, userId = "u1", unlocked = true }) {
  const gmail = useGmailConnectorStatus({ userId: "u1", enabled: false });
  const controller = useChatOnboarding({
    userId,
    displayName: "Kushal",
    vaultKey: "vault-key",
    vaultOwnerToken: "owner-token",
    isVaultUnlocked: unlocked,
    startSignal,
    messages,
    conversationId: null,
    onFocusComposer: () => undefined,
    onEndConversation,
    visiblePrompts: [],
  });
  return (
    <>
      <ChatOnboardingTurns
        controller={controller}
        slot={{ kind: "top" }}
        renderBubble={(message) => {
          bubbleCalls.push({ id: message.id, status: message.status, role: message.role });
          return <AgentBubble message={message} />;
        }}
        onConnect={onConnect}
        gmailConnected={Boolean(gmail.status?.connected && !gmail.status.revoked && !gmail.status.needs_reauth)}
      />
      <ChatOnboardingTurns
        controller={controller}
        slot={{ kind: "end", visibleMessageIds: messages.map((message) => message.id) }}
        renderBubble={(message) => <AgentBubble message={message} />}
        onConnect={onConnect}
        gmailConnected={Boolean(gmail.status?.connected && !gmail.status.revoked && !gmail.status.needs_reauth)}
      />
      <output data-testid="preferred-name">{controller.preferredName || "One"}</output>
      <button onClick={() => controller.captureComposerText("  Roopmann  ")}>type-name</button>
      <button onClick={() => controller.captureComposerText(" ")}>type-empty</button>
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
  vi.mocked(PkmDomainResourceService.peek).mockReturnValue(null);
  vi.mocked(PkmDomainResourceService.getStaleFirst).mockReset().mockImplementation(async ({ userId }) => ({
    key: { userId, domain: "identity", segmentIds: [], contentRevision: 1 },
    data: {}, manifestRevision: 1, updatedAt: null,
    audit: { cacheTier: "network", source: "network", refreshedAt: "2026-10-15" },
  }));
  onEndConversation.mockReset();
  onConnect.mockReset();
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
      expect(bubble.textContent).toContain("What would you like me to call you?"),
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
    expect(bubble.textContent).toContain("What would you like me to call you?");
    expect(screen.getByRole("button", { name: "Call me Kushal" })).toBeTruthy();
  });
});

describe("onboarding conversation", () => {
  it("recovers a failed progress read on reconnect without assuming onboarding is complete", async () => {
    vi.mocked(PreVaultUserStateService.bootstrapState).mockRejectedValueOnce(new Error("Temporary bootstrap failure"));
    vi.mocked(PkmDomainResourceService.getStaleFirst).mockResolvedValue({
      key: { userId: "u1", domain: "identity", segmentIds: [], contentRevision: 1 },
      data: { communication_preferences: { preferred_name: "Saved" } },
    } as never);
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
    render(<Harness messages={[{ id: "ordinary-question" }]} />);
    const resolved = () => screen.getByTestId("onboarding-resolved").textContent;
    expect(resolved()).toBe("false");
    fireEvent.click(await screen.findByRole("button", { name: "Call me Kushal" }));
    expect(resolved()).toBe("false");
    fireEvent.click(await screen.findByRole("button", { name: "Mail" }));
    expect(resolved()).toBe("false");
    vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    fireEvent.click(await screen.findByRole("button", { name: "Short and direct" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save to memory" }));
    await waitFor(() => expect(finishSave).toBeTypeOf("function"));
    expect(resolved()).toBe("false");
    await act(async () => finishSave({ saveState: "failed", success: false, fullBlob: {} }));
    await screen.findByRole("button", { name: "Try again" });
    expect(resolved()).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(resolved()).toBe("true"));
  });
  it("releases profile discovery only after the whole optional conversation is skipped", async () => {
    setReducedMotion(true);
    render(<Harness />);
    for (let question = 0; question < 3; question++) {
      expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("false");
      fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    }
    await waitFor(() => expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("true"));
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();
  });
  it("waits for owner progress and does not inherit another owner's completed onboarding", async () => {
    vi.mocked(PkmDomainResourceService.getStaleFirst).mockImplementation(async ({ userId }) => ({
      key: { userId, domain: "identity", segmentIds: [], contentRevision: 1 },
      data: { communication_preferences: { preferred_name: userId === "u1" ? "Saved" : "" } },
    } as never));
    let finishLoad!: (value: Awaited<ReturnType<typeof PreVaultUserStateService.bootstrapState>>) => void;
    vi.mocked(PreVaultUserStateService.bootstrapState).mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve; }));
    const root = render(<Harness startSignal={false} />);
    expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("false");
    await act(async () => finishLoad({ oneChatOnboarding: null } as Awaited<ReturnType<typeof PreVaultUserStateService.bootstrapState>>));
    await waitFor(() => expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("true"));
    root.rerender(<Harness userId="new-owner" startSignal />);
    expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("false");
  });
  it("asks each question in turn, connects read-first, saves the chosen name, and confirms tone separately", async () => {
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
    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1);

    act(() => primeConnectorStatus({ userId: "u1", source: "status", status: {
      configured: true, connected: false, status: "disconnected", scope_csv: "",
      auto_sync_enabled: false, revoked: true,
    } }));
    expect(await screen.findByRole("button", { name: "Connect Gmail" })).toBeInTheDocument();
    expect(screen.queryByText("Gmail connected")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Short and direct" }));
    await screen.findByRole("button", { name: "Save to memory" });
    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    });
    await waitFor(() => expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(2));
    await screen.findByText(/Saved\. You can change it anytime in Memory\./);

    // The durable record never carries an answer value.
    for (const [, record] of vi.mocked(PreVaultUserStateService.syncOneChatOnboarding).mock.calls) {
      expect(JSON.stringify(record)).not.toMatch(/Kushal|short/i);
    }
    expect(vi.mocked(PreVaultUserStateService.syncOneChatOnboarding).mock.calls.at(-1)?.[1]).toMatchObject({
      status: "completed",
      answered: ["name", "focus", "tone"],
    });
  });

  it("Something else closes recommendations and leaves ordinary chat input alone", async () => {
    setReducedMotion(true);
    render(<Harness />);
    await screen.findByRole("button", { name: "Call me Kushal" });
    expect(screen.getByTestId("capture").textContent).toBe("Type what I should call you");

    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    await waitFor(() =>
      expect(screen.getByTestId("capture").textContent).toBe("null"),
    );
    expect(onEndConversation).toHaveBeenCalledTimes(1);
    // Later input never restarts the ended onboarding.
    fireEvent.click(screen.getByRole("button", { name: "type-unrelated" }));
    await waitFor(() => expect(screen.getByTestId("capture").textContent).toBe("null"));
    expect(screen.queryByRole("button", { name: "Call me Kushal" })).toBeNull();
    expect(screen.queryByTestId("chat-onboarding-chips")).toBeNull();
  });

  it("moves between chips with the arrow keys", async () => {
    setReducedMotion(true);
    render(<Harness />);
    const first = await screen.findByRole("button", { name: "Call me Kushal" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Something else" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Skip for now" }));
  });
});

describe("preferred name from encrypted identity", () => {
  const identity = (userId: string, name: string) => ({
    key: { userId, domain: "identity", segmentIds: [], contentRevision: 1 },
    data: { communication_preferences: { preferred_name: name } },
  });

  it("asks without a setup signal, saves once, and updates the label on a PKM event", async () => {
    setReducedMotion(true);
    render(<Harness startSignal={false} />);
    await screen.findByText("What would you like me to call you?");
    fireEvent.click(screen.getByText("type-name"));
    fireEvent.click(screen.getByText("type-name"));
    await waitFor(() => expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1));
    const call = vi.mocked(PkmWriteCoordinator.saveMergedDomain).mock.calls[0]![0];
    expect(call).toMatchObject({ userId: "u1", domain: "identity",
      confirmation: { confirmedByUser: true, source: "one_chat_onboarding" } });
    expect(call.build({ currentDomainData: { communication_preferences: { tone: "casual" } } } as never).domainData)
      .toMatchObject({ communication_preferences: { preferred_name: "Roopmann", tone: "casual" } });
    vi.mocked(PkmDomainResourceService.getStaleFirst).mockResolvedValue(identity("u1", "Roopmann") as never);
    act(() => dispatchLocalPkmDomainChanged({ userId: "u1", domain: "identity", operation: "stored", dataVersion: 2, updatedAt: null }));
    await waitFor(() => expect(screen.getByTestId("preferred-name")).toHaveTextContent("Roopmann"));
    vi.mocked(PkmDomainResourceService.getStaleFirst).mockResolvedValue(identity("u1", "Roop") as never);
    act(() => dispatchLocalPkmDomainChanged({ userId: "u1", domain: "identity", operation: "stored", dataVersion: 3, updatedAt: null }));
    expect(screen.getByTestId("preferred-name")).toHaveTextContent("Roopmann");
    await waitFor(() => expect(screen.getByTestId("preferred-name").textContent).toBe("Roop"));
  });

  it("shows a cached returning name immediately, skips the question, and clears it on lock", async () => {
    vi.mocked(PkmDomainResourceService.peek).mockReturnValue({ data: identity("u1", "Returning") } as never);
    vi.mocked(PkmDomainResourceService.getStaleFirst).mockResolvedValue(identity("u1", "Returning") as never);
    const view = render(<Harness startSignal={false} />);
    expect(screen.getByTestId("preferred-name")).toHaveTextContent("Returning");
    await waitFor(() => expect(screen.getByTestId("onboarding-resolved")).toHaveTextContent("true"));
    expect(screen.queryByText("What would you like me to call you?")).toBeNull();
    view.rerender(<Harness startSignal={false} unlocked={false} />);
    expect(screen.getByTestId("preferred-name").textContent).toBe("One");
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("never mistakes a pending or failed read for an absent name, or shows a previous owner's name", async () => {
    let finish!: (value: never) => void;
    vi.mocked(PkmDomainResourceService.getStaleFirst).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<Harness startSignal={false} />);
    expect(screen.queryByText("What would you like me to call you?")).toBeNull();
    vi.mocked(PkmDomainResourceService.getStaleFirst).mockRejectedValue(new Error("offline"));
    view.rerender(<Harness startSignal={false} userId="u2" />);
    await act(async () => finish(identity("u1", "Old owner") as never));
    expect(screen.getByTestId("preferred-name").textContent).toBe("One");
    expect(screen.queryByText("What would you like me to call you?")).toBeNull();
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();
  });
});
