import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalJson } from "@/lib/services/owner-pod-crypto";
import { agentChatRequest, ownerPodRequest } from "@/lib/services/pod-app-access";
import { requestPkmMemoryPreparation } from "@/lib/agent/agent-pkm-memory-preparation";
import { canonical, openAsAgent } from "../lib/one/open-ai-selection";
import { RECEIPT_TOOL_DECLARATIONS } from "@/lib/mail/receipt-analysis";

const pod = vi.hoisted(() => ({ currentPodConnection: vi.fn(), pin: vi.fn(async () => ({ hushhId: "ha1_owner", url: "https://owner.a.run.app" })) }));
const memory = vi.hoisted(() => ({ fetch: vi.fn(), shared: vi.fn() }));

const legacyChatCapabilities = {
  identity: { type: "google-adk" }, transport: { streaming: true }, tools: { clientProvided: true },
};

async function receiptChatProbe(capabilities: unknown, options: {
  status?: number; retire?: "owner" | "abort"; continuation?: boolean; forged?: boolean;
} = {}) {
  let current = true;
  const controller = new AbortController();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/capabilities")) {
      if (options.retire === "owner") current = false;
      if (options.retire === "abort") controller.abort();
      return Response.json(capabilities, { status: options.status ?? 200 });
    }
    if (!(capabilities as { receiptToolVersion?: unknown })?.receiptToolVersion &&
        JSON.parse(String(init.body)).tools.some((tool: { name: string }) =>
          RECEIPT_TOOL_DECLARATIONS.some(item => item.name === tool.name))) {
      return Response.json({ detail: { code: "AGENT_TOOL_NOT_ADMITTED" } }, { status: 400 });
    }
    return Response.json({ accepted: true });
  });
  pod.currentPodConnection.mockResolvedValue({
    endpoint: { hushhId: "ha1_owner", url: "https://receipt-owner.a.run.app" },
    session: { session: "synthetic-receipt-session", role: "app", scopes: [] },
    directVerifiedAt: Date.now(),
  });
  const action = { name: "hussh_action_open", description: "Existing action", parameters: { type: "object" } };
  const body = JSON.stringify({
    tools: [action, ...RECEIPT_TOOL_DECLARATIONS.map(tool => options.forged ? { ...tool, description: "Changed" } : tool)],
    messages: [{ id: "synthetic-message", role: "user", content: "Synthetic" }],
    forwardedProps: { timezone: "UTC", ...(options.continuation ? { receiptToolResults: [] } : {}) },
  });
  const ports = { transport: async () => ({}), fetch, isCurrent: () => current } as Parameters<typeof ownerPodRequest>[2];
  const result = ownerPodRequest("agent-chat", { method: "POST", body, signal: controller.signal }, ports);
  return { result, fetch, body, action };
}

it.each([1, 0] as const)("negotiates receipt tools with installed pod protocol %s before one chat dispatch", async version => {
  const { result, fetch, body, action } = await receiptChatProbe({
    ...legacyChatCapabilities, ...(version ? { receiptToolVersion: 1 } : {}),
  });
  expect((await result).ok).toBe(true);
  const posts = fetch.mock.calls.filter(([, init]) => init.method === "POST");
  expect(posts).toHaveLength(1);
  const sent = JSON.parse(String(posts[0]![1].body));
  const original = JSON.parse(body);
  expect(sent).toEqual({ ...original, forwardedProps: { ...original.forwardedProps, dataDoorGrants: {} },
    tools: version ? original.tools : [action] });
  expect(fetch.mock.calls[0]![0]).toMatch(/\/capabilities$/);
});

it.each([
  { capabilities: { ...legacyChatCapabilities, receiptToolVersion: 2 }, status: 200 },
  { capabilities: {}, status: 200 },
  { capabilities: legacyChatCapabilities, status: 403 },
])("refuses unverified receipt capability before POST: $status/$capabilities", async ({ capabilities, status }) => {
  const { result, fetch } = await receiptChatProbe(capabilities, { status });
  await expect(result).rejects.toThrow(/POD_CHAT_CAPABILITIES/);
  expect(fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(0);
});

it.each(["owner", "abort"] as const)("does not send after %s changes during receipt discovery", async retire => {
  const { result, fetch } = await receiptChatProbe({ ...legacyChatCapabilities, receiptToolVersion: 1 }, { retire });
  await expect(result).rejects.toThrow();
  expect(fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(0);
});

it.each([{ continuation: true }, { forged: true }])("never drops unsupported receipt continuation or altered declaration: %s", async options => {
  const { result, fetch } = await receiptChatProbe(legacyChatCapabilities, options);
  await expect(result).rejects.toThrow(/POD_(RECEIPT_UPDATE_REQUIRED|CHAT_RECEIPT_DECLARATION_INVALID)/);
  expect(fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(0);
});
vi.mock("@/lib/services/api-service", () => ({ ApiService: {
  getPersonalAgentStatus: async () => ({ hostingMode: "byoc" }),
  apiFetch: memory.shared,
  ownerPodRequest: (path: string, init: RequestInit, _streaming: boolean,
    _onAdmission: unknown, _expectedPod: unknown, isCurrent?: () => boolean) =>
    ownerPodRequest(path, init, { transport: async () => ({}), fetch: memory.fetch, isCurrent } as Parameters<typeof ownerPodRequest>[2]),
} }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: () => ({ uid: "owner" }) } }));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  loadPinnedEndpoint: pod.pin,
  currentPodConnection: pod.currentPodConnection,
}));

it("requires owner app authority for scheduled work and permits only exact read/control methods", async () => {
  const fetch = vi.fn(async () => Response.json({ tasks: [] }));
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  const connection = { endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" },
    session: { session: "synthetic", role: "device", scopes: ["pod.status", "pod.act", "files.manage"] } };
  pod.currentPodConnection.mockResolvedValue(connection);
  await expect(ownerPodRequest("tasks", { method: "POST" }, ports)).rejects.toThrow("SCHEDULE_GRANT_REFUSED");
  expect(fetch).not.toHaveBeenCalled();
  connection.session.role = "app";
  await ownerPodRequest("tasks", { method: "POST" }, ports);
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockClear();
  await expect(ownerPodRequest("tasks/control", { method: "GET" }, ports)).rejects.toThrow("SCHEDULE_ROUTE_REFUSED");
  await expect(ownerPodRequest("tasks", { method: "DELETE" }, ports)).rejects.toThrow("SCHEDULE_ROUTE_REFUSED");
  connection.session.scopes = ["pod.status", "pod.act"];
  await expect(ownerPodRequest("tasks", { method: "POST" }, ports)).rejects.toThrow("SCHEDULE_GRANT_REFUSED");
  expect(fetch).not.toHaveBeenCalled();
});

it("sends only bounded conditional-clear metadata through the owner app door", async () => {
  const fetch = vi.fn(async () => Response.json({ status: "cleared" }));
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  const connection = { endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" },
    session: { session: "synthetic", role: "app", scopes: ["pod.config"] } };
  pod.currentPodConnection.mockResolvedValue(connection);
  const path = "ai-selection/clear-if-current";
  const body = JSON.stringify({ expectedProvider: "gemini", expectedSelectionRevision: 2 });
  await ownerPodRequest(path, { method: "POST", body }, ports);
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockClear();
  await expect(ownerPodRequest(path, { method: "POST", body: JSON.stringify({
    expectedProvider: "gemini", expectedSelectionRevision: 2, apiKey: "fixture",
  }) }, ports)).rejects.toThrow("POD_AI_SELECTION_INVALID");
  connection.session.scopes = ["pod.status"];
  await expect(ownerPodRequest(path, { method: "POST", body }, ports)).rejects.toThrow("POD_AI_SELECTION_INVALID");
  expect(fetch).not.toHaveBeenCalled();
});

it("refuses a retired Stop before hosting dispatch and after deferred pod admission", async () => {
  let current = true;
  const fetch = vi.fn(async () => Response.json({ stopped: true }));
  const direct = vi.fn(async () => { current = false; return Response.json({ stopped: true }); });
  current = false;
  await expect(agentChatRequest("/api/one/agent-chat/runs/old/stop", { method: "POST" }, {
    hosting: async () => ({ hostingMode: "byoc" }), fetch, direct, isCurrent: () => current,
  })).rejects.toThrow("POD_OWNER_CHANGED");
  expect(direct).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();

  current = true;
  const selecting = agentChatRequest("/api/one/agent-chat/runs/old/stop", { method: "POST" }, {
    hosting: async () => ({ hostingMode: "byoc" }), fetch, direct, isCurrent: () => current,
  });
  current = false;
  await expect(selecting).rejects.toThrow("POD_OWNER_CHANGED");
  expect(direct).not.toHaveBeenCalled();
  current = true;
  let admitted!: (connection: unknown) => void;
  pod.currentPodConnection.mockReturnValue(new Promise((resolve) => { admitted = resolve; }));
  const ports = { transport: async () => ({}), fetch, isCurrent: () => current } as Parameters<typeof ownerPodRequest>[2];
  const stop = ownerPodRequest("agent-chat/runs/old/stop", { method: "POST" }, ports);
  await vi.waitFor(() => expect(admitted).toBeTypeOf("function"));
  current = false;
  admitted({ endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" }, session: { session: "synthetic-session" } });
  await expect(stop).rejects.toThrow("POD_OWNER_CHANGED");
  expect(fetch).not.toHaveBeenCalled();
  current = true;
  await ownerPodRequest("agent-chat/runs/old/stop", { method: "POST" }, ports);
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not process a retired Memory review after same-owner pod admission", async () => {
  let current = true;
  let admitted!: (connection: unknown) => void;
  const cancellation = new AbortController();
  memory.fetch.mockReset().mockResolvedValue(Response.json({}));
  memory.shared.mockClear();
  pod.currentPodConnection.mockClear().mockReturnValue(new Promise(resolve => { admitted = resolve; }));
  const preparation = requestPkmMemoryPreparation({
    userId: "owner", message: "Synthetic library role", currentDomains: [],
    vaultOwnerToken: "synthetic-owner-token", signal: cancellation.signal,
    isEffectCurrent: () => current,
  });
  const refused = expect(preparation).rejects.toThrow();
  await vi.waitFor(() => expect(pod.currentPodConnection).toHaveBeenCalledOnce());
  current = false;
  admitted({ endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" },
    session: { session: "synthetic-session" } });
  await refused;
  expect(cancellation.signal.aborted).toBe(false);
  expect(memory.fetch).not.toHaveBeenCalled();
  expect(memory.shared).not.toHaveBeenCalled();
});

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
  const endpoint = { hushhId: "ha1_owner", url: "https://owner.a.run.app", podKeyId: "podk_1", environment: "dev", verificationVersion: 1 };
  let boundPodKeyId = "podk_1";
  let boundRole = 'app';
  const hub = vi.fn(async (path: string) => {
    if (path.endsWith("/verification-keys")) return new Response(JSON.stringify({ kind: "pod_verification_keys_v1", keys: { kid: issuerRaw } }));
    const binding = {
      kind: "pod_binding_v1", user_id: "owner", hushh_id: "ha1_owner", pod_key_id: boundPodKeyId,
      pod_public_key: Buffer.from(agentRaw).toString("base64"), url: endpoint.url, environment: "dev",
      subject_id: "tdv_app_1", expires_at_ms: Date.now() + 60_000,
      subject_kind: 'app', role: boundRole, deployment_target: 'user_gcp', scopes: ['pod.config', 'pod.status'],
    };
    const signature = `ed25519.kid.${nodeSign(null, Buffer.from(canonicalJson(binding)), issuer.privateKey).toString("base64url")}`;
    return new Response(JSON.stringify({ binding, signature }));
  });
  pod.currentPodConnection.mockResolvedValue({ endpoint, session: { session: "synthetic-session", subjectId: "tdv_app_1",
    role: 'app', scopes: ['pod.config', 'pod.status'], expiresAt: Date.now() + 60_000 } });
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

  boundPodKeyId = 'podk_1';
  const login = { kind: 'authorization_code', clientProfile: 'hussh_ios',
    clientId: '123456789012-abcdefghijklmnop.apps.googleusercontent.com', code: 'synthetic-provider-code',
    codeVerifier: 'v'.repeat(64), redirectUri: 'com.googleusercontent.apps.123456789012-abcdefghijklmnop:/oauth2redirect',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify'] };
  await ownerPodRequest('connectors/gmail', { method: 'PUT', body: JSON.stringify(login) }, ports);
  expect(fetch).toHaveBeenCalledOnce();
  const envelopeBody = String(fetch.mock.calls[0][1].body);
  expect(envelopeBody).not.toContain(login.code);
  expect(envelopeBody).not.toContain(login.codeVerifier);
  expect(JSON.parse(envelopeBody).aad).toMatchObject({ purpose: 'connector_credential', connectorId: 'gmail' });
  expect(await openAsAgent(JSON.parse(envelopeBody), agent.privateKey, agentRaw, 'hussh/connector-credential/v1')).toBe(canonical(login));

  const transition = { id: `gct_${'a'.repeat(32)}`, nonce: 'b'.repeat(43) };
  fetch.mockClear();
  await ownerPodRequest('connectors/gmail', { method: 'PUT', body: JSON.stringify({ ...login, transition }) }, ports);
  const wrapped = JSON.parse(String(fetch.mock.calls[0][1].body));
  expect(wrapped.transition).toEqual(transition);
  expect(Object.keys(wrapped).sort()).toEqual(['envelope', 'transition']);
  expect(await openAsAgent(wrapped.envelope, agent.privateKey, agentRaw, 'hussh/connector-credential/v1')).toBe(canonical(login));
  expect(String(fetch.mock.calls[0][1].body)).not.toContain(login.code);
  // Transition metadata cannot smuggle authorization material outside the seal.
  fetch.mockClear();
  await expect(ownerPodRequest('connectors/gmail', { method: 'PUT',
    body: JSON.stringify({ ...login, transition: { ...transition, code: login.code } }) }, ports)).rejects.toThrow('GOOGLE_TRANSITION_INVALID');
  expect(fetch).not.toHaveBeenCalled();
  // A signed key alone cannot authorize a connector write. The binding must
  // independently grant the owner's app role and configuration authority.
  boundRole = 'device';
  fetch.mockClear();
  await expect(ownerPodRequest('connectors/gmail', { method: 'PUT', body: JSON.stringify(login) }, ports))
    .rejects.toThrow('OWNER_SESSION_REQUIRED');
  expect(fetch).not.toHaveBeenCalled();
  await expect(ownerPodRequest('connectors/gmail', { method: 'POST', body: JSON.stringify(login) }, ports))
    .rejects.toThrow('POD_CONNECTOR_REQUEST_REFUSED');
  await expect(ownerPodRequest('connectors/gmail?x', { method: 'GET', body: JSON.stringify(login) }, ports))
    .rejects.toThrow('POD_CONNECTOR_REQUEST_REFUSED');
});

// Fixtures represent an admitted application owner, not merely an SDK identity.
beforeEach(() => publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 }));

it("routes unpinned managed chat directly and never retries the hub on failure", async () => {
  pod.pin.mockResolvedValueOnce(null as never);
  const hub = vi.fn();
  const direct = vi.fn().mockRejectedValue(new Error("POD_UNAVAILABLE"));
  await expect(agentChatRequest("/api/one/agent-chat", { method: "POST", body: "synthetic" }, {
    hosting: async () => ({ hostingMode: "hussh_pods" }), fetch: hub, direct,
  })).rejects.toThrow("POD_UNAVAILABLE");
  expect(direct).toHaveBeenCalledOnce();
  expect(hub).not.toHaveBeenCalled();
});
