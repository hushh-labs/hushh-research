import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import {
  forgetAgentAnswers,
  ownerPodRequest,
  resetCachedChatGrantsForTests,
} from "@/lib/services/pod-app-access";

const pod = vi.hoisted(() => ({
  loadPinnedEndpoint: vi.fn(),
  refreshEndpointFromHub: vi.fn(),
  currentPodConnection: vi.fn(),
  verifyHubSignature: vi.fn(async () => undefined),
}));

vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getCurrentUser: () => ({ uid: "owner" }) },
}));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  loadPinnedEndpoint: pod.loadPinnedEndpoint,
  refreshEndpointFromHub: pod.refreshEndpointFromHub,
  currentPodConnection: pod.currentPodConnection,
}));
vi.mock("@/lib/services/owner-pod-crypto", () => ({
  verifyHubSignature: pod.verifyHubSignature,
}));

const URL = "https://sandbox.example.hushh.test";
const PIN = {
  hushhId: "ha1_owner",
  url: URL,
  podKeyId: "podk_1",
  environment: "dev",
  endpointVersion: 2,
};

function makePorts() {
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
  const ports = {
    transport: async () => ({ hub: vi.fn(), direct: vi.fn() }),
    fetch: fetchSpy,
  } as unknown as Parameters<typeof ownerPodRequest>[2];
  return { fetchSpy, ports };
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetAgentAnswers();
  resetCachedChatGrantsForTests();
  publishValidatedAuthSessionPrincipal({
    firebaseUid: "owner",
    ownerId: "owner",
    accountGeneration: 1,
  });
  pod.loadPinnedEndpoint.mockResolvedValue(PIN);
  pod.currentPodConnection.mockResolvedValue({
    endpoint: PIN,
    session: {
      session: "pst1.cached",
      subjectId: "sub_1",
      role: "app",
      scopes: ["pod.config", "pod.status"],
    },
  });
});

afterEach(() => vi.restoreAllMocks());

describe("ownerPodRequest ai-selection allowlist and credential guards", () => {
  it("allows POST ai-selection/activate with metadata-only provider and configId", async () => {
    const { fetchSpy, ports } = makePorts();
    const res = await ownerPodRequest(
      "ai-selection/activate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", configId: "cfg_1" }),
      },
      ports,
    );
    expect(res).toBeInstanceOf(Response);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${URL}/api/one/pod/ai-selection/activate`);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({ provider: "openai", configId: "cfg_1" });
    expect("apiKey" in sent).toBe(false);
  });

  it("rejects ai-selection/activate when credential keys, bad methods, or bad session scopes are present", async () => {
    const { fetchSpy, ports } = makePorts();

    for (const forbidden of [
      { provider: "openai", apiKey: "sk-leak" },
      { provider: "gemini", credential: "AIza-leak" },
      { provider: "openai", secret: "sec-leak" },
      { provider: "openai", token: "tok-leak" },
      { provider: "azure_openai", configId: "cfg_1" },
    ]) {
      await expect(
        ownerPodRequest(
          "ai-selection/activate",
          { method: "POST", body: JSON.stringify(forbidden) },
          ports,
        ),
      ).rejects.toThrow("POD_AI_SELECTION_INVALID");
    }

    await expect(
      ownerPodRequest("ai-selection/activate", { method: "GET" }, ports),
    ).rejects.toThrow("POD_AI_SELECTION_INVALID");

    pod.currentPodConnection.mockResolvedValueOnce({
      endpoint: PIN,
      session: { session: "pst1.cached", subjectId: "sub_1", role: "peer", scopes: ["pod.config"] },
    });
    await expect(
      ownerPodRequest(
        "ai-selection/activate",
        { method: "POST", body: JSON.stringify({ provider: "gemini" }) },
        ports,
      ),
    ).rejects.toThrow("POD_AI_SELECTION_INVALID");

    pod.currentPodConnection.mockResolvedValueOnce({
      endpoint: PIN,
      session: { session: "pst1.cached", subjectId: "sub_1", role: "app", scopes: ["pod.status"] },
    });
    await expect(
      ownerPodRequest(
        "ai-selection/activate",
        { method: "POST", body: JSON.stringify({ provider: "gemini" }) },
        ports,
      ),
    ).rejects.toThrow("POD_AI_SELECTION_INVALID");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows empty POST ai-selection/deactivate and rejects invalid payloads, methods, or scopes", async () => {
    const { fetchSpy, ports } = makePorts();
    const res = await ownerPodRequest("ai-selection/deactivate", { method: "POST" }, ports);
    expect(res).toBeInstanceOf(Response);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`${URL}/api/one/pod/ai-selection/deactivate`);

    fetchSpy.mockClear();
    for (const badBody of ["{}", ""]) {
      await expect(
        ownerPodRequest("ai-selection/deactivate", { method: "POST", body: badBody }, ports),
      ).rejects.toThrow("POD_AI_SELECTION_INVALID");
    }
    await expect(
      ownerPodRequest("ai-selection/deactivate", { method: "DELETE" }, ports),
    ).rejects.toThrow("POD_AI_SELECTION_INVALID");

    pod.currentPodConnection.mockResolvedValueOnce({
      endpoint: PIN,
      session: { session: "pst1.cached", subjectId: "sub_1", role: "app", scopes: ["pod.status"] },
    });
    await expect(
      ownerPodRequest("ai-selection/deactivate", { method: "POST" }, ports),
    ).rejects.toThrow("POD_AI_SELECTION_INVALID");

    pod.currentPodConnection.mockResolvedValueOnce({
      endpoint: PIN,
      session: { session: "pst1.cached", subjectId: "sub_1", role: "peer", scopes: ["pod.config"] },
    });
    await expect(
      ownerPodRequest("ai-selection/deactivate", { method: "POST" }, ports),
    ).rejects.toThrow("POD_AI_SELECTION_INVALID");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows DELETE ai-selection?provider=openai without body and rejects DELETE with body", async () => {
    const { fetchSpy, ports } = makePorts();
    const res = await ownerPodRequest("ai-selection?provider=openai", { method: "DELETE" }, ports);
    expect(res).toBeInstanceOf(Response);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${URL}/api/one/pod/ai-selection?provider=openai`,
      expect.objectContaining({ method: "DELETE" }),
    );

    await expect(
      ownerPodRequest("ai-selection?provider=openai", { method: "DELETE", body: "{}" }, ports),
    ).rejects.toThrow("POD_AI_SELECTION_INVALID");
  });

  it("refuses unknown ai-selection subroutes", async () => {
    const { fetchSpy, ports } = makePorts();
    await expect(
      ownerPodRequest("ai-selection/bogus", { method: "POST" }, ports),
    ).rejects.toThrow("POD_APP_ROUTE_REFUSED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
