import { AuthService } from "./auth-service";
import type { OwnerPodTransport, PinnedEndpoint, PodSessionRecord } from "./owner-pod-endpoint";
import { beforeTurnIsSent } from "@/lib/agent/owner-pod-wake";
type AccessPorts = {
  transport: () => Promise<OwnerPodTransport>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  onChatAdmission?: (hushhId: string) => void;
};
const OWNER_POD_ROUTES = new Set([
  "files/list",
  "files/entry",
  "files/create",
  "files/chunk",
  "files/complete",
  "files/mutate",
  "files/settings",
  "files/jobs",
  "files/usage",
  "files/repair-index",
  "commands/transcriptions",
  "commands/assess",
  "turn/stream",
  "turn/cancel",
  "puppy/models",
  "ai-selection",
]);

/** The only pod routes this app reaches directly. */
function isOwnerPodRoute(route: string): boolean {
  if (OWNER_POD_ROUTES.has(route)) return true;
  return route === "agent-chat" || route === "agent-chat/capabilities" ||
    /^agent-chat\/(history|conversations)\/[A-Za-z0-9_-]{1,256}$/.test(route) ||
    /^agent-chat\/connectors\/[A-Za-z0-9_-]{1,128}\/mcp\/review$/.test(route);
}

export async function ownerPodRequest(
  path: string,
  init: RequestInit,
  ports: AccessPorts,
  expectedHushhId?: string,
): Promise<Response> {
  const refuseCancelled = () => {
    if (init.signal?.aborted)
      throw init.signal.reason ?? new DOMException("Agent request cancelled", "AbortError");
  };
  refuseCancelled();
  const route = path.split("?")[0] ?? "";
  if (!isOwnerPodRoute(route) || path.includes("#"))
    throw new Error("POD_APP_ROUTE_REFUSED");
  const uid = AuthService.getCurrentUser()?.uid;
  if (!uid) throw new Error("PRIVATE_AGENT_SIGN_IN_REQUIRED");
  const ownerPod = await import("./owner-pod-endpoint");
  const transport = await ports.transport();
  const chatTurn = route === "agent-chat" && init.method?.toUpperCase() === "POST";
  const connect = async () => {
    if (!(await ownerPod.loadPinnedEndpoint(uid))) await ownerPod.refreshEndpointFromHub(uid, transport);
    return ownerPod.currentPodConnection(uid, transport);
  };
  // A chat turn's admission happens before the turn is handed over: a network
  // failure there (an agent still waking) proves nothing was sent.
  const connection = chatTurn ? await beforeTurnIsSent(connect) : await connect();
  // Admission is shared with other tabs. A cancelled caller must not dispatch
  // grants or private work when that independently owned admission finishes.
  refuseCancelled();
  let { endpoint, session } = connection;
  if (expectedHushhId && endpoint.hushhId !== expectedHushhId)
    throw new Error("POD_DIRECT_OWNER_MISMATCH");
  if (AuthService.getCurrentUser()?.uid !== uid)
    throw new Error("POD_OWNER_CHANGED");
  let body = init.body;
  if (chatTurn) {
    if (typeof body !== "string") throw new Error("POD_CHAT_REQUEST_INVALID");
    const turn = JSON.parse(body) as Record<string, unknown>;
    const admitted = await chatGrantsFollowingEndpoint(uid, { endpoint, session }, transport, init.signal);
    ({ endpoint, session } = admitted);
    if (AuthService.getCurrentUser()?.uid !== uid) throw new Error("POD_OWNER_CHANGED");
    turn.forwardedProps = {
      ...(turn.forwardedProps && typeof turn.forwardedProps === "object" ? turn.forwardedProps : {}),
      dataDoorGrants: admitted.grants,
    };
    body = JSON.stringify(turn);
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.session}`);
  const method = (init.method ?? "GET").toUpperCase();
  if (route === "ai-selection" && (method !== "GET" && method !== "DELETE" || (body !== undefined && body !== null))) {
    // The plaintext selection is sealed HERE, to the hub-signed key of exactly
    // the pod this request is addressed to. Any body on this route must be a
    // sealed PUT, so a plaintext key can never leave the device unsealed.
    if (method !== "PUT" || typeof body !== "string") throw new Error("POD_AI_SELECTION_INVALID");
    const { sealAiSelectionRequestBody } = await import("@/lib/one/ai-selection-recipient");
    body = await sealAiSelectionRequestBody(body, { userId: uid, endpoint, session, transport });
    if (AuthService.getCurrentUser()?.uid !== uid) throw new Error("POD_OWNER_CHANGED");
  }
  refuseCancelled();
  const response = await ports.fetch(`${endpoint.url}/api/one/pod/${path}`, {
    ...init,
    credentials: "omit",
    body,
    headers,
    cache: "no-store",
  });
  if (AuthService.getCurrentUser()?.uid !== uid)
    throw new Error("POD_OWNER_CHANGED");
  if (response.ok && route === "agent-chat") ports.onChatAdmission?.(endpoint.hushhId);
  return response;
}

/**
 * The hub signed a newer version of the same agent's endpoint than this device
 * pinned (it moved, or its record was re-versioned). Not a refusal: the device
 * re-reads and re-admits the endpoint through the pinning rules, which still
 * refuse a rollback, a different owner, or a change without a version bump.
 */
class EndpointAdvancedError extends Error {
  constructor(readonly endpointVersion: number) {
    super("POD_ENDPOINT_ADVANCED");
    this.name = "EndpointAdvancedError";
  }
}

type PodConnection = { endpoint: PinnedEndpoint; session: PodSessionRecord };

/**
 * Chat grants for the pinned endpoint, following the hub once when it has
 * published a newer version of the same agent. Live 2026-10-06: the hub moved
 * the owner's Azure agent from version 1 to 2 at the same address, and every
 * chat turn from a browser pinned at version 1 failed after its grants, before
 * the turn was sent, until the pin was cleared by hand.
 */
async function chatGrantsFollowingEndpoint(
  uid: string,
  connection: PodConnection,
  transport: OwnerPodTransport,
  signal?: AbortSignal | null,
): Promise<PodConnection & { grants: Record<string, string> }> {
  try {
    return { ...connection, grants: await directChatGrants(connection.endpoint, transport, signal) };
  } catch (error) {
    if (!(error instanceof EndpointAdvancedError)) throw error;
    const ownerPod = await import("./owner-pod-endpoint");
    const next = await beforeTurnIsSent(async () => {
      await ownerPod.refreshEndpointFromHub(uid, transport);
      return ownerPod.currentPodConnection(uid, transport);
    });
    if (next.endpoint.hushhId !== connection.endpoint.hushhId ||
        next.endpoint.endpointVersion !== error.endpointVersion) {
      throw new Error("POD_ASSIGNMENT_CHANGED");
    }
    return { ...next, grants: await directChatGrants(next.endpoint, transport, signal) };
  }
}

async function directChatGrants(
  endpoint: PinnedEndpoint,
  transport: OwnerPodTransport,
  signal?: AbortSignal | null,
): Promise<Record<string, string>> {
  let response: Response;
  try {
    response = await transport.hub(`/api/one/u/${encodeURIComponent(endpoint.hushhId)}/chat-grants`,
      { method: "POST", cache: "no-store", signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    // Existing direct authorization still permits private chat during hub loss.
    // Specialists that need a current hub grant remain explicitly unavailable.
    return {};
  }
  if (response.status >= 500) return {};
  if (!response.ok) throw new Error(`POD_CHAT_AUTHORITY_UNAVAILABLE:${response.status}`);
  const value = await response.json() as {
    endpoint?: Record<string, unknown>; dataDoorGrants?: Record<string, unknown>;
  };
  const candidate = value.endpoint;
  if (!candidate) throw new Error("POD_CHAT_GRANTS_INVALID");
  const { signature, ...signed } = candidate;
  const { verifyHubSignature } = await import("./owner-pod-crypto");
  await verifyHubSignature(signed, String(signature ?? ""), transport);
  const version = candidate.endpointVersion;
  if (candidate.hushhId === endpoint.hushhId && candidate.environment === endpoint.environment &&
      Number.isInteger(version) && Number(version) > endpoint.endpointVersion) {
    throw new EndpointAdvancedError(Number(version));
  }
  for (const key of ["hushhId", "url", "podKeyId", "environment", "endpointVersion"] as const) {
    if (candidate[key] !== endpoint[key]) throw new Error("POD_ASSIGNMENT_CHANGED");
  }
  const grants = value.dataDoorGrants;
  if (!grants || typeof grants !== "object" || Array.isArray(grants) ||
      Object.keys(grants).length > 16 ||
      Object.values(grants).some(value => typeof value !== "string" || value.length > 12000)) {
    throw new Error("POD_CHAT_GRANTS_INVALID");
  }
  return grants as Record<string, string>;
}

export async function reconnectOwnerPod(
  ports: AccessPorts & {
    hosting: () => Promise<{
      hostingMode?: string;
      state?: string | null;
      hushhId?: string | null;
    }>;
  },
): Promise<void> {
  const uid = AuthService.getCurrentUser()?.uid;
  if (!uid) throw new Error("PRIVATE_AGENT_SIGN_IN_REQUIRED");
  const status = await ports.hosting();
  if (status.hostingMode !== "byoc" || status.state !== "active") {
    throw new Error("POD_DIRECT_BYOC_REQUIRED");
  }
  const ownerPod = await import("./owner-pod-endpoint");
  const endpoint = await ownerPod.refreshEndpointFromHub(
    uid,
    await ports.transport(),
  );
  if (endpoint.hushhId !== status.hushhId)
    throw new Error("POD_DIRECT_OWNER_MISMATCH");
  const session = await ownerPod.openPodSession(
    uid,
    await ports.transport(),
    true,
  );
  const probe = await ports.fetch(`${endpoint.url}/api/one/pod/status`, {
    method: "GET",
    credentials: "omit",
    headers: { Authorization: `Bearer ${session.session}` },
    cache: "no-store",
  });
  if (!probe.ok) throw new Error(`POD_DIRECT_UNAVAILABLE:${probe.status}`);
}


/** Select hosting once per request. A verified pin permits hub-outage continuity. */
export async function agentChatRequest(path: string, init: RequestInit, ports: {
  hosting: () => Promise<{ hostingMode?: string }>;
  fetch: AccessPorts["fetch"];
  direct: AccessPorts["fetch"];
}): Promise<Response> {
  if (!/^\/api\/one\/agent-chat(?:$|[/?])/.test(path) || path.includes("#")) {
    throw new Error("AGENT_CHAT_ROUTE_REFUSED");
  }
  const usePod = await usesOwnerPod(ports.hosting);
  return usePod ? ports.direct(path.slice("/api/one/".length), init) : ports.fetch(path, init);
}

/** Shared by chat and review; a direct failure must never fall back to the hub. */
export async function usesOwnerPod(hosting: () => Promise<{ hostingMode?: string }>): Promise<boolean> {
  const uid = AuthService.getCurrentUser()?.uid;
  if (!uid) throw new Error("PRIVATE_AGENT_SIGN_IN_REQUIRED");
  const ownerPod = await import("./owner-pod-endpoint");
  let usePod = Boolean(await ownerPod.loadPinnedEndpoint(uid));
  if (!usePod) {
    const status = await hosting();
    if (status.hostingMode === "byoc") usePod = true;
    else if (status.hostingMode !== "shared") throw new Error("AGENT_PRIVATE_RUNTIME_REQUIRED");
  }
  if (AuthService.getCurrentUser()?.uid !== uid) throw new Error("POD_OWNER_CHANGED");
  return usePod;
}
