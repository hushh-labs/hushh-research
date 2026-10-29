import { isPrivateHostingMode } from "@/lib/one/owner-cloud";
import { AuthService } from "./auth-service";
import { snapshotValidatedAuthSessionPrincipal, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { markAgentAnswered, sendChatTurn } from "./pod-chat-turn-transport";
export { forgetAgentAnswers } from "./pod-chat-turn-transport";
import {
  snapshotVaultSessionEpoch,
  isVaultSessionEpochCurrent,
} from "@/lib/vault/session-epoch";
import type {
  OwnerPodTransport,
  PinnedEndpoint,
  OwnerPodConnection,
} from "./owner-pod-endpoint";
import {
  beforeTurnIsSent,
  isAgentStillWaking,
} from "@/lib/agent/owner-pod-wake";
type AccessPorts = {
  transport: () => Promise<OwnerPodTransport>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  onChatAdmission?: (hushhId: string) => void;
  isCurrent?: () => boolean;
};

function capturePodOwner() {
  const principal = snapshotValidatedAuthSessionPrincipal();
  if (!principal || AuthService.getCurrentUser()?.uid !== principal.firebaseUid)
    throw new Error("PRIVATE_AGENT_SIGN_IN_REQUIRED");
  return principal;
}

function podOwnerIsCurrent(principal: NonNullable<ReturnType<typeof snapshotValidatedAuthSessionPrincipal>>): boolean {
  return isValidatedAuthSessionOwnerCurrent(principal)
    && AuthService.getCurrentUser()?.uid === principal.firebaseUid;
}
function refuseRetiredOwner(isCurrent?: () => boolean): void {
  if (isCurrent && !isCurrent()) throw new Error("POD_OWNER_CHANGED");
}
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
  "memory/proposals",
  "memory/status",
  "memory/provider-consent",
  "turn/stream",
  "turn/cancel",
  "puppy/models",
  "ai-selection",
  "ai-selection/clear-if-current",
  "actions/gmail/proposals",
  "browser/capability",
  "browser/tasks",
  "tasks",
  "tasks/control",
]);

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * Parameterised agent routes, one exact pattern each, mirroring the pod's own
 * app-surface list (consent-protocol/api/middlewares/pod_ingress.py).
 */
const OWNER_POD_ROUTE_PATTERNS: readonly RegExp[] = [
  /^actions\/(gcal|gmod|gdrv)_[A-Za-z0-9_-]{16,64}\/confirm$/,
  /^browser\/tasks\/browser_[a-f0-9]{32}(\/(frame|control|input|review|session))?$/,
  /^connectors\/(gmail|calendar|drive|contacts)$/,
  /^agent-chat\/(history|conversations)\/[A-Za-z0-9_-]{1,256}$/,
  /^agent-chat\/history\/[A-Za-z0-9_-]{1,256}\/information-requests$/,
  /^agent-chat\/connectors\/[A-Za-z0-9_-]{1,128}\/mcp\/review$/,
  // Settings' tool refresh and connector login, for owner-registered connectors only.
  /^agent-chat\/connectors\/custom_[0-9a-f]{32}\/mcp\/(catalog|verify|oauth\/(begin|complete|cancel))$/,
  // Messages typed while a reply runs, and stop.
  /^agent-chat\/runs\/[A-Za-z0-9_-]{1,256}\/(queue|stop)$/,
  /^agent-chat\/runs\/[A-Za-z0-9_-]{1,256}\/queue\/[A-Za-z0-9_-]{8,64}$/,
  // Voice and typed command proposals checkpointed in the agent.
  new RegExp(`^agent-chat/proposals/${UUID}(/(settle|dispatch))?$`),
];
const OWNER_POD_AGENT_ROUTES = new Set([
  "agent-chat",
  "agent-chat/capabilities",
  "agent-chat/feedback",
  "agent-chat/proposals",
  "agent-chat/proposals/typed",
]);

/** The only pod routes this app reaches directly. */
function isOwnerPodRoute(route: string): boolean {
  if (OWNER_POD_ROUTES.has(route) || OWNER_POD_AGENT_ROUTES.has(route))
    return true;
  return OWNER_POD_ROUTE_PATTERNS.some((pattern) => pattern.test(route));
}

export async function ownerPodRequest(
  path: string,
  init: RequestInit,
  ports: AccessPorts,
  expectedHushhId?: string,
  expectedUserId?: string,
  expectedVaultEpoch?: number,
): Promise<Response> {
  refuseRetiredOwner(ports.isCurrent);
  const vaultEpoch = expectedVaultEpoch ?? snapshotVaultSessionEpoch();
  if (!isVaultSessionEpochCurrent(vaultEpoch))
    throw new Error("POD_VAULT_SESSION_CHANGED");
  const refuseCancelled = () => {
    if (init.signal?.aborted)
      throw (
        init.signal.reason ??
        new DOMException("Agent request cancelled", "AbortError")
      );
  };
  refuseCancelled();
  const route = path.split("?")[0] ?? "";
  if (!isOwnerPodRoute(route) || path.includes("#"))
    throw new Error("POD_APP_ROUTE_REFUSED");
  const admittedOwner = capturePodOwner();
  const uid = admittedOwner.ownerId;
  if (expectedUserId && expectedUserId !== uid)
    throw new Error("POD_OWNER_CHANGED");
  const ownerPod = await import("./owner-pod-endpoint");
  const transport = await ports.transport();
  const chatTurn =
    route === "agent-chat" && init.method?.toUpperCase() === "POST";
  // Admission is shared, so a cancelled caller stops waiting without cancelling it.
  const connect = async () => {
    if (!(await ownerPod.loadPinnedEndpoint(uid)))
      await untilCancelled(
        ownerPod.refreshEndpointFromHub(uid, transport),
        init.signal,
      );
    return untilCancelled(
      ownerPod.currentPodConnection(uid, transport),
      init.signal,
    );
  };
  // A chat turn's admission happens before the turn is handed over: a network
  // failure there (an agent still waking) proves nothing was sent.
  const connection = chatTurn
    ? await beforeTurnIsSent(connect)
    : await connect();
  // Admission is shared with other tabs. A cancelled caller must not dispatch
  // grants or private work when that independently owned admission finishes.
  refuseCancelled();
  let { endpoint, session, directVerifiedAt } = connection;
  if (expectedHushhId && endpoint.hushhId !== expectedHushhId)
    throw new Error("POD_DIRECT_OWNER_MISMATCH");
  if (!podOwnerIsCurrent(admittedOwner))
    throw new Error("POD_OWNER_CHANGED");
  let body = init.body;
  if (chatTurn) {
    if (typeof body !== "string") throw new Error("POD_CHAT_REQUEST_INVALID");
    const turn = JSON.parse(body) as Record<string, unknown>;
    const admitted = await chatGrantsFollowingEndpoint(
      uid,
      connection,
      transport,
      init.signal,
    );
    ({ endpoint, session, directVerifiedAt } = admitted);
    if (!podOwnerIsCurrent(admittedOwner))
      throw new Error("POD_OWNER_CHANGED");
    turn.forwardedProps = {
      ...(turn.forwardedProps && typeof turn.forwardedProps === "object"
        ? turn.forwardedProps
        : {}),
      dataDoorGrants: admitted.grants,
    };
    body = JSON.stringify(turn);
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.session}`);
  const method = (init.method ?? "GET").toUpperCase();
  if (route === "tasks" || route === "tasks/control") {
    if (!(route === "tasks" && method === "GET") && method !== "POST")
      throw new Error("SCHEDULE_ROUTE_REFUSED");
    const scope = method === "GET" ? "pod.status" : "pod.act";
    if (
      session.role !== "app" ||
      !session.scopes.includes(scope) ||
      (method !== "GET" && !session.scopes.includes("files.manage"))
    ) {
      throw new Error("SCHEDULE_GRANT_REFUSED");
    }
  }
  if (route.startsWith("browser/")) {
    const read =
      route === "browser/capability" ||
      (route === "browser/tasks" && method === "GET") ||
      /^browser\/tasks\/browser_[a-f0-9]{32}(\/frame)?$/.test(route);
    const scope = read
      ? "browser.observe"
      : route === "browser/tasks"
        ? "browser.invoke"
        : "browser.control";
    if (
      session.role !== "app" ||
      !session.scopes.includes(scope) ||
      method !== (read ? "GET" : "POST")
    ) {
      throw new Error("POD_BROWSER_REQUEST_REFUSED");
    }
  }
  if (
    route.startsWith("actions/") &&
    (session.role !== "app" ||
      !session.scopes.includes("pod.act") ||
      method !== "POST")
  ) {
    throw new Error("POD_ACTION_REQUEST_REFUSED");
  }
  if (/^connectors\/(gmail|calendar|drive|contacts)$/.test(route)) {
    if (
      !["GET", "PUT", "DELETE"].includes(method) ||
      (method !== "PUT" && body !== undefined && body !== null) ||
      session.role !== "app" ||
      !session.scopes.includes(method === "GET" ? "pod.status" : "pod.config")
    ) {
      throw new Error("POD_CONNECTOR_REQUEST_REFUSED");
    }
    if (method === "PUT") {
      if (typeof body !== "string")
        throw new Error("POD_CONNECTOR_REQUEST_REFUSED");
      const { sealConnectorCredentialRequestBody } =
        await import("@/lib/one/connector-credential-seal");
      body = await sealConnectorCredentialRequestBody(
        body,
        route.slice("connectors/".length),
        { userId: uid, endpoint, session, transport },
      );
      if (!podOwnerIsCurrent(admittedOwner))
        throw new Error("POD_OWNER_CHANGED");
    }
  }
  if (
    route === "ai-selection" &&
    ((method !== "GET" && method !== "DELETE" && method !== "PATCH") ||
      (body !== undefined && body !== null))
  ) {
    // The plaintext selection is sealed HERE, to the hub-signed key of exactly
    // the pod this request is addressed to. Any body on this route must be a
    // sealed PUT, so a plaintext key can never leave the device unsealed.
    if (method !== "PUT" || typeof body !== "string")
      throw new Error("POD_AI_SELECTION_INVALID");
    const { sealAiSelectionRequestBody } =
      await import("@/lib/one/ai-selection-recipient");
    body = await sealAiSelectionRequestBody(body, {
      userId: uid,
      endpoint,
      session,
      transport,
    });
    if (!podOwnerIsCurrent(admittedOwner))
      throw new Error("POD_OWNER_CHANGED");
  }
  if (route === "ai-selection/clear-if-current") {
    let condition: Record<string, unknown> | null = null;
    try {
      if (typeof body === "string" && body.length <= 512) condition = JSON.parse(body);
    } catch { /* Refuse malformed metadata before it leaves the device. */ }
    if (method !== "POST" || session.role !== "app" || !session.scopes.includes("pod.config") ||
      !condition || typeof condition !== "object" || Array.isArray(condition) ||
      Object.keys(condition).sort().join(",") !== "expectedProvider,expectedSelectionRevision" ||
      typeof condition.expectedProvider !== "string" ||
      !["gemini", "openai", "azure_openai"].includes(condition.expectedProvider) ||
      !Number.isSafeInteger(condition.expectedSelectionRevision) || Number(condition.expectedSelectionRevision) < 1)
      throw new Error("POD_AI_SELECTION_INVALID");
  }
  refuseCancelled();
  refuseRetiredOwner(ports.isCurrent);
  const request: RequestInit = {
    ...init,
    credentials: "omit",
    body,
    headers,
    cache: "no-store",
  };
  if (
    /^connectors\/(gmail|calendar|drive|contacts)$/.test(route) &&
    method === "PUT" &&
    !isVaultSessionEpochCurrent(vaultEpoch)
  ) {
    throw new Error("POD_VAULT_SESSION_CHANGED");
  }
  const response = chatTurn
    ? await sendChatTurn(endpoint.url, request, ports.fetch, directVerifiedAt, session, () => {
        refuseCancelled();
        refuseRetiredOwner(ports.isCurrent);
        if (!podOwnerIsCurrent(admittedOwner) || !isVaultSessionEpochCurrent(vaultEpoch))
          throw new Error("POD_OWNER_CHANGED");
      })
    : await ports.fetch(`${endpoint.url}/api/one/pod/${path}`, request);
  if (!isAgentStillWaking(response))
    markAgentAnswered(endpoint.url);
  if (!podOwnerIsCurrent(admittedOwner))
    throw new Error("POD_OWNER_CHANGED");
  if (response.ok && route === "agent-chat")
    ports.onChatAdmission?.(endpoint.hushhId);
  return response;
}

/** Stop waiting when the caller cancels; the shared work itself keeps running. */
function untilCancelled<T>(
  work: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  if (!signal) return work;
  const reason = () =>
    signal.reason ?? new DOMException("Agent request cancelled", "AbortError");
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(reason());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The hub refused chat grants. Its 409s say different things (not ready yet,
 * migrating, moved), so the hub's code travels with the error. Only the
 * migrating refusal carries a hub-written sentence, and the copy layer
 * re-checks it before showing it.
 */
async function chatAuthorityRefusal(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    detail?: unknown;
  } | null;
  const detail =
    body?.detail && typeof body.detail === "object"
      ? (body.detail as Record<string, unknown>)
      : {};
  const hubCode =
    typeof detail.code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(detail.code)
      ? detail.code
      : "";
  const code = `POD_CHAT_AUTHORITY_UNAVAILABLE:${response.status}${hubCode ? `:${hubCode}` : ""}`;
  const sentence =
    hubCode === "AGENT_MIGRATING" && typeof detail.message === "string"
      ? detail.message
      : "";
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

type PodConnection = OwnerPodConnection;

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
    return {
      ...connection,
      grants: await directChatGrants(connection.endpoint, transport, signal),
    };
  } catch (error) {
    if (!(error instanceof EndpointAdvancedError)) throw error;
    const ownerPod = await import("./owner-pod-endpoint");
    const next = await beforeTurnIsSent(async () => {
      await untilCancelled(
        ownerPod.refreshEndpointFromHub(uid, transport),
        signal,
      );
      return untilCancelled(
        ownerPod.currentPodConnection(uid, transport),
        signal,
      );
    });
    if (
      next.endpoint.hushhId !== connection.endpoint.hushhId ||
      next.endpoint.endpointVersion !== error.endpointVersion
    ) {
      throw new Error("POD_ASSIGNMENT_CHANGED");
    }
    return {
      ...next,
      grants: await directChatGrants(next.endpoint, transport, signal),
    };
  }
}

async function directChatGrants(
  endpoint: PinnedEndpoint,
  transport: OwnerPodTransport,
  signal?: AbortSignal | null,
): Promise<Record<string, string>> {
  let response: Response;
  try {
    response = await transport.hub(
      `/api/one/u/${encodeURIComponent(endpoint.hushhId)}/chat-grants`,
      { method: "POST", cache: "no-store", signal },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    // Existing direct authorization still permits private chat during hub loss.
    // Specialists that need a current hub grant remain explicitly unavailable.
    return {};
  }
  if (response.status >= 500) return {};
  if (!response.ok) throw await chatAuthorityRefusal(response);
  const value = (await response.json()) as {
    endpoint?: Record<string, unknown>;
    dataDoorGrants?: Record<string, unknown>;
  };
  const candidate = value.endpoint;
  if (!candidate) throw new Error("POD_CHAT_GRANTS_INVALID");
  const { signature, ...signed } = candidate;
  const { verifyHubSignature } = await import("./owner-pod-crypto");
  await verifyHubSignature(signed, String(signature ?? ""), transport);
  const version = candidate.endpointVersion;
  if (
    candidate.hushhId === endpoint.hushhId &&
    candidate.environment === endpoint.environment &&
    Number.isInteger(version) &&
    Number(version) > endpoint.endpointVersion
  ) {
    throw new EndpointAdvancedError(Number(version));
  }
  for (const key of [
    "hushhId",
    "url",
    "podKeyId",
    "environment",
    "endpointVersion",
  ] as const) {
    if (candidate[key] !== endpoint[key])
      throw new Error("POD_ASSIGNMENT_CHANGED");
  }
  const grants = value.dataDoorGrants;
  if (
    !grants ||
    typeof grants !== "object" ||
    Array.isArray(grants) ||
    Object.keys(grants).length > 16 ||
    Object.values(grants).some(
      (value) => typeof value !== "string" || value.length > 12000,
    )
  ) {
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
  const admittedOwner = capturePodOwner();
  const uid = admittedOwner.ownerId;
  const status = await ports.hosting();
  if (!podOwnerIsCurrent(admittedOwner)) throw new Error("POD_OWNER_CHANGED");
  if (!isPrivateHostingMode(status.hostingMode) || status.state !== "active") {
    throw new Error("POD_DIRECT_PRIVATE_REQUIRED");
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
  if (!podOwnerIsCurrent(admittedOwner)) throw new Error("POD_OWNER_CHANGED");
  const probe = await ports.fetch(`${endpoint.url}/api/one/pod/status`, {
    method: "GET",
    credentials: "omit",
    headers: { Authorization: `Bearer ${session.session}` },
    cache: "no-store",
  });
  if (!probe.ok) throw new Error(`POD_DIRECT_UNAVAILABLE:${probe.status}`);
}

/** Select hosting once per request. A verified pin permits hub-outage continuity. */
export async function agentChatRequest(
  path: string,
  init: RequestInit,
  ports: {
    hosting: () => Promise<{ hostingMode?: string }>;
    fetch: AccessPorts["fetch"];
    direct: AccessPorts["fetch"];
    isCurrent?: () => boolean;
  },
): Promise<Response> {
  refuseRetiredOwner(ports.isCurrent);
  if (!/^\/api\/one\/agent-chat(?:$|[/?])/.test(path) || path.includes("#")) {
    throw new Error("AGENT_CHAT_ROUTE_REFUSED");
  }
  const usePod = await usesOwnerPod(ports.hosting);
  refuseRetiredOwner(ports.isCurrent);
  return usePod
    ? ports.direct(path.slice("/api/one/".length), init)
    : ports.fetch(path, init);
}

/**
 * Pre-unlock words may reach the hub's public tier only when no private agent owns them:
 * an anonymous visitor, or confirmed Shared. A pinned agent, own-cloud,
 * setup in progress or an unreadable status keeps them on this device.
 */
export async function introMayReachHub(
  hosting: () => Promise<{ hostingMode?: string }>,
): Promise<boolean> {
  if (!AuthService.getCurrentUser()) return true;
  const admittedOwner = snapshotValidatedAuthSessionPrincipal();
  if (!admittedOwner || !podOwnerIsCurrent(admittedOwner)) return false;
  const uid = admittedOwner.ownerId;
  const ownerPod = await import("./owner-pod-endpoint");
  if (await ownerPod.loadPinnedEndpoint(uid).catch(() => null)) return false;
  const mode = await hosting().then(
    (status) => status.hostingMode,
    () => undefined,
  );
  return podOwnerIsCurrent(admittedOwner) && mode === "shared";
}

/** Shared by chat and review; a direct failure must never fall back to the hub. */
export async function usesOwnerPod(
  hosting: () => Promise<{ hostingMode?: string }>,
): Promise<boolean> {
  const admittedOwner = capturePodOwner();
  const uid = admittedOwner.ownerId;
  const ownerPod = await import("./owner-pod-endpoint");
  let usePod = Boolean(await ownerPod.loadPinnedEndpoint(uid));
  if (!usePod) {
    const status = await hosting();
    if (isPrivateHostingMode(status.hostingMode)) usePod = true;
    else if (status.hostingMode !== "shared") {
      // The placement travels with the refusal so the copy can name the next step.
      const mode = /^[a-z_]{1,32}$/.test(String(status.hostingMode ?? ""))
        ? status.hostingMode
        : "unknown";
      throw Object.assign(new Error("AGENT_PRIVATE_RUNTIME_REQUIRED"), {
        code: `AGENT_PRIVATE_RUNTIME_REQUIRED:${mode}`,
        hostingMode: mode,
      });
    }
  }
  if (!podOwnerIsCurrent(admittedOwner))
    throw new Error("POD_OWNER_CHANGED");
  return usePod;
}
