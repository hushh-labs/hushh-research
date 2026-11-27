import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalJson } from "@/lib/services/owner-pod-crypto";
import { agentChatRequest, ownerPodRequest } from "@/lib/services/pod-app-access";
import { requestPkmMemoryPreparation } from "@/lib/agent/agent-pkm-memory-preparation";
import { canonical, openAsAgent } from "../lib/one/open-ai-selection";
import { RECEIPT_TOOL_DECLARATIONS } from "@/lib/mail/receipt-analysis";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

const pod = vi.hoisted(() => ({
  currentPodConnection: vi.fn(),
  pin: vi.fn(async () => ({ hushhId: "ha1_owner", url: "https://owner.a.run.app", endpointVersion: 1 })),
  refreshEndpointFromHub: vi.fn(async () => ({ hushhId: "ha1_owner", url: "https://owner.a.run.app", endpointVersion: 1 })),
  openPodSession: vi.fn(async () => ({ session: "pst1_reopened", role: "app", scopes: ["files.read", "files.manage", "pkm.read", "pod.status"] })),
}));
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
  refreshEndpointFromHub: pod.refreshEndpointFromHub,
  openPodSession: pod.openPodSession,
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

it("admits typed Calendar/Mail reads only with app pkm.read authority and exact methods", async () => {
  const fetch = vi.fn(async () => Response.json({ items: [] }));
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  const connection = { endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" },
    session: { session: "synthetic", role: "device", scopes: ["pkm.read", "pod.status"] } };
  pod.currentPodConnection.mockResolvedValue(connection);
  for (const [path, method] of [["calendar/events", "POST"], ["gmail/todos", "GET"]]) {
    await expect(ownerPodRequest(path!, { method }, ports)).rejects.toThrow("POD_TASK_SOURCE_READ_REFUSED");
  }
  connection.session.role = "app";
  connection.session.scopes = ["pod.status"];
  await expect(ownerPodRequest("gmail/todos", { method: "GET" }, ports)).rejects.toThrow("POD_TASK_SOURCE_READ_REFUSED");
  expect(fetch).not.toHaveBeenCalled();
  connection.session.scopes = ["pkm.read"];
  await ownerPodRequest("calendar/events", { method: "POST", body: "{}" }, ports);
  await ownerPodRequest("gmail/todos", { method: "GET" }, ports);
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockClear();
  await expect(ownerPodRequest("gmail/todos", { method: "POST" }, ports)).rejects.toThrow("POD_TASK_SOURCE_READ_REFUSED");
  await expect(ownerPodRequest("calendar/events", { method: "GET" }, ports)).rejects.toThrow("POD_TASK_SOURCE_READ_REFUSED");
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

it("admits reviewed owner pod wiki file routes and refuses unreviewed wiki paths", async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  pod.currentPodConnection.mockResolvedValue({
    endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" },
    session: { session: "synthetic-session", role: "app", scopes: ["files.read", "files.manage"] },
  });
  for (const route of [
    "files/wiki/overview",
    "files/wiki/page?page_id=work%2Fcareer.md",
    "files/wiki/opt-in",
    "files/wiki/confirm",
    "files/wiki/projection/derive",
    "files/wiki/forget",
    "files/wiki/migrate",
    "files/wiki/rollback",
    "files/wiki/import",
    "files/wiki/optimize",
    "files/workspaces/status",
    "files/workspaces/execute",
    "files/workspaces/control",
    "files/workspaces/forget",
  ]) {
    const response = await ownerPodRequest(route, { method: route.startsWith("files/wiki/overview") || route.startsWith("files/workspaces/status") || route.includes("?") ? "GET" : "POST" }, ports);
    expect(response.ok).toBe(true);
  }
  expect(fetch).toHaveBeenCalledTimes(14);
  await expect(ownerPodRequest("files/wiki/unreviewed", { method: "GET" }, ports)).rejects.toThrow("POD_APP_ROUTE_REFUSED");
});

it("admits owner pod browser download save route only when browser.control and files scopes are held", async () => {
  const fetch = vi.fn(async () => Response.json({ verified: true }));
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  const downloadRoute = `browser/tasks/browser_${"a".repeat(32)}/downloads/${"b".repeat(32)}`;

  pod.currentPodConnection.mockResolvedValueOnce({
    endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" },
    session: { session: "synthetic-session", role: "app", scopes: ["browser.control"] },
  });
  await expect(ownerPodRequest(downloadRoute, { method: "POST", body: "{}" }, ports)).rejects.toThrow("POD_BROWSER_REQUEST_REFUSED");

  pod.currentPodConnection.mockResolvedValueOnce({
    endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" },
    session: { session: "synthetic-session", role: "app", scopes: ["browser.control", "files.read", "files.manage"] },
  });
  const ok = await ownerPodRequest(downloadRoute, { method: "POST", body: "{}" }, ports);
  expect(ok.ok).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
});

it("admits status, config, and circle-rules routes only with app role and exact scopes", async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  const connection = {
    endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" },
    session: { session: "synthetic-session", role: "device", scopes: ["pod.status", "pod.config"] },
  };
  pod.currentPodConnection.mockResolvedValue(connection);

  await expect(ownerPodRequest("status", { method: "GET" }, ports)).rejects.toThrow("POD_STATUS_REQUEST_REFUSED");
  await expect(ownerPodRequest("config", { method: "POST", body: "{}" }, ports)).rejects.toThrow("POD_CONFIG_REQUEST_REFUSED");
  await expect(ownerPodRequest("circle-rules", { method: "GET" }, ports)).rejects.toThrow("POD_CIRCLE_RULES_REQUEST_REFUSED");
  expect(fetch).not.toHaveBeenCalled();

  connection.session.role = "app";
  connection.session.scopes = ["pod.status"];
  expect((await ownerPodRequest("status", { method: "GET" }, ports)).ok).toBe(true);
  expect((await ownerPodRequest("circle-rules", { method: "GET" }, ports)).ok).toBe(true);
  expect((await ownerPodRequest("circle-rules/preview", { method: "POST", body: "{}" }, ports)).ok).toBe(true);
  await expect(ownerPodRequest("circle-rules", { method: "PUT", body: "{}" }, ports)).rejects.toThrow("POD_CIRCLE_RULES_REQUEST_REFUSED");
  await expect(ownerPodRequest("config", { method: "POST", body: "{}" }, ports)).rejects.toThrow("POD_CONFIG_REQUEST_REFUSED");

  connection.session.scopes = ["pod.status", "pod.config"];
  expect((await ownerPodRequest("config", { method: "POST", body: "{}" }, ports)).ok).toBe(true);
  expect((await ownerPodRequest("circle-rules", { method: "PUT", body: "{}" }, ports)).ok).toBe(true);
  expect((await ownerPodRequest("circle-rules/rule_abcd1234ef/toggle", { method: "POST", body: "{}" }, ports)).ok).toBe(true);
  expect((await ownerPodRequest("circle-rules/rule_abcd1234ef", { method: "DELETE" }, ports)).ok).toBe(true);
  await expect(ownerPodRequest("circle-rules/not-a-valid-id", { method: "DELETE" }, ports)).rejects.toThrow("POD_APP_ROUTE_REFUSED");
  expect(fetch).toHaveBeenCalledTimes(7);
});

it("keeps exact credential catalog and use routes behind browser.control", async () => {
  const fetch = vi.fn(async () => Response.json({ accepted: true }));
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  const root = `browser/tasks/browser_${"a".repeat(32)}/credentials`;
  const connection = { endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app" },
    session: { session: "synthetic-session", role: "app", scopes: ["browser.observe"] } };
  pod.currentPodConnection.mockResolvedValue(connection);
  for (const [route, method] of [[root, "GET"], [root + "/use", "POST"], [root + "/transient", "POST"]]) {
    await expect(ownerPodRequest(route, { method, body: method === "POST" ? "{}" : undefined }, ports)).rejects.toThrow("POD_BROWSER_REQUEST_REFUSED");
  }
  expect(fetch).not.toHaveBeenCalled();
  connection.session.scopes = ["browser.control"];
  for (const [route, method] of [[root + "?origin=https%3A%2F%2Fexample.com", "GET"], [root + "/use", "POST"], [root + "/transient", "POST"]]) {
    expect((await ownerPodRequest(route, { method, body: method === "POST" ? "{}" : undefined }, ports)).ok).toBe(true);
  }
  expect(fetch).toHaveBeenCalledTimes(3);
  await expect(ownerPodRequest(root + "/unreviewed", { method: "POST", body: "{}" }, ports)).rejects.toThrow("POD_APP_ROUTE_REFUSED");
});

const credentialCatalogRoute = `browser/tasks/browser_${"a".repeat(32)}/credentials`;
const credentialFloorRoute = `credentials/cred_${"a".repeat(32)}`;
function credentialReadmissionConnection(role = "app", scopes = ["browser.control", "pod.config"], hushhId = "ha1_owner", endpointVersion = 2) {
  return { endpoint: { hushhId, url: `https://${hushhId}.a.run.app`, endpointVersion },
    session: { session: `synthetic-session-${endpointVersion}`, role, scopes } };
}
function prepareCredentialReadmission(next = credentialReadmissionConnection(), afterAdmission?: () => void, refreshedVersion = 2) {
  const first = credentialReadmissionConnection("app", ["browser.control", "pod.config"], "ha1_owner", 1);
  pod.pin.mockResolvedValue(first.endpoint);
  pod.refreshEndpointFromHub.mockReset().mockResolvedValue({ ...first.endpoint, endpointVersion: refreshedVersion });
  pod.openPodSession.mockReset().mockResolvedValue(next.session);
  pod.currentPodConnection.mockReset().mockResolvedValueOnce(first).mockImplementationOnce(async () => {
    afterAdmission?.();
    return next;
  });
}

it.each([401, 404])("retries same-pod credential GETs once after a newer endpoint answers %s", async status => {
  for (const route of [credentialCatalogRoute, credentialFloorRoute]) {
    prepareCredentialReadmission();
    const sessions: (string | null)[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      sessions.push(new Headers(init.headers).get("Authorization"));
      return Response.json({}, { status: sessions.length === 1 ? status : 200 });
    });
    const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
    expect((await ownerPodRequest(route, { method: "GET" }, ports, "ha1_owner")).ok).toBe(true);
    expect(sessions).toEqual(["Bearer synthetic-session-1", "Bearer synthetic-session-2"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(pod.refreshEndpointFromHub).toHaveBeenCalledOnce();
  }
});

it.each([
  { label: "Browser role", route: credentialCatalogRoute, next: credentialReadmissionConnection("device"), error: "POD_BROWSER_REQUEST_REFUSED", expectedPod: "ha1_owner" },
  { label: "Browser control", route: credentialCatalogRoute, next: credentialReadmissionConnection("app", ["browser.observe"]), error: "POD_BROWSER_REQUEST_REFUSED", expectedPod: "ha1_owner" },
  { label: "custody role", route: credentialFloorRoute, next: credentialReadmissionConnection("device"), error: "POD_CREDENTIAL_REQUEST_REFUSED", expectedPod: "ha1_owner" },
  { label: "custody config", route: credentialFloorRoute, next: credentialReadmissionConnection("app", ["pod.status"]), error: "POD_CREDENTIAL_REQUEST_REFUSED", expectedPod: "ha1_owner" },
  { label: "expected pod", route: credentialCatalogRoute, next: credentialReadmissionConnection("app", ["browser.control"], "ha1_other"), error: "POD_DIRECT_OWNER_MISMATCH", expectedPod: "ha1_owner" },
  { label: "Browser POST control", route: credentialCatalogRoute + "/use", next: credentialReadmissionConnection("app", ["browser.observe"]), error: "POD_BROWSER_REQUEST_REFUSED", expectedPod: "ha1_owner", method: "POST" },
  { label: "custody POST config", route: "credentials", next: credentialReadmissionConnection("app", ["pod.status"]), error: "POD_CREDENTIAL_REQUEST_REFUSED", expectedPod: "ha1_owner", method: "POST" },
  { label: "original pod", route: credentialCatalogRoute, next: credentialReadmissionConnection("app", ["browser.control"], "ha1_other"), error: "POD_DIRECT_OWNER_MISMATCH", expectedPod: undefined },
])("refuses changed $label before a second credential request", async ({ route, next, error, expectedPod, method = "GET" }) => {
  prepareCredentialReadmission(next);
  const fetch = vi.fn(async () => Response.json({}, { status: 401 }));
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  await expect(ownerPodRequest(route, { method, ...(method === "POST" ? { body: "{}" } : {}) }, ports, expectedPod)).rejects.toThrow(error);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each((["caller", "owner", "vault", "cancel"] as const).flatMap(retired => [404, 401].map(status => ({ retired, status }))))("refuses $retired retirement during credential $status re-admission", async ({ retired, status }) => {
  let current = true;
  const cancellation = new AbortController();
  prepareCredentialReadmission(credentialReadmissionConnection(), () => {
    if (retired === "caller") current = false;
    if (retired === "owner") publishValidatedAuthSessionPrincipal({ firebaseUid: "other", ownerId: "other", accountGeneration: 1 });
    if (retired === "vault") advanceVaultSessionEpoch();
    if (retired === "cancel") cancellation.abort();
  });
  const fetch = vi.fn(async () => Response.json({}, { status }));
  const ports = { transport: async () => ({}), fetch, isCurrent: () => current } as Parameters<typeof ownerPodRequest>[2];
  const response = ownerPodRequest(credentialCatalogRoute + (status === 401 ? "/use" : ""), { method: status === 401 ? "POST" : "GET", ...(status === 401 ? { body: "{}" } : {}), signal: cancellation.signal }, ports, "ha1_owner");
  if (retired === "cancel") await expect(response).rejects.toMatchObject({ name: "AbortError" });
  else await expect(response).rejects.toThrow(/POD_(OWNER|VAULT_SESSION)_CHANGED/);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(["GET", "POST"])("renews a same-version credential %s once on 401 with the original body", async method => {
  const next = credentialReadmissionConnection("app", ["browser.control", "pod.config"], "ha1_owner", 1);
  next.session.session = "synthetic-renewed-session";
  prepareCredentialReadmission(next, undefined, 1);
  const body = method === "POST" ? JSON.stringify({ sealed: "synthetic-envelope" }) : undefined;
  const sessions: (string | null)[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    sessions.push(new Headers(init.headers).get("Authorization"));
    return Response.json({}, { status: sessions.length === 1 ? 401 : 200 });
  });
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  expect((await ownerPodRequest(credentialCatalogRoute + (method === "POST" ? "/use" : ""), { method, body }, ports, "ha1_owner")).ok).toBe(true);
  expect(sessions).toEqual(["Bearer synthetic-session-1", "Bearer synthetic-renewed-session"]);
  expect(fetch.mock.calls.map(([, init]) => init.body)).toEqual([body, body]);
  expect(pod.openPodSession).toHaveBeenCalledOnce();
});

it.each([
  { route: credentialFloorRoute, method: "GET", version: 1, refreshedPod: "ha1_owner" },
  { route: credentialCatalogRoute, method: "GET", version: 0, refreshedPod: "ha1_owner" },
  { route: credentialCatalogRoute, method: "GET", version: 2, refreshedPod: "ha1_other" },
  { route: credentialCatalogRoute + "/use", method: "POST", version: 2, refreshedPod: "ha1_owner" },
])("does not retry credential $method/404 at endpoint $refreshedPod version $version", async ({ route, method, version, refreshedPod }) => {
  prepareCredentialReadmission(credentialReadmissionConnection(), undefined, version);
  pod.refreshEndpointFromHub.mockResolvedValue({ ...credentialReadmissionConnection().endpoint, hushhId: refreshedPod, endpointVersion: version });
  const fetch = vi.fn(async () => Response.json({}, { status: 404 }));
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  expect((await ownerPodRequest(route, { method, ...(method === "POST" ? { body: "{}" } : {}) }, ports)).status).toBe(404);
  expect(fetch).toHaveBeenCalledOnce();
  expect(pod.currentPodConnection).toHaveBeenCalledOnce();
  expect(pod.openPodSession).not.toHaveBeenCalled();
  if (method === "POST") expect(pod.refreshEndpointFromHub).not.toHaveBeenCalled();
});

it("returns the second credential GET refusal without another retry", async () => {
  prepareCredentialReadmission();
  const fetch = vi.fn(async () => Response.json({}, { status: 401 }));
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  expect((await ownerPodRequest(credentialFloorRoute, { method: "GET" }, ports)).status).toBe(401);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(pod.currentPodConnection).toHaveBeenCalledTimes(2);
  expect(pod.refreshEndpointFromHub).toHaveBeenCalledOnce();
});

it("re-opens pod session transparently on 401 when pooled sandbox recycles without endpointVersion bump", async () => {
  pod.openPodSession.mockClear();
  let activeSession = "pst1_expired_after_idle_recycle";
  pod.currentPodConnection.mockImplementation(async () => ({
    endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app", endpointVersion: 1 },
    session: { session: activeSession, role: "app", scopes: ["files.read", "files.manage", "pkm.read", "pod.status"] },
    directVerifiedAt: Date.now(),
  }));
  pod.openPodSession.mockImplementation(async () => {
    activeSession = "pst1_fresh_sandbox_session";
    return { session: activeSession, role: "app", scopes: ["files.read", "files.manage", "pkm.read", "pod.status"] };
  });

  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get("Authorization");
    if (auth === "Bearer pst1_expired_after_idle_recycle") {
      return Response.json({ detail: "session_expired" }, { status: 401 });
    }
    if (url.endsWith("/capabilities")) {
      return Response.json({ ...legacyChatCapabilities, receiptToolVersion: 1 });
    }
    return Response.json({ ok: true, sessionUsed: auth });
  });
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];

  const filesResp = await ownerPodRequest("files/list", { method: "GET" }, ports);
  expect(filesResp.ok).toBe(true);
  expect(await filesResp.json()).toMatchObject({ ok: true, sessionUsed: "Bearer pst1_fresh_sandbox_session" });
  expect(pod.openPodSession).toHaveBeenCalledTimes(1);

  activeSession = "pst1_expired_after_idle_recycle";
  const chatResp = await ownerPodRequest(
    "agent-chat",
    {
      method: "POST",
      body: JSON.stringify({
        tools: [],
        messages: [{ id: "m1", role: "user", content: "what about the core files" }],
        forwardedProps: { timezone: "UTC" },
      }),
    },
    ports,
  );
  expect(chatResp.ok).toBe(true);
  expect(pod.openPodSession).toHaveBeenCalledTimes(2);
});

it("admits sovereign pod plaid vault routes only for app POST requests with pkm.read", async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  const ports = { transport: async () => ({}), fetch } as Parameters<typeof ownerPodRequest>[2];
  const connection = {
    endpoint: { hushhId: "ha1_owner", url: "https://owner.a.run.app", endpointVersion: 1 },
    session: { session: "pst1_valid", role: "device", scopes: ["pkm.read"] },
  };
  pod.currentPodConnection.mockResolvedValue(connection);

  await expect(ownerPodRequest("plaid/vault/snapshot", { method: "POST", body: "{}" }, ports)).rejects.toThrow(
    "POD_PLAID_VAULT_REQUEST_REFUSED",
  );
  connection.session.role = "app";
  connection.session.scopes = ["pod.status"];
  await expect(ownerPodRequest("plaid/vault/snapshot", { method: "POST", body: "{}" }, ports)).rejects.toThrow(
    "POD_PLAID_VAULT_REQUEST_REFUSED",
  );
  connection.session.scopes = ["pkm.read"];
  await expect(ownerPodRequest("plaid/vault/snapshot", { method: "GET" }, ports)).rejects.toThrow(
    "POD_PLAID_VAULT_REQUEST_REFUSED",
  );
  for (const route of [
    "plaid/vault/link-token",
    "plaid/vault/exchange",
    "plaid/vault/snapshot",
    "plaid/vault/remove",
  ]) {
    const res = await ownerPodRequest(route, { method: "POST", body: "{}" }, ports);
    expect(res.ok).toBe(true);
  }
  expect(fetch).toHaveBeenCalledTimes(4);
});
