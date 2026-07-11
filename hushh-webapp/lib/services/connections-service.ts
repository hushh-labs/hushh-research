import { ApiService } from "@/lib/services/api-service";

export type ConnectionRelationship =
  | "none"
  | "pending_outgoing"
  | "pending_incoming"
  | "connected";

export interface DirectoryPerson {
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
  email: string | null;
  relationship: ConnectionRelationship;
}

export interface DirectoryPage {
  items: DirectoryPerson[];
  page: number;
  hasMore: boolean;
}

export interface ConnectionSummaryEntry {
  connectionId: string;
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
  createdAt: string | null;
}

export interface ConnectionRequest {
  id: string;
  requesterUserId: string;
  addresseeUserId: string;
  status: string;
  message: string | null;
  counterpartUserId: string;
  counterpartDisplayName: string | null;
}

function authHeaders(idToken: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` };
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error((payload as { error?: string })?.error || `Request failed (${response.status})`);
  }
  return payload as T;
}

export class ConnectionsService {
  static async searchDirectory(opts: {
    idToken: string;
    query?: string;
    page?: number;
    limit?: number;
  }): Promise<DirectoryPage> {
    const params = new URLSearchParams();
    if (opts.query) params.set("query", opts.query);
    params.set("page", String(opts.page ?? 1));
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
    const response = await ApiService.apiFetch(`/api/one/connections/directory?${params.toString()}`, {
      method: "GET",
      headers: authHeaders(opts.idToken),
    });
    return jsonOrThrow<DirectoryPage>(response);
  }

  static async listConnections(opts: { idToken: string }): Promise<ConnectionSummaryEntry[]> {
    const response = await ApiService.apiFetch("/api/one/connections", {
      method: "GET",
      headers: authHeaders(opts.idToken),
    });
    const payload = await jsonOrThrow<{ items: ConnectionSummaryEntry[] }>(response);
    return payload.items ?? [];
  }

  static async listRequests(opts: {
    idToken: string;
    direction: "incoming" | "outgoing";
  }): Promise<ConnectionRequest[]> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests?direction=${opts.direction}`,
      { method: "GET", headers: authHeaders(opts.idToken) },
    );
    const payload = await jsonOrThrow<{ items: ConnectionRequest[] }>(response);
    return payload.items ?? [];
  }

  static async sendRequest(opts: {
    idToken: string;
    addresseeUserId: string;
    message?: string;
  }): Promise<void> {
    const response = await ApiService.apiFetch("/api/one/connections/requests", {
      method: "POST",
      headers: authHeaders(opts.idToken),
      body: JSON.stringify({ addressee_user_id: opts.addresseeUserId, message: opts.message }),
    });
    await jsonOrThrow<unknown>(response);
  }

  static async accept(opts: { idToken: string; requestId: string }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests/${encodeURIComponent(opts.requestId)}/accept`,
      { method: "POST", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async reject(opts: { idToken: string; requestId: string }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests/${encodeURIComponent(opts.requestId)}/reject`,
      { method: "POST", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async cancel(opts: { idToken: string; requestId: string }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests/${encodeURIComponent(opts.requestId)}/cancel`,
      { method: "POST", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async removeConnection(opts: { idToken: string; connectionId: string }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/${encodeURIComponent(opts.connectionId)}`,
      { method: "DELETE", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async linkCircleInvite(opts: { idToken: string; peerUserId: string }): Promise<void> {
    const response = await ApiService.apiFetch("/api/one/connections/link-circle-invite", {
      method: "POST",
      headers: authHeaders(opts.idToken),
      body: JSON.stringify({ peer_user_id: opts.peerUserId }),
    });
    await jsonOrThrow<unknown>(response);
  }
}
