import { describe, expect, it, vi } from "vitest";

import {
  AgentWakeTimeoutError,
  PodNotReachedError,
  WAKE_BUDGET_MS,
  beforeTurnIsSent,
  isAgentStillWaking,
  sendWhileAgentWakes,
} from "@/lib/agent/owner-pod-wake";

/**
 * A private agent that scales to zero is woken, not failed. Only outcomes that
 * prove the turn never reached the agent are resent; everything else is the
 * agent's own answer and goes back to the caller untouched.
 */
const gateway = (status = 503) => new Response("<html>upstream starting</html>", {
  status, headers: { "content-type": "text/html" },
});
const agentRefusal = () => new Response(JSON.stringify({ detail: { code: "POD_CHAT_BUSY" } }), {
  status: 503, headers: { "content-type": "application/json" },
});
const ok = () => new Response("stream", { status: 200, headers: { "content-type": "text/event-stream" } });

function clock() {
  let at = 0;
  const waits: number[] = [];
  return {
    now: () => at,
    wait: vi.fn(async (ms: number, signal?: AbortSignal | null) => {
      if (signal?.aborted) throw signal.reason;
      waits.push(ms);
      at += ms;
    }),
    waits,
  };
}

function ports(overrides: Partial<Parameters<typeof sendWhileAgentWakes>[1]> = {}) {
  const c = clock();
  return {
    clock: c,
    ports: {
      onWaking: vi.fn(),
      isOwnerAgent: vi.fn(async () => true),
      now: c.now,
      wait: c.wait,
      ...overrides,
    },
  };
}

describe("waking a sleeping private agent", () => {
  it("resends the same turn while the agent's ingress says it is starting, and says so once", async () => {
    const send = vi.fn<() => Promise<Response>>()
      .mockResolvedValueOnce(gateway(503))
      .mockResolvedValueOnce(gateway(502))
      .mockResolvedValueOnce(ok());
    const { ports: p, clock: c } = ports();
    const response = await sendWhileAgentWakes(send, p);
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);
    expect(p.onWaking).toHaveBeenCalledOnce();
    expect(c.waits).toEqual([2_000, 4_000]);
  });

  it("shows waking when the agent's first byte is slow, then returns its answer", async () => {
    vi.useFakeTimers();
    try {
      let answer!: (response: Response) => void;
      const send = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
      const { ports: p } = ports({ hintMs: 3_000 });
      const pending = sendWhileAgentWakes(send, p);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(p.onWaking).not.toHaveBeenCalled(); // negative control: not a moment early
      await vi.advanceTimersByTimeAsync(1);
      expect(p.onWaking).toHaveBeenCalledOnce();
      answer(ok());
      expect((await pending).status).toBe(200);
      expect(send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the agent's own JSON refusal untouched (busy is an answer, not a wake)", async () => {
    const send = vi.fn(async () => agentRefusal());
    const { ports: p } = ports();
    const response = await sendWhileAgentWakes(send, p);
    expect(response.status).toBe(503);
    expect(send).toHaveBeenCalledOnce();
    expect(p.onWaking).not.toHaveBeenCalled();
  });

  it("never wakes or resends for a turn that does not go to the owner's own agent", async () => {
    const send = vi.fn(async () => gateway(503));
    const { ports: p } = ports({ isOwnerAgent: vi.fn(async () => false) });
    expect((await sendWhileAgentWakes(send, p)).status).toBe(503);
    expect(send).toHaveBeenCalledOnce();
    expect(p.onWaking).not.toHaveBeenCalled();
  });

  it("resends after a failure before the turn was handed over, never after an ambiguous one", async () => {
    const send = vi.fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new PodNotReachedError())
      .mockRejectedValueOnce(new Error("POD_CHALLENGE_REFUSED:504"))
      .mockResolvedValueOnce(ok());
    const { ports: p } = ports();
    expect((await sendWhileAgentWakes(send, p)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);

    // A network failure on the send itself may have reached the agent: report it.
    const ambiguous = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(sendWhileAgentWakes(ambiguous, ports().ports)).rejects.toThrow("Failed to fetch");
    expect(ambiguous).toHaveBeenCalledOnce();
    // A real refusal is not a wake either.
    const revoked = vi.fn(async () => { throw new Error("POD_ADMISSION_REFUSED:revoked"); });
    await expect(sendWhileAgentWakes(revoked, ports().ports)).rejects.toThrow("POD_ADMISSION_REFUSED:revoked");
    expect(revoked).toHaveBeenCalledOnce();
  });

  it("gives up with a typed timeout once the wake budget is spent, without sending again", async () => {
    const send = vi.fn(async () => gateway(504));
    const { ports: p, clock: c } = ports();
    await expect(sendWhileAgentWakes(send, p)).rejects.toBeInstanceOf(AgentWakeTimeoutError);
    expect(c.waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(WAKE_BUDGET_MS);
    expect(send.mock.calls.length).toBeGreaterThan(3);
  });

  it("stops at once when the person cancels during a wait", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => {
      controller.abort(new DOMException("Agent turn cancelled", "AbortError"));
      return gateway(503);
    });
    const { ports: p } = ports({ signal: controller.signal });
    await expect(sendWhileAgentWakes(send, p)).rejects.toMatchObject({ name: "AbortError" });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("what counts as still waking", () => {
  it("is a gateway status that is not the agent's own JSON, or a pre-send network failure", () => {
    expect(isAgentStillWaking(gateway(503))).toBe(true);
    expect(isAgentStillWaking(agentRefusal())).toBe(false);
    expect(isAgentStillWaking(new Response("", { status: 500 }))).toBe(false);
    expect(isAgentStillWaking(new PodNotReachedError())).toBe(true);
    expect(isAgentStillWaking(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("marks a network failure before the turn is sent, and passes other errors through", async () => {
    await expect(beforeTurnIsSent(async () => { throw new TypeError("Failed to fetch"); }))
      .rejects.toBeInstanceOf(PodNotReachedError);
    await expect(beforeTurnIsSent(async () => { throw new Error("POD_SESSION_REVOKED"); }))
      .rejects.toThrow("POD_SESSION_REVOKED");
    await expect(beforeTurnIsSent(async () => 7)).resolves.toBe(7);
  });
});
