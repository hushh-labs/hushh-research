import { ApiService } from "@/lib/services/api-service";

export type ConnectionRelationship =
  "none" | "pending_outgoing" | "pending_incoming" | "connected";

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
  scopes?: ConnectionScopeProposal[];
}

export interface ConnectionScopeCatalogEntry {
  handle: string;
  label: string;
  description: string;
}

export interface ConnectionScopeCatalog {
  counterpartUserId: string;
  items: ConnectionScopeCatalogEntry[];
  offerableItems: ConnectionScopeCatalogEntry[];
}

export interface ConnectionScopeProposal {
  scopeHandle: string;
  direction: "requested" | "offered";
  label: string;
  description: string;
  status: "pending" | "active" | "declined" | "revoked" | "expired";
  createdAt: string | null;
  resolvedAt: string | null;
}

export interface ConnectionScopeProposalHistory extends ConnectionScopeProposal {
  history: Array<{
    type: string;
    reason: string | null;
    createdAt: string | null;
  }>;
}

export interface ConnectionInformationScope {
  scope: string;
  label: string | null;
  domain: string | null;
  path: string | null;
  wildcard: boolean;
  match_reason: "listed" | "exact_domain_match" | "substring_match" | "fuzzy_match";
}

export interface ConnectionInformationScopeCatalog {
  counterpartUserId: string;
  items: ConnectionInformationScope[];
}

export interface ConnectionCircleSummary {
  id: string;
  name: string;
}

export interface ConnectionRemovalResult {
  removed: number;
  stillConnected?: boolean;
  connectionKind?: string;
  circles?: ConnectionCircleSummary[];
  circleIds?: string[];
  circleNames?: string[];
  canRemoveDirect?: boolean;
}

function authHeaders(idToken: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${idToken}`,
  };
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      (payload as { error?: string })?.error ||
        `Request failed (${response.status})`,
    );
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
    const response = await ApiService.apiFetch(
      `/api/one/connections/directory?${params.toString()}`,
      {
        method: "GET",
        headers: authHeaders(opts.idToken),
      },
    );
    return jsonOrThrow<DirectoryPage>(response);
  }

  static async listConnections(opts: {
    idToken: string;
  }): Promise<ConnectionSummaryEntry[]> {
    const response = await ApiService.apiFetch("/api/one/connections", {
      method: "GET",
      headers: authHeaders(opts.idToken),
    });
    const payload = await jsonOrThrow<{ items: ConnectionSummaryEntry[] }>(
      response,
    );
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

  static async getScopeCatalog(opts: {
    idToken: string;
    counterpartUserId: string;
  }): Promise<ConnectionScopeCatalog> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/${encodeURIComponent(opts.counterpartUserId)}/scope-catalog`,
      { method: "GET", headers: authHeaders(opts.idToken) },
    );
    const payload = await jsonOrThrow<ConnectionScopeCatalog>(response);
    return {
      counterpartUserId: payload.counterpartUserId,
      items: payload.items ?? [],
      offerableItems: payload.offerableItems ?? [],
    };
  }

  static async searchInformationScopes(opts: {
    idToken: string;
    counterpartUserId: string;
    query?: string;
    domain?: string;
    limit?: number;
  }): Promise<ConnectionInformationScopeCatalog> {
    const params = new URLSearchParams();
    if (opts.query) params.set("query", opts.query);
    if (opts.domain) params.set("domain", opts.domain);
    if (opts.limit) params.set("limit", String(opts.limit));
    const response = await ApiService.apiFetch(
      `/api/one/connections/${encodeURIComponent(opts.counterpartUserId)}/information-scopes?${params.toString()}`,
      { method: "GET", headers: authHeaders(opts.idToken) },
    );
    const payload = await jsonOrThrow<ConnectionInformationScopeCatalog>(response);
    return { counterpartUserId: payload.counterpartUserId, items: payload.items ?? [] };
  }

  static async sendRequest(opts: {
    idToken: string;
    addresseeUserId: string;
    message?: string;
    requestedScopeHandles?: string[];
    offeredScopeHandles?: string[];
  }): Promise<ConnectionRequest> {
    const response = await ApiService.apiFetch(
      "/api/one/connections/requests",
      {
        method: "POST",
        headers: authHeaders(opts.idToken),
        body: JSON.stringify({
          addressee_user_id: opts.addresseeUserId,
          message: opts.message,
          requested_scope_handles: opts.requestedScopeHandles ?? [],
          offered_scope_handles: opts.offeredScopeHandles ?? [],
        }),
      },
    );
    const payload = await jsonOrThrow<{ request: ConnectionRequest }>(response);
    return payload.request;
  }

  static async getScopeProposalHistory(opts: {
    idToken: string;
    requestId: string;
  }): Promise<ConnectionScopeProposalHistory[]> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests/${encodeURIComponent(opts.requestId)}/scopes`,
      { method: "GET", headers: authHeaders(opts.idToken) },
    );
    const payload = await jsonOrThrow<{
      items: ConnectionScopeProposalHistory[];
    }>(response);
    return payload.items ?? [];
  }

  static async accept(opts: {
    idToken: string;
    requestId: string;
    selectedRequestedScopeHandles?: string[];
    selectedOfferedScopeHandles?: string[];
  }): Promise<void> {
    const hasScopeSelection =
      opts.selectedRequestedScopeHandles !== undefined ||
      opts.selectedOfferedScopeHandles !== undefined;
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests/${encodeURIComponent(opts.requestId)}/accept`,
      {
        method: "POST",
        headers: authHeaders(opts.idToken),
        // Omit the body for legacy no-scope accepts. Proposal-bearing requests
        // fail closed on the server until the review UI supplies both selections.
        body: hasScopeSelection
          ? JSON.stringify({
              selected_requested_scope_handles:
                opts.selectedRequestedScopeHandles ?? [],
              selected_offered_scope_handles:
                opts.selectedOfferedScopeHandles ?? [],
            })
          : undefined,
      },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async reject(opts: {
    idToken: string;
    requestId: string;
  }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests/${encodeURIComponent(opts.requestId)}/reject`,
      { method: "POST", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async cancel(opts: {
    idToken: string;
    requestId: string;
  }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/requests/${encodeURIComponent(opts.requestId)}/cancel`,
      { method: "POST", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async removeConnection(opts: {
    idToken: string;
    connectionId: string;
  }): Promise<ConnectionRemovalResult> {
    const response = await ApiService.apiFetch(
      `/api/one/connections/${encodeURIComponent(opts.connectionId)}`,
      { method: "DELETE", headers: authHeaders(opts.idToken) },
    );
    const payload = await jsonOrThrow<{ result?: ConnectionRemovalResult }>(
      response,
    );
    const result = payload.result ?? { removed: 0 };
    // Prefer canonical Circle objects; synthesize them from the legacy
    // parallel arrays for old servers that predate `circles`, then derive
    // both arrays back from the canonical list so callers see one truth.
    const circles =
      result.circles ??
      result.circleIds?.map((id, index) => ({
        id,
        name: result.circleNames?.[index] ?? id,
      }));
    if (!circles) return result;
    return {
      ...result,
      circles,
      circleIds: circles.map((circle) => circle.id),
      circleNames: circles.map((circle) => circle.name),
    };
  }

  static async linkCircleInvite(opts: {
    idToken: string;
    peerUserId: string;
  }): Promise<void> {
    const response = await ApiService.apiFetch(
      "/api/one/connections/link-circle-invite",
      {
        method: "POST",
        headers: authHeaders(opts.idToken),
        body: JSON.stringify({ peer_user_id: opts.peerUserId }),
      },
    );
    await jsonOrThrow<unknown>(response);
  }
}
