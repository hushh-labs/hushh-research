/**
 * One's chat transport wakes a sleeping private agent instead of failing the
 * turn, and only for a turn that is routed to the owner's own agent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentChatRequest: vi.fn(),
  getPersonalAgentStatus: vi.fn(),
  usesOwnerPod: vi.fn(),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { agentChatRequest: mocks.agentChatRequest, getPersonalAgentStatus: mocks.getPersonalAgentStatus },
}));
vi.mock("@/lib/services/pod-app-access", () => ({ usesOwnerPod: mocks.usesOwnerPod }));
vi.mock("@/lib/agent/owner-pod-wake", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/owner-pod-wake")>();
  return {
    ...actual,
    sendWhileAgentWakes: (send: () => Promise<Response>, ports: Parameters<typeof actual.sendWhileAgentWakes>[1]) =>
      actual.sendWhileAgentWakes(send, { ...ports, wait: async () => undefined }),
  };
});

import { wakingChatTransport } from "@/lib/agent/one-chat-transport";

const starting = () => new Response("starting", { status: 503, headers: { "content-type": "text/plain" } });

describe("wakingChatTransport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the same turn again once the owner's agent is up, and reports waking", async () => {
    mocks.usesOwnerPod.mockResolvedValue(true);
    mocks.agentChatRequest.mockResolvedValueOnce(starting()).mockResolvedValueOnce(new Response("stream"));
    const onWaking = vi.fn();
    const onAdmission = vi.fn();
    const init = { method: "POST", body: "{\"messages\":[]}" };
    const response = await wakingChatTransport(init, onWaking, onAdmission);
    expect(response.status).toBe(200);
    expect(onWaking).toHaveBeenCalledOnce();
    expect(mocks.agentChatRequest).toHaveBeenCalledTimes(2);
    for (const call of mocks.agentChatRequest.mock.calls) {
      expect(call).toEqual(["/api/one/agent-chat", init, true, onAdmission]);
    }
  });

  it("leaves a Shared-hosting 503 to the existing strain notice", async () => {
    mocks.usesOwnerPod.mockResolvedValue(false);
    mocks.agentChatRequest.mockResolvedValue(starting());
    const onWaking = vi.fn();
    expect((await wakingChatTransport({ method: "POST" }, onWaking, vi.fn())).status).toBe(503);
    expect(onWaking).not.toHaveBeenCalled();
    expect(mocks.agentChatRequest).toHaveBeenCalledOnce();
  });
});
