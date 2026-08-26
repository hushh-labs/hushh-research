import { ApiService } from "@/lib/services/api-service";

export type ConnectionRelationship =
  "none" | "pending_outgoing" | "pending_incoming" | "connected";

/**
 * Which half of the directory a search is asking about.
 *
 * The two named audiences partition it: every findable person is in exactly
 * one, so separating advisors never makes anyone unreachable. `"all"` is what
 * every caller that predates the split still gets, and is what spoken-name
 * resolution uses -- someone saying a name is not saying which tab it is in.
 */
export type DirectoryAudience = "all" | "people" | "ria";

export interface DirectoryPerson {
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
  email: string | null;
  maskedEmail?: string | null;
  maskedPhone?: string | null;
  relationship: ConnectionRelationship;
  /**
   * Whether this person holds an RIA profile verified far enough to carry a
   * capability. Server-annotated on the row rather than inferred from which tab
   * asked, so a search across everyone can still label what it found.
   */
  isRia?: boolean;
}

export interface DirectoryPage {
  items: DirectoryPerson[];
  page: number;
  hasMore: boolean;
  audience?: DirectoryAudience;
}

export interface ConnectionSummaryEntry {
  connectionId: string;
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
  createdAt: string | null;
  /**
   * Whether this connection holds a verified RIA profile — the same
   * server-annotated flag `DirectoryPerson` carries, from the same helper, so
   * the two lists on the RIAs tab can never disagree about who is an advisor.
   * Optional so a cached page written before the field existed still parses;
   * absent reads as "not an advisor", which is the safe direction — it hides a
   * row from the RIAs tab rather than claiming someone is verified.
   */
  isRia?: boolean;
  /** Viewer-relative provenance; absent on pre-upgrade cached rows. */
  connectedFromContacts?: boolean;
}

export type ConnectionAudience = "all" | "ria";

export interface ConnectionPage {
  items: ConnectionSummaryEntry[];
  page: number;
  hasMore: boolean;
  totalCount: number;
  audience: ConnectionAudience;
}

export type ContactSyncMatchOutcome =
  | "auto_connected"
  | "already_connected"
  | "request_required"
  | "suppressed";

export interface ContactSyncLookup {
  /** Opaque, invocation-local correlation id. Never derived from phone data. */
  lookupId: string;
  hash: string;
  last4: string;
}

export interface ContactSyncMatch {
  lookupId: string;
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
  outcome: ContactSyncMatchOutcome;
}

export interface ContactSyncBatchResult {
  matches: ContactSyncMatch[];
  /**
   * Opaque lookups whose final match/mutation outcome could not be proven.
   * These must never be treated as unmatched invitation candidates.
   */
  indeterminateLookupIds: string[];
  autoConnectedCount?: number;
  alreadyConnectedCount?: number;
  requestRequiredCount?: number;
  suppressedCount?: number;
}

export class ConnectionsServiceRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ConnectionsServiceRequestError";
    this.status = status;
  }
}

function sanitizeContactSyncMatches(value: unknown): ContactSyncMatch[] {
  if (!Array.isArray(value)) return [];
  const outcomes = new Set<ContactSyncMatchOutcome>([
    "auto_connected",
    "already_connected",
    "request_required",
    "suppressed",
  ]);
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const source = row as Record<string, unknown>;
    const lookupId = String(source.lookupId || "").trim();
    const userId = String(source.userId || "").trim();
    const outcome = String(source.outcome || "") as ContactSyncMatchOutcome;
    if (!lookupId || !userId || !outcomes.has(outcome)) return [];
    return [
      {
        lookupId,
        userId,
        displayName:
          typeof source.displayName === "string" ? source.displayName : null,
        photoUrl: typeof source.photoUrl === "string" ? source.photoUrl : null,
        outcome,
      },
    ];
  });
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
    error?: unknown;
    detail?: unknown;
  };
  if (!response.ok) {
    const errorMessage =
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : null;
    const detailMessage =
      typeof payload.detail === "string" && payload.detail.trim()
        ? payload.detail.trim()
        : payload.detail &&
            typeof payload.detail === "object" &&
            typeof (payload.detail as { message?: unknown }).message === "string" &&
            (payload.detail as { message: string }).message.trim()
          ? (payload.detail as { message: string }).message.trim()
          : null;
    throw new ConnectionsServiceRequestError(
      response.status,
      errorMessage || detailMessage || `Request failed (${response.status})`,
    );
  }
  return payload as T;
}

export class ConnectionsService {
  static async syncContacts(opts: {
    idToken: string;
    lookups: ContactSyncLookup[];
    signal?: AbortSignal;
  }): Promise<ContactSyncBatchResult> {
    if (opts.lookups.length > 1000) {
      throw new Error("Contact sync accepts at most 1000 lookups per batch.");
    }

    const response = await ApiService.apiFetch(
      "/api/one/connections/contact-sync",
      {
        method: "POST",
        headers: authHeaders(opts.idToken),
        signal: opts.signal,
        body: JSON.stringify({
          lookups: opts.lookups.map((lookup) => ({
            lookup_id: lookup.lookupId,
            hash: lookup.hash,
            last4: lookup.last4,
          })),
        }),
      },
    );
    const payload = await jsonOrThrow<{
      matches?: ContactSyncMatch[];
      items?: ContactSyncMatch[];
      autoConnectedCount?: number;
      alreadyConnectedCount?: number;
      requestRequiredCount?: number;
      suppressedCount?: number;
      checkedLookupCount?: number;
      indeterminateLookupIds?: unknown;
    }>(response);
    const rawMatches = payload.matches ?? payload.items;
    const matches = sanitizeContactSyncMatches(rawMatches);
    const rawIndeterminateLookupIds = payload.indeterminateLookupIds;
    const indeterminateLookupIds = Array.isArray(rawIndeterminateLookupIds)
      ? rawIndeterminateLookupIds.flatMap((value) => {
          if (typeof value !== "string") return [];
          const lookupId = value.trim();
          return lookupId ? [lookupId] : [];
        })
      : [];
    const expectedLookupIds = new Set(
      opts.lookups.map((lookup) => lookup.lookupId),
    );
    const matchedLookupIds = new Set(matches.map((match) => match.lookupId));
    const uniqueIndeterminateLookupIds = new Set(indeterminateLookupIds);
    if (
      !Array.isArray(rawMatches) ||
      !Array.isArray(rawIndeterminateLookupIds) ||
      payload.checkedLookupCount !== opts.lookups.length ||
      matches.length !== rawMatches.length ||
      indeterminateLookupIds.length !== rawIndeterminateLookupIds.length ||
      uniqueIndeterminateLookupIds.size !== indeterminateLookupIds.length ||
      matches.some((match) => !expectedLookupIds.has(match.lookupId)) ||
      indeterminateLookupIds.some(
        (lookupId) =>
          !expectedLookupIds.has(lookupId) || matchedLookupIds.has(lookupId),
      )
    ) {
      // A malformed 2xx cannot prove that this mutating batch completed. A
      // plain Error is intentionally retryable by the bounded orchestrator;
      // if the replay also fails, the batch becomes outcome-unknown rather
      // than falsely classifying every contact as unmatched/inviteable.
      throw new Error("Contact sync returned an incomplete response.");
    }
    return {
      // Exact allow-list projection. Even a rolling-back server cannot leak a
      // hash/last-four field into route state through an unexpected extra key.
      matches,
      indeterminateLookupIds,
      autoConnectedCount: payload.autoConnectedCount,
      alreadyConnectedCount: payload.alreadyConnectedCount,
      requestRequiredCount: payload.requestRequiredCount,
      suppressedCount: payload.suppressedCount,
    };
  }

  static async searchDirectory(opts: {
    idToken: string;
    query?: string;
    page?: number;
    limit?: number;
    audience?: DirectoryAudience;
  }): Promise<DirectoryPage> {
    const params = new URLSearchParams();
    if (opts.query) params.set("query", opts.query);
    params.set("page", String(opts.page ?? 1));
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
    // Omitted rather than sent as "all", so the request a pre-split caller
    // makes stays byte-identical to the one it made before.
    if (opts.audience && opts.audience !== "all") {
      params.set("audience", opts.audience);
    }
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

  static async listConnectionsPage(opts: {
    idToken: string;
    page?: number;
    limit?: number;
    query?: string;
    audience?: ConnectionAudience;
  }): Promise<ConnectionPage> {
    const params = new URLSearchParams({
      page: String(opts.page ?? 1),
      limit: String(opts.limit ?? 50),
      audience: opts.audience ?? "all",
    });
    if (opts.query?.trim()) params.set("query", opts.query.trim());
    const response = await ApiService.apiFetch(
      `/api/one/connections?${params.toString()}`,
      { method: "GET", headers: authHeaders(opts.idToken) },
    );
    const payload = await jsonOrThrow<Partial<ConnectionPage>>(response);
    return {
      items: Array.isArray(payload.items) ? payload.items : [],
      page: Math.max(1, Number(payload.page) || opts.page || 1),
      hasMore: Boolean(payload.hasMore),
      totalCount: Math.max(0, Number(payload.totalCount) || 0),
      audience: payload.audience === "ria" ? "ria" : "all",
    };
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
