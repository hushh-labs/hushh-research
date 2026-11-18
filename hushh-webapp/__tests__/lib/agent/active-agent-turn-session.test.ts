import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyActiveAgentTurnMessages,
  clearActiveAgentTurnSession,
  patchActiveAgentTurnSession,
  peekActiveAgentTurnSession,
  setActiveAgentTurnSession,
  subscribeActiveAgentTurnSession,
} from "@/lib/agent/active-agent-turn-session";

afterEach(() => {
  clearActiveAgentTurnSession(undefined, { abort: false });
});

describe("active-agent-turn-session", () => {
  it("preserves in-flight turns across route switches and scopes strictly by ownerId and vaultEpoch", () => {
    const turnToken = Symbol("turn-1");
    const abort = vi.fn();
    const listener = vi.fn();
    const unsubscribe = subscribeActiveAgentTurnSession("owner-1", listener);

    setActiveAgentTurnSession({
      ownerId: "owner-1",
      vaultEpoch: 3,
      turnToken,
      conversationId: "conv-123",
      messages: [
        { id: "u1", role: "user", text: "What did we decide?" },
        { id: "a1", role: "assistant", text: "", status: "streaming" },
      ],
      isChatLoading: true,
      isStreaming: true,
      stoppableTurn: false,
      startedAtMs: 1000,
      abort,
      stop: null,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(peekActiveAgentTurnSession("owner-1", 3)?.conversationId).toBe("conv-123");
    expect(peekActiveAgentTurnSession("owner-1", 4)).toBeNull();
    expect(peekActiveAgentTurnSession("owner-2", 3)).toBeNull();

    // Simulated route switch away and live token updates while unmounted:
    unsubscribe();
    applyActiveAgentTurnMessages<{ id: string; role: string; text: string; status?: string }>(
      "owner-1",
      turnToken,
      (messages) =>
        messages.map((msg) =>
          msg.id === "a1" ? { ...msg, text: "We decided on the northstar plan." } : msg,
        ),
    );
    patchActiveAgentTurnSession("owner-1", turnToken, {
      isChatLoading: false,
      isStreaming: false,
    });

    // Simulated remount reads the full live state synchronously:
    const remounted = peekActiveAgentTurnSession<{ id: string; text: string; status?: string }>("owner-1", 3);
    expect(remounted?.isChatLoading).toBe(false);
    expect(remounted?.messages[1]?.text).toBe("We decided on the northstar plan.");
    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts an in-flight stream synchronously on clearActiveAgentTurnSession (vault lock)", () => {
    const abort = vi.fn();
    setActiveAgentTurnSession({
      ownerId: "owner-1",
      vaultEpoch: 5,
      turnToken: Symbol("turn-2"),
      conversationId: "conv-456",
      messages: [],
      isChatLoading: true,
      isStreaming: true,
      stoppableTurn: true,
      startedAtMs: 2000,
      abort,
      stop: vi.fn(),
    });

    clearActiveAgentTurnSession("owner-1", { abort: true, reason: "vault_locked" });

    expect(abort).toHaveBeenCalledWith("vault_locked");
    expect(peekActiveAgentTurnSession("owner-1", 5)).toBeNull();
  });
});
