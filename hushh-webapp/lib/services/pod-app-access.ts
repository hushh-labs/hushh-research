import { AuthService } from "./auth-service";
import type { OwnerPodTransport } from "./owner-pod-endpoint";
type AccessPorts = {
  transport: () => Promise<OwnerPodTransport>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
};
export async function ownerPodRequest(
  path: string,
  init: RequestInit,
  ports: AccessPorts,
): Promise<Response> {
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
  ]);
  if (!allowed.has(route) || path.includes("#"))
    throw new Error("POD_APP_ROUTE_REFUSED");
  const uid = AuthService.getCurrentUser()?.uid;
  if (!uid) throw new Error("PRIVATE_AGENT_SIGN_IN_REQUIRED");
  const ownerPod = await import("./owner-pod-endpoint");
  const transport = await ports.transport();
  let endpoint = await ownerPod.loadPinnedEndpoint(uid);
  if (!endpoint)
    endpoint = await ownerPod.refreshEndpointFromHub(uid, transport);
  const connection = await ownerPod.currentPodConnection(uid, transport);
  endpoint = connection.endpoint;
  const session = connection.session;
  if (AuthService.getCurrentUser()?.uid !== uid)
    throw new Error("POD_OWNER_CHANGED");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.session}`);
  const response = await ports.fetch(`${endpoint.url}/api/one/pod/${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  if (AuthService.getCurrentUser()?.uid !== uid)
    throw new Error("POD_OWNER_CHANGED");
  return response;
}

export async function reconnectOwnerPod(
  ports: AccessPorts & {
    hosting: () => Promise<{
      hostingMode?: string;
      state?: string;
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
    headers: { Authorization: `Bearer ${session.session}` },
    cache: "no-store",
  });
  if (!probe.ok) throw new Error(`POD_DIRECT_UNAVAILABLE:${probe.status}`);
}
