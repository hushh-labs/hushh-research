import { AuthService } from "./auth-service";
import type { OwnerPodTransport, PinnedEndpoint, PodSessionRecord } from "./owner-pod-endpoint";
import {
  PodNotReachedError,
  PodSendUnconfirmedError,
  beforeTurnIsSent,
  isAgentStillWaking,
  notReachedBeforeSend,
} from "@/lib/agent/owner-pod-wake";
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
  // Admission is shared, so a cancelled caller stops waiting without cancelling it.
  const connect = async () => {
    if (!(await ownerPod.loadPinnedEndpoint(uid)))
      await untilCancelled(ownerPod.refreshEndpointFromHub(uid, transport), init.signal);
    return untilCancelled(ownerPod.currentPodConnection(uid, transport), init.signal);
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
  const request: RequestInit = { ...init, credentials: "omit", body, headers, cache: "no-store" };
  const response = chatTurn
    ? await sendChatTurn(endpoint.url, request, ports.fetch)
    : await ports.fetch(`${endpoint.url}/api/one/pod/${path}`, request);
  if (!isAgentStillWaking(response)) agentAnswered.set(endpoint.url, Date.now());
  if (AuthService.getCurrentUser()?.uid !== uid)
    throw new Error("POD_OWNER_CHANGED");
  if (response.ok && route === "agent-chat") ports.onChatAdmission?.(endpoint.hushhId);
  return response;
}

/** Stop waiting when the caller cancels; the shared work itself keeps running. */
function untilCancelled<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return work;
  const reason = () => signal.reason ?? new DOMException("Agent request cancelled", "AbortError");
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(reason());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/**
 * When each agent address last gave a real answer. An agent that answered this
 * recently is awake, so its next turn goes straight out. Scale-to-zero waits
 * minutes of idle time (Azure Container Apps defaults to 300 s), well past this.
 */
const agentAnswered = new Map<string, number>();
const AGENT_AWAKE_MS = 60_000;

/** Forget which agents answered recently. Tests start from a cold agent. */
export function forgetAgentAnswers(): void {
  agentAnswered.clear();
}

function isCancellation(error: unknown, signal?: AbortSignal | null): boolean {
  return Boolean(signal?.aborted) || (error instanceof DOMException && error.name === "AbortError");
}

/**
 * Send a chat turn so that a failure is classified honestly. A sleeping agent
 * whose ingress resets the first connection would otherwise fail the turn's own
 * POST, where nothing proves whether it arrived. So an agent not heard from
 * recently is asked a cheap, side-effect-free question first (capabilities): if
 * that gets no answer, or only a gateway page, the turn provably was never sent
 * and can wait for the wake. A failure of the POST itself stays ambiguous.
 */
async function sendChatTurn(url: string, request: RequestInit, fetch: AccessPorts["fetch"]): Promise<Response> {
  const answeredAt = agentAnswered.get(url);
  if (answeredAt === undefined || Date.now() - answeredAt > AGENT_AWAKE_MS) {
    let probe: Response;
    try {
      probe = await fetch(`${url}/api/one/pod/agent-chat/capabilities`, {
        method: "GET", headers: request.headers, credentials: "omit", cache: "no-store", signal: request.signal,
      });
    } catch (error) {
      if (isCancellation(error, request.signal)) throw error;
      throw notReachedBeforeSend();
    }
    void probe.body?.cancel().catch(() => undefined);
    if (isAgentStillWaking(probe)) throw new PodNotReachedError();
    agentAnswered.set(url, Date.now());
  }
  try {
    return await fetch(`${url}/api/one/pod/agent-chat`, request);
  } catch (error) {
    if (isCancellation(error, request.signal)) throw error;
    throw new PodSendUnconfirmedError();
  }
}

/**
 * The hub refused chat grants. Its 409s say different things (not ready yet,
 * migrating, moved), so the hub's code travels with the error. Only the
 * migrating refusal carries a hub-written sentence, and the copy layer
 * re-checks it before showing it.
 */
async function chatAuthorityRefusal(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  const detail = body?.detail && typeof body.detail === "object" ? body.detail as Record<string, unknown> : {};
  const hubCode = typeof detail.code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(detail.code) ? detail.code : "";
  const code = `POD_CHAT_AUTHORITY_UNAVAILABLE:${response.status}${hubCode ? `:${hubCode}` : ""}`;
  const sentence = hubCode === "AGENT_MIGRATING" && typeof detail.message === "string" ? detail.message : "";
  return Object.assign(new Error(sentence || code), { code });
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
      await untilCancelled(ownerPod.refreshEndpointFromHub(uid, transport), signal);
      return untilCancelled(ownerPod.currentPodConnection(uid, transport), signal);
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
  if (!response.ok) throw await chatAuthorityRefusal(response);
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

/**
 * Pre-unlock words may reach the hub's public tier only when no private agent owns them:
 * an anonymous visitor, or confirmed Shared / Hussh-hosted. A pinned agent, own-cloud,
 * setup in progress or an unreadable status keeps them on this device.
 */
export async function introMayReachHub(hosting: () => Promise<{ hostingMode?: string }>): Promise<boolean> {
  const uid = AuthService.getCurrentUser()?.uid;
  if (!uid) return true;
  const ownerPod = await import("./owner-pod-endpoint");
  if (await ownerPod.loadPinnedEndpoint(uid).catch(() => null)) return false;
  const mode = await hosting().then((status) => status.hostingMode, () => undefined);
  return mode === "shared" || mode === "hussh_pods";
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
