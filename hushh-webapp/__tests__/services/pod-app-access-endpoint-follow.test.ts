/**
 * Live 2026-10-06 04:05 UTC: the hub re-published the owner's Azure agent at
 * endpoint version 2 (same address, same key) while the browser held version 1.
 * Every One chat turn then failed after its chat grants and before the turn was
 * sent ("One couldn't complete that response"), and Try again failed the same
 * way, because nothing ever moved the pin forward. Reproduced in Chromium on
 * dev.one.hushh.ai by rewriting a fresh pin to version 1.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PodNotReachedError } from "@/lib/agent/owner-pod-wake";
import { forgetAgentAnswers, ownerPodRequest } from "@/lib/services/pod-app-access";

const pod = vi.hoisted(() => ({
  loadPinnedEndpoint: vi.fn(),
  refreshEndpointFromHub: vi.fn(),
  currentPodConnection: vi.fn(),
  verifyHubSignature: vi.fn(async () => undefined),
}));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: () => ({ uid: "owner" }) } }));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  loadPinnedEndpoint: pod.loadPinnedEndpoint,
  refreshEndpointFromHub: pod.refreshEndpointFromHub,
  currentPodConnection: pod.currentPodConnection,
}));
vi.mock("@/lib/services/owner-pod-crypto", () => ({ verifyHubSignature: pod.verifyHubSignature }));

const URL = "https://ca-hussh-one-pod.example.eastus2.azurecontainerapps.io";
const V1 = { hushhId: "ha1_owner", url: URL, podKeyId: "podk_1", environment: "dev", endpointVersion: 1 };
const V2 = { ...V1, endpointVersion: 2 };
const turnInit = () => ({
  method: "POST",
  body: JSON.stringify({ messages: [{ role: "user", content: "what do you remember about me" }], forwardedProps: {} }),
});
const grantsFor = (endpoint: Record<string, unknown>) =>
  new Response(JSON.stringify({ endpoint: { ...endpoint, signature: "ed25519.kid.sig" }, dataDoorGrants: { memory: "scoped" } }));

function harness(hubEndpoint: Record<string, unknown>) {
  const hub = vi.fn(async () => grantsFor(hubEndpoint));
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response("stream"));
  const ports = { transport: async () => ({ hub, direct: vi.fn() }), fetch } as unknown as Parameters<typeof ownerPodRequest>[2];
  return { hub, fetch, ports };
}

describe("a chat turn follows its agent's re-versioned endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetAgentAnswers();
    pod.loadPinnedEndpoint.mockResolvedValue(V1);
    pod.currentPodConnection.mockResolvedValueOnce({ endpoint: V1, session: { session: "pst1.old" } });
  });

  it("re-admits the newer hub-signed version once, then sends the turn with the new session", async () => {
    const { hub, fetch, ports } = harness(V2);
    pod.refreshEndpointFromHub.mockResolvedValue(V2);
    pod.currentPodConnection.mockResolvedValueOnce({ endpoint: V2, session: { session: "pst1.new" } });

    await ownerPodRequest("agent-chat", turnInit(), ports);

    expect(pod.refreshEndpointFromHub).toHaveBeenCalledOnce();
    expect(hub).toHaveBeenCalledTimes(2);
    // A cold agent is asked a side-effect-free question first, at the followed address.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe(`${URL}/api/one/pod/agent-chat/capabilities`);
    const [url, init] = fetch.mock.calls[1];
    expect(url).toBe(`${URL}/api/one/pod/agent-chat`);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer pst1.new");
    expect(JSON.parse(String(init.body)).forwardedProps.dataDoorGrants).toEqual({ memory: "scoped" });
  });

  it("still refuses a rollback, a changed address at the same version, and another agent", async () => {
    for (const hubEndpoint of [
      { ...V1, endpointVersion: 0 },
      { ...V1, url: "https://elsewhere.example" },
      { ...V2, hushhId: "ha1_someone_else" },
    ]) {
      pod.currentPodConnection.mockResolvedValueOnce({ endpoint: V1, session: { session: "pst1.old" } });
      const { fetch, ports } = harness(hubEndpoint);
      await expect(ownerPodRequest("agent-chat", turnInit(), ports)).rejects.toThrow("POD_ASSIGNMENT_CHANGED");
      expect(fetch).not.toHaveBeenCalled();
    }
    expect(pod.refreshEndpointFromHub).not.toHaveBeenCalled();
  });

  it("refuses when re-admission lands on a different version than the hub signed", async () => {
    const { fetch, ports } = harness(V2);
    pod.refreshEndpointFromHub.mockResolvedValue(V1);
    pod.currentPodConnection.mockResolvedValueOnce({ endpoint: V1, session: { session: "pst1.old" } });
    await expect(ownerPodRequest("agent-chat", turnInit(), ports)).rejects.toThrow("POD_ASSIGNMENT_CHANGED");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("a waking agent during admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetAgentAnswers();
    pod.loadPinnedEndpoint.mockResolvedValue(V2);
  });

  it("marks a chat turn's admission network failure as not sent, and leaves other routes' errors alone", async () => {
    const { fetch, ports } = harness(V2);
    pod.currentPodConnection.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(ownerPodRequest("agent-chat", turnInit(), ports)).rejects.toBeInstanceOf(PodNotReachedError);
    // Files reads already treat a TypeError as transient; that contract is unchanged.
    pod.currentPodConnection.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(ownerPodRequest("files/list", { method: "GET" }, ports)).rejects.toBeInstanceOf(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
