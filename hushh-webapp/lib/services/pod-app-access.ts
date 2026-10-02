import { AuthService } from "./auth-service";
import type { OwnerPodTransport } from "./owner-pod-endpoint";
type AccessPorts = {
  transport: () => Promise<OwnerPodTransport>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  onChatAdmission?: (hushhId: string) => void;
};
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
  const allowed = new Set([
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
  ]);
  const chatRoute = route === "agent-chat" || route === "agent-chat/capabilities" ||
    /^agent-chat\/(history|conversations)\/[A-Za-z0-9_-]{1,256}$/.test(route) ||
    /^agent-chat\/connectors\/[A-Za-z0-9_-]{1,128}\/mcp\/review$/.test(route);
  if ((!allowed.has(route) && !chatRoute) || path.includes("#"))
    throw new Error("POD_APP_ROUTE_REFUSED");
  const uid = AuthService.getCurrentUser()?.uid;
  if (!uid) throw new Error("PRIVATE_AGENT_SIGN_IN_REQUIRED");
  const ownerPod = await import("./owner-pod-endpoint");
  const transport = await ports.transport();
  let endpoint = await ownerPod.loadPinnedEndpoint(uid);
  if (!endpoint)
    endpoint = await ownerPod.refreshEndpointFromHub(uid, transport);
  const connection = await ownerPod.currentPodConnection(uid, transport);
  // Admission is shared with other tabs. A cancelled caller must not dispatch
  // grants or private work when that independently owned admission finishes.
  refuseCancelled();
  endpoint = connection.endpoint;
  if (expectedHushhId && endpoint.hushhId !== expectedHushhId)
    throw new Error("POD_DIRECT_OWNER_MISMATCH");
  const session = connection.session;
  if (AuthService.getCurrentUser()?.uid !== uid)
    throw new Error("POD_OWNER_CHANGED");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.session}`);
  let body = init.body;
  if (route === "agent-chat" && init.method?.toUpperCase() === "POST") {
    if (typeof body !== "string") throw new Error("POD_CHAT_REQUEST_INVALID");
    const turn = JSON.parse(body) as Record<string, unknown>;
    const grants = await directChatGrants(endpoint, transport, init.signal);
    if (AuthService.getCurrentUser()?.uid !== uid) throw new Error("POD_OWNER_CHANGED");
    turn.forwardedProps = {
      ...(turn.forwardedProps && typeof turn.forwardedProps === "object" ? turn.forwardedProps : {}),
      dataDoorGrants: grants,
    };
    body = JSON.stringify(turn);
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

async function directChatGrants(
  endpoint: import("./owner-pod-endpoint").PinnedEndpoint,
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
