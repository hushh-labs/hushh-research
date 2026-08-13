/**
 * A turn must run on the person's own pod when they have one, and say so.
 *
 * `ApiService.runPodTurn` was complete and had ZERO callers. Every turn went to the
 * shared hub even for someone whose pod was live and serving, which made the north
 * star's central claim -- "their complete agent ecosystem runs in their pod" --
 * unreachable from the product. So the first assertion here is about ROUTING, not about
 * the pod client, which was never the broken part.
 *
 * The other three are honesty properties, and each protects a specific temptation:
 *
 *   - the answer must say which cell served it, or "your own private agent" is an
 *     unverifiable claim;
 *   - a pod failure must NOT silently fall back to the hub, because the person would
 *     then believe their pod answered a turn it never saw;
 *   - a pod answer must not be sliced into fake tokens to imitate streaming, because a
 *     typing animation for text that already arrived misreports where the latency went.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const runPodTurn = vi.fn();
const streamAgentChat = vi.fn();

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    runPodTurn: (...args: unknown[]) => runPodTurn(...args),
    streamAgentChat: (...args: unknown[]) => streamAgentChat(...args),
  },
}));

import { runAgentChatTurn } from "@/lib/services/agent-chat-client";

const BASE = {
  userId: "u1",
  message: "what do you know about me?",
  vaultOwnerToken: "vault-token",
};

beforeEach(() => {
  runPodTurn.mockReset();
  streamAgentChat.mockReset();
});

describe("turn cell routing", () => {
  it("runs on the person's pod when they have a live one", async () => {
    runPodTurn.mockResolvedValue({
      hushhId: "ha1_abc",
      text: "I remember your last trip.",
      model: "gemini",
      provider: "vertex",
      grounded: true,
      runtimeMode: "user_adc",
    });

    const result = await runAgentChatTurn({ ...BASE, podHushhId: "ha1_abc", podState: "active" });

    expect(runPodTurn).toHaveBeenCalledTimes(1);
    expect(streamAgentChat).not.toHaveBeenCalled();
    expect(result.cell).toBe("pod");
    expect(result.grounded).toBe(true);
  });

  it.each([
    ["no pod at all", null, null],
    ["a pod still connecting", "ha1_abc", "connecting"],
    ["a pod that failed", "ha1_abc", "failed"],
    ["a reserved identity with no host", "ha1_abc", "reserved"],
  ])("does not reach for the pod on %s", async (_case, hushhId, state) => {
    // Only `active` is answerable. Sending a turn to a pod that is mid-handshake would
    // produce AGENT_NOT_READY for a state the client could already see.
    //
    // Asserts the ROUTING decision only. The hub leg then runs the real SSE client,
    // which needs a live stream and is covered by its own tests -- so it is allowed to
    // fail here rather than being mocked into a second, weaker copy of those tests.
    runPodTurn.mockRejectedValue(new Error("the pod must not be consulted"));
    await runAgentChatTurn({ ...BASE, podHushhId: hushhId, podState: state }).catch(() => {});
    expect(runPodTurn).not.toHaveBeenCalled();
  });

  it("delivers a pod answer as ONE token rather than imitating a stream", async () => {
    runPodTurn.mockResolvedValue({
      hushhId: "ha1_abc",
      text: "a complete answer that arrived all at once",
      model: "gemini",
      provider: "vertex",
      grounded: false,
      runtimeMode: "user_adc",
    });
    const tokens: string[] = [];

    await runAgentChatTurn({
      ...BASE,
      podHushhId: "ha1_abc",
      podState: "active",
      handlers: { onToken: (t) => tokens.push(t) },
    });

    expect(tokens).toEqual(["a complete answer that arrived all at once"]);
  });

  it("does not fall back to the hub when the pod refuses", async () => {
    // Each of runPodTurn's typed errors is about THIS person's pod and has its own
    // remedy. Answering from the hub anyway would hide the fault behind a correct-looking
    // reply -- the same defect as a 200 on an empty page.
    runPodTurn.mockRejectedValue(new Error("AGENT_NOT_READY:connecting"));
    const errors: string[] = [];

    await expect(
      runAgentChatTurn({
        ...BASE,
        podHushhId: "ha1_abc",
        podState: "active",
        handlers: { onError: (m) => errors.push(m) },
      }),
    ).rejects.toThrow("AGENT_NOT_READY:connecting");

    expect(streamAgentChat).not.toHaveBeenCalled();
    expect(errors).toEqual(["AGENT_NOT_READY:connecting"]);
  });

  it("carries the owner's decrypted projection to the pod", async () => {
    // This is what makes a pod turn grounded WITHOUT the pod holding PKM or reaching a
    // database -- the projection is opened by the owner's key on the owner's device.
    // Dropping it would leave the pod answering ungrounded while the hub answered
    // grounded, which reads to the person as their own agent knowing them less.
    runPodTurn.mockResolvedValue({
      hushhId: "ha1_abc",
      text: "ok",
      model: "m",
      provider: "p",
      grounded: true,
      runtimeMode: "user_adc",
    });

    await runAgentChatTurn({
      ...BASE,
      podHushhId: "ha1_abc",
      podState: "active",
      pkmContext: "the owner's projection",
    });

    expect(runPodTurn.mock.calls[0][0].pkmContext).toBe("the owner's projection");
  });
});
