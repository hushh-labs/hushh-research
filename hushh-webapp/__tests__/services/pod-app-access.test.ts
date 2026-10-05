import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { expect, it, vi } from "vitest";
import { canonicalJson } from "@/lib/services/owner-pod-crypto";
import { ownerPodRequest } from "@/lib/services/pod-app-access";
import { canonical, openAsAgent } from "../lib/one/open-ai-selection";

const pod = vi.hoisted(() => ({ currentPodConnection: vi.fn() }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: () => ({ uid: "owner" }) } }));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  loadPinnedEndpoint: async () => ({ hushhId: "ha1_owner", url: "https://owner.a.run.app" }),
  currentPodConnection: pod.currentPodConnection,
}));

it("refuses a cancelled chat while preserving another caller's shared admission", async () => {
  let admitted!: (connection: unknown) => void;
  const admission = new Promise((resolve) => { admitted = resolve; });
  pod.currentPodConnection.mockReturnValue(admission);
  const hub = vi.fn();
  const fetch = vi.fn(async () => new Response("{}"));
  const ports = { transport: async () => ({ hub }), fetch } as Parameters<typeof ownerPodRequest>[2];
  const caller = new AbortController();
  const cancelled = ownerPodRequest("agent-chat", {
    method: "POST", body: JSON.stringify({ messages: [], forwardedProps: {} }), signal: caller.signal,
  }, ports);
  const refused = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(pod.currentPodConnection).toHaveBeenCalledOnce());
  caller.abort(new DOMException("Owner cancelled", "AbortError"));
  admitted({ endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" }, session: { session: "synthetic-session" } });
  await refused;
  expect(hub).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await ownerPodRequest("agent-chat/conversations/owner", { method: "GET" }, ports);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe("https://owner.a.run.app/api/one/pod/agent-chat/conversations/owner");
});

it("seals an AI selection to the hub-signed key of the addressed pod, and refuses another pod's key", async () => {
  const issuer = generateKeyPairSync("ed25519");
  const issuerRaw = issuer.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const x25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
  const agent = await crypto.subtle.generateKey(x25519, true, ["deriveBits"]) as CryptoKeyPair;
  const agentRaw = new Uint8Array(await crypto.subtle.exportKey("raw", agent.publicKey));
  const endpoint = { hushhId: "ha1_owner", url: "https://owner.a.run.app", podKeyId: "podk_1", environment: "dev" };
  let boundPodKeyId = "podk_1";
  const hub = vi.fn(async (path: string) => {
    if (path.endsWith("/verification-keys")) return new Response(JSON.stringify({ kind: "pod_verification_keys_v1", keys: { kid: issuerRaw } }));
    const binding = {
      kind: "pod_binding_v1", user_id: "owner", hushh_id: "ha1_owner", pod_key_id: boundPodKeyId,
      pod_public_key: Buffer.from(agentRaw).toString("base64"), url: endpoint.url, environment: "dev",
      subject_id: "tdv_app_1", expires_at_ms: Date.now() + 60_000,
    };
    const signature = `ed25519.kid.${nodeSign(null, Buffer.from(canonicalJson(binding)), issuer.privateKey).toString("base64url")}`;
    return new Response(JSON.stringify({ binding, signature }));
  });
  pod.currentPodConnection.mockResolvedValue({ endpoint, session: { session: "synthetic-session", subjectId: "tdv_app_1" } });
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ status: "active" })));
  const ports = { transport: async () => ({ hub, direct: vi.fn() }), fetch } as unknown as Parameters<typeof ownerPodRequest>[2];
  const selection = { provider: "openai", model: null, apiKey: "sk-fixture-not-a-real-key", transport: null, vertexProject: null, vertexLocation: null };

  await ownerPodRequest("ai-selection", { method: "PUT", body: JSON.stringify(selection) }, ports);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("https://owner.a.run.app/api/one/pod/ai-selection");
  expect(String(init.body)).not.toContain("sk-fixture");
  const envelope = JSON.parse(String(init.body));
  expect(envelope.aad).toMatchObject({ hushhId: "ha1_owner", podKeyId: "podk_1" });
  expect(await openAsAgent(envelope, agent.privateKey, agentRaw)).toBe(canonical(selection));

  // Negative control: a signed binding for a different pod key never receives the key.
  boundPodKeyId = "podk_other";
  fetch.mockClear();
  await expect(ownerPodRequest("ai-selection", { method: "PUT", body: JSON.stringify(selection) }, ports)).rejects.toThrow("AGENT_KEY_MISMATCH");
  expect(fetch).not.toHaveBeenCalled();
});
