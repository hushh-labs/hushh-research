import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentBubble } from "@/components/agent/agent-chat-workspace";
import { ChatOnboardingTurns } from "@/components/agent/chat-onboarding/chat-onboarding-transcript";
import {
  useChatOnboarding,
  useChatOnboardingSession,
} from "@/lib/agent/chat-onboarding/use-chat-onboarding";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
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

const onConnect = vi.fn();
/** Every (turn id, status) the transcript hands to the real assistant bubble. */
const bubbleCalls: { id: string; status: string; role: string }[] = [];

function Harness({ messages = [] as { id: string }[] }) {
  const gmail = useGmailConnectorStatus({ userId: "u1", enabled: false });
  const controller = useChatOnboarding({
    userId: "u1",
    displayName: "Kushal",
    vaultKey: "vault-key",
    vaultOwnerToken: "owner-token",
    isVaultUnlocked: true,
    startSignal: true,
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
        renderBubble={(message) => {
          bubbleCalls.push({ id: message.id, status: message.status, role: message.role });
          return <AgentBubble message={message} />;
        }}
        onConnect={onConnect}
        gmailConnected={Boolean(gmail.status?.connected && !gmail.status.revoked && !gmail.status.needs_reauth)}
      />
      <output data-testid="capture">{String(controller.composerPlaceholder)}</output>
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
  vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockResolvedValue({
    saveState: "saved",
    success: true,
    fullBlob: {},
  });
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
  it("asks each question in turn, connects read-first, and saves only on confirmation", async () => {
    setReducedMotion(true);
    render(<Harness />);

    fireEvent.click(await screen.findByRole("button", { name: "Call me Kushal" }));
    fireEvent.click(await screen.findByRole("button", { name: "Email" }));

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

    // The durable record never carries an answer value.
    for (const [, record] of vi.mocked(PreVaultUserStateService.syncOneChatOnboarding).mock.calls) {
      expect(JSON.stringify(record)).not.toMatch(/Kushal|short/i);
    }
    expect(vi.mocked(PreVaultUserStateService.syncOneChatOnboarding).mock.calls.at(-1)?.[1]).toMatchObject({
      status: "completed",
      answered: ["name", "focus", "tone"],
    });
  });

  it("lets unrelated typing through, and only an explicit choice arms the name field", async () => {
    setReducedMotion(true);
    render(<Harness />);
    await screen.findByRole("button", { name: "Call me Kushal" });
    expect(screen.getByTestId("capture").textContent).toBe("null");

    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    await waitFor(() =>
      expect(screen.getByTestId("capture").textContent).toBe("Type what I should call you"),
    );
    // A question is not a name: it goes to One, and the name question waits.
    fireEvent.click(screen.getByRole("button", { name: "type-unrelated" }));
    await waitFor(() => expect(screen.getByTestId("capture").textContent).toBe("null"));
    expect(screen.getAllByRole("button", { name: "Call me Kushal" }).length).toBeGreaterThan(0);
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
