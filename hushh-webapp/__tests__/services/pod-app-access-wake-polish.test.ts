/**
 * Three honest-failure gaps on the direct chat path, found in review of the
 * 2026-10-06 wake work:
 * 1. Every hub 409 on chat-grants read as "your agent moved", although the hub
 *    also answers 409 for an agent that is still getting ready or migrating.
 * 2. A cancelled caller (the Puppy model list's timeout) kept waiting on the
 *    shared admission it could not cancel.
 * 3. With a cached session, a sleeping agent's first contact was the turn's own
 *    POST. An ingress reset there said "check your internet connection".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DeviceOfflineError,
  PodNotReachedError,
  PodSendUnconfirmedError,
} from "@/lib/agent/owner-pod-wake";
import { formatAgentChatErrorMessage } from "@/lib/services/agent-chat-client";
import { forgetAgentAnswers, ownerPodRequest } from "@/lib/services/pod-app-access";

const pod = vi.hoisted(() => ({
  loadPinnedEndpoint: vi.fn(),
  refreshEndpointFromHub: vi.fn(),
  currentPodConnection: vi.fn(),
  verifyHubSignature: vi.fn(async () => undefined),
}));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: () => ({ uid: "owner" }) } }));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  loadPinnedEndpoint: pod.loadPinnedEndpoint,
  refreshEndpointFromHub: pod.refreshEndpointFromHub,
  currentPodConnection: pod.currentPodConnection,
}));
vi.mock("@/lib/services/owner-pod-crypto", () => ({ verifyHubSignature: pod.verifyHubSignature }));

const URL = "https://ca-hussh-one-pod.example.eastus2.azurecontainerapps.io";
const PIN = { hushhId: "ha1_owner", url: URL, podKeyId: "podk_1", environment: "dev", endpointVersion: 2 };
const CAPABILITIES = `${URL}/api/one/pod/agent-chat/capabilities`;
const TURN = `${URL}/api/one/pod/agent-chat`;
const turnInit = () => ({ method: "POST", body: JSON.stringify({ messages: [], forwardedProps: {} }) });
const grants = () => new Response(JSON.stringify({
  endpoint: { ...PIN, signature: "ed25519.kid.sig" }, dataDoorGrants: { memory: "scoped" },
}));
const json409 = (detail: Record<string, unknown>) => new Response(JSON.stringify({ detail }), {
  status: 409, headers: { "content-type": "application/json" },
});
const gatewayPage = () => new Response("<html>starting</html>", { status: 503, headers: { "content-type": "text/html" } });

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
function harness(hub: () => Promise<Response>, fetch: Fetch) {
  const fetchSpy = vi.fn(fetch);
  const ports = { transport: async () => ({ hub: vi.fn(hub), direct: vi.fn() }), fetch: fetchSpy } as unknown as
    Parameters<typeof ownerPodRequest>[2];
  return { fetch: fetchSpy, ports };
}

async function refusal(request: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await request;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetAgentAnswers();
  pod.loadPinnedEndpoint.mockResolvedValue(PIN);
  pod.currentPodConnection.mockResolvedValue({ endpoint: PIN, session: { session: "pst1.cached" } });
});
afterEach(() => vi.restoreAllMocks());

describe("a hub 409 on chat grants says which 409 it is", () => {
  const shown = async (hubAnswer: Response) => {
    const { fetch, ports } = harness(async () => hubAnswer, async () => new Response("stream"));
    const error = await refusal(ownerPodRequest("agent-chat", turnInit(), ports));
    expect(fetch).not.toHaveBeenCalled();
    return { error, copy: formatAgentChatErrorMessage(error.message, error.code) };
  };

  it("tells a starting agent's owner to wait, not to reconnect", async () => {
    const { error, copy } = await shown(json409({ code: "AGENT_NOT_READY", status: "provisioning" }));
    expect(error.code).toBe("POD_CHAT_AUTHORITY_UNAVAILABLE:409:AGENT_NOT_READY");
    expect(copy).toBe("Your private agent isn't ready to chat yet. Try again in a moment. If this keeps happening, open Hosting in Settings.");
    expect(copy).not.toMatch(/moved|reconnect/i);
  });

  it("shows the hub's own migrating sentence, and a fixed one when it is not plain words", async () => {
    const hubSentence = "Your agent is moving to your cloud. This takes a minute or two.";
    expect((await shown(json409({ code: "AGENT_MIGRATING", status: "migrating", message: hubSentence }))).copy)
      .toBe(hubSentence);
    const unsafe = await shown(json409({ code: "AGENT_MIGRATING", message: "See https://evil.example/x now." }));
    expect(unsafe.copy).toBe(hubSentence);
    expect(unsafe.copy).not.toContain("evil");
  });

  it("keeps the moved copy for a real move, and stays neutral for any other 409", async () => {
    expect((await shown(json409({ code: "POD_ASSIGNMENT_CHANGED" }))).copy).toMatch(/^Your private agent moved/);
    for (const other of [json409({ code: "POD_IDENTITY_NOT_DURABLE" }), new Response("conflict", { status: 409 })]) {
      const { copy } = await shown(other);
      expect(copy).toBe("Hussh could not confirm this chat with your private agent. Try again in a moment.");
    }
  });
});

describe("a cancelled caller stops waiting on shared admission", () => {
  const pending = () => new Promise<never>(() => undefined);
  const cancelledWithin = async (request: Promise<unknown>, abort: () => void) => {
    const outcome = Promise.race([
      request.then(() => "answered", (error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 200)),
    ]);
    abort();
    return outcome;
  };

  it("for the Puppy model list while the agent session is still being opened", async () => {
    pod.currentPodConnection.mockReturnValue(pending());
    const { fetch, ports } = harness(async () => grants(), async () => new Response("{}"));
    const caller = new AbortController();
    const request = ownerPodRequest("puppy/models?deviceId=tdv_1", { method: "GET", signal: caller.signal }, ports);
    await vi.waitFor(() => expect(pod.currentPodConnection).toHaveBeenCalledOnce());
    const outcome = await cancelledWithin(request, () => caller.abort(new DOMException("timed out", "TimeoutError")));
    expect(outcome).toMatchObject({ name: "TimeoutError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("while the endpoint is still being read from the hub", async () => {
    pod.loadPinnedEndpoint.mockResolvedValue(null);
    pod.refreshEndpointFromHub.mockReturnValue(pending());
    const { ports } = harness(async () => grants(), async () => new Response("{}"));
    const caller = new AbortController();
    const request = ownerPodRequest("puppy/models?deviceId=tdv_1", { method: "GET", signal: caller.signal }, ports);
    await vi.waitFor(() => expect(pod.refreshEndpointFromHub).toHaveBeenCalledOnce());
    const outcome = await cancelledWithin(request, () => caller.abort(new DOMException("cancelled", "AbortError")));
    expect(outcome).toMatchObject({ name: "AbortError" });
    expect(pod.currentPodConnection).not.toHaveBeenCalled();
  });
});

describe("a sleeping agent whose first contact would be the turn itself", () => {
  it("asks a cold agent first, so an ingress reset provably did not send the turn", async () => {
    const { fetch, ports } = harness(async () => grants(), async (url) => {
      if (url === CAPABILITIES) throw new TypeError("Failed to fetch");
      return new Response("stream");
    });
    await expect(ownerPodRequest("agent-chat", turnInit(), ports)).rejects.toBeInstanceOf(PodNotReachedError);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([CAPABILITIES]);
  });

  it("treats a gateway page on that first question as still waking, and never sends the turn", async () => {
    const { fetch, ports } = harness(async () => grants(), async (url) => (url === CAPABILITIES ? gatewayPage() : new Response("stream")));
    await expect(ownerPodRequest("agent-chat", turnInit(), ports)).rejects.toBeInstanceOf(PodNotReachedError);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([CAPABILITIES]);
  });

  it("says the message may not have been sent when the turn's own connection resets", async () => {
    const { fetch, ports } = harness(async () => grants(), async (url) => {
      if (url === TURN) throw new TypeError("Failed to fetch");
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    const error = await refusal(ownerPodRequest("agent-chat", turnInit(), ports));
    expect(error).toBeInstanceOf(PodSendUnconfirmedError);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([CAPABILITIES, TURN]);
    expect(formatAgentChatErrorMessage(error.message, error.code))
      .toBe("The connection to your private agent dropped, so your message may not have been sent. Check this chat before you send it again.");
  });

  it("sends straight out to an agent that just answered", async () => {
    const { fetch, ports } = harness(async () => grants(), async () => new Response("stream"));
    await ownerPodRequest("agent-chat", turnInit(), ports);
    await ownerPodRequest("agent-chat", turnInit(), ports);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([CAPABILITIES, TURN, TURN]);
  });

  it("tells an offline device it is offline instead of showing a wake", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { ports } = harness(async () => grants(), async () => { throw new TypeError("Failed to fetch"); });
    const error = await refusal(ownerPodRequest("agent-chat", turnInit(), ports));
    expect(error).toBeInstanceOf(DeviceOfflineError);
    expect(formatAgentChatErrorMessage(error.message, error.code)).toMatch(/^This device is offline, so your message was not sent/);
  });
});
