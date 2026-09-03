/**
 * A person who has a pod must be answered BY that pod.
 *
 * The router's evidence is two fields from one poll, and `podState === null` is
 * ambiguous: it is both "we have not looked yet" and "this person has no agent".
 * Reading the first as the second sent a fast typer's opening message to the
 * shared hub while their own pod sat idle -- and nothing on screen said so, which
 * is the "own your compute" claim quietly not holding.
 *
 * These tests pin the resolution: hold the turn until the status endpoint has
 * answered, then route on the answer. Bounded, because a person with genuinely no
 * agent must still be able to talk, and the hub is the correct destination for them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runPodTurn = vi.fn();
const streamAgentChat = vi.fn();

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    runPodTurn,
    getFirebaseToken: vi.fn(),
  },
}));

vi.mock("@/lib/utils/timezone", () => ({
  resolveBrowserTimeZone: () => "UTC",
}));

const POD_ANSWER = {
  text: "answered by your pod",
  model: "gemini-3.7-flash",
  runtimeMode: "user_adc",
  grounded: false,
};

describe("agent chat routes to the person's own pod", () => {
  beforeEach(() => {
    runPodTurn.mockReset().mockResolvedValue(POD_ANSWER);
    streamAgentChat.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the pod verdict instead of answering from the hub", async () => {
    const { runAgentChatTurn } = await import("@/lib/services/agent-chat-client");
    // The status read has not landed yet: the address is unknown, not absent.
    let resolvedYet = false;
    const readPodAddress = () =>
      resolvedYet
        ? { hushhId: "ha1_theirs", state: "active", resolved: true }
        : { hushhId: null, state: null, resolved: false };
    setTimeout(() => {
      resolvedYet = true;
    }, 300);

    const result = await runAgentChatTurn({
      message: "hello",
      podHushhId: null,
      podState: null,
      podResolved: false,
      readPodAddress,
    } as never);

    expect(runPodTurn).toHaveBeenCalledTimes(1);
    expect(runPodTurn.mock.calls[0][0].hushhId).toBe("ha1_theirs");
    expect(result.cell).toBe("pod");
  });

  it("still lets a person with no agent talk, once the verdict says so", async () => {
    const { runAgentChatTurn, POD_VERDICT_WAIT_MS } = await import(
      "@/lib/services/agent-chat-client"
    );
    // Resolved, and the answer is genuinely "no pod" -- the hub is correct here.
    const readPodAddress = () => ({ hushhId: null, state: null, resolved: true });

    const started = Date.now();
    await runAgentChatTurn({
      message: "hello",
      podHushhId: null,
      podState: null,
      podResolved: true,
      readPodAddress,
    } as never).catch(() => undefined);

    expect(runPodTurn).not.toHaveBeenCalled();
    // It must not have burned the wait: a resolved verdict is acted on at once.
    expect(Date.now() - started).toBeLessThan(POD_VERDICT_WAIT_MS);
  });

  it("does not hang forever when the verdict never arrives", async () => {
    const { runAgentChatTurn, POD_VERDICT_WAIT_MS } = await import(
      "@/lib/services/agent-chat-client"
    );
    const readPodAddress = () => ({ hushhId: null, state: null, resolved: false });

    const started = Date.now();
    await runAgentChatTurn({
      message: "hello",
      podHushhId: null,
      podState: null,
      podResolved: false,
      readPodAddress,
    } as never).catch(() => undefined);

    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(POD_VERDICT_WAIT_MS - 200);
    expect(runPodTurn).not.toHaveBeenCalled();
  });

  it("routes straight to the pod when the address is already known", async () => {
    const { runAgentChatTurn } = await import("@/lib/services/agent-chat-client");
    const result = await runAgentChatTurn({
      message: "hello",
      podHushhId: "ha1_theirs",
      podState: "active",
      podResolved: true,
    } as never);
    expect(runPodTurn).toHaveBeenCalledTimes(1);
    expect(result.cell).toBe("pod");
  });

  it("seeds the pod with the visible transcript, because a pod holds no session", async () => {
    // The relay, the route and the runner all accepted `history`; this client was the
    // only caller and never sent it, so every pod turn started from nothing.
    const { runAgentChatTurn } = await import("@/lib/services/agent-chat-client");
    const history = [
      { role: "user" as const, content: "my dog is called Biscuit" },
      { role: "assistant" as const, content: "Noted: Biscuit." },
    ];
    await runAgentChatTurn({
      message: "what is my dog called?",
      podHushhId: "ha1_theirs",
      podState: "active",
      podResolved: true,
      history,
    } as never);
    expect(runPodTurn.mock.calls[0][0].history).toEqual(history);
  });
});
