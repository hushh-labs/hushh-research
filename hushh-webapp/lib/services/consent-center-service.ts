import { ApiService } from "@/lib/services/api-service";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";

export const CONSENT_CENTER_PAGE_SIZE = 20;

export type ConsentCenterActor = "investor" | "ria";
export type ConsentCenterView =
  | "incoming"
  | "outgoing"
  | "active"
  | "history"
  | "invites"
  | "developer";

export interface ConsentCenterEntry {
  id: string;
  kind: "incoming_request" | "outgoing_request" | "active_grant" | "history" | "invite";
  status: string;
  action: string;
  scope?: string | null;
  scope_description?: string | null;
  counterpart_type: "ria" | "investor" | "developer" | "self";
  counterpart_id?: string | null;
  counterpart_label?: string | null;
  counterpart_email?: string | null;
  counterpart_secondary_label?: string | null;
  counterpart_image_url?: string | null;
  counterpart_website_url?: string | null;
  request_id?: string | null;
  invite_id?: string | null;
  relationship_status?: string | null;
  relationship_state?: string | null;
  allowed_next_action?: string | null;
  issued_at?: number | string | null;
  expires_at?: number | string | null;
  approval_timeout_at?: number | string | null;
  request_url?: string | null;
  reason?: string | null;
  is_scope_upgrade?: boolean | null;
  existing_granted_scopes?: string[] | null;
  additional_access_summary?: string | null;
  technical_identity?: {
    user_id?: string | null;
  } | null;
  metadata?: Record<string, unknown> | null;
}

export interface ConsentRequestorGroup {
  id: string;
  counterpart_type: "ria" | "investor" | "developer" | "self";
  counterpart_id?: string | null;
  counterpart_label?: string | null;
  latest_request_at?: number | string | null;
  status?: string | null;
  request_count: number;
  scopes: string[];
  entries: ConsentCenterEntry[];
}

export interface SelfActivitySummary {
  active_sessions: number;
  recent_operations_24h: number;
  last_activity_at?: number | string | null;
  recent: Array<{
    id: string;
    agent_id?: string | null;
    scope?: string | null;
    action: string;
    scope_description?: string | null;
    issued_at?: number | string | null;
    expires_at?: number | string | null;
    metadata?: Record<string, unknown> | null;
  }>;
}

export interface ConsentCenterSummary {
  incoming_requests: number;
  outgoing_requests: number;
  active_grants: number;
  invites: number;
  history: number;
  developer_requests: number;
  ria_roster: {
    total: number;
    approved: number;
    pending: number;
    invited: number;
  };
}

export interface ConsentCenterResponse {
  user_id: string;
  persona_state: {
    user_id: string;
    personas: Array<"investor" | "ria">;
    last_active_persona: "investor" | "ria";
    active_persona: "investor" | "ria";
    primary_nav_persona: "investor" | "ria";
    ria_setup_available: boolean;
    ria_switch_available: boolean;
    dev_ria_bypass_allowed: boolean;
    investor_marketplace_opt_in: boolean;
    iam_schema_ready: boolean;
    mode: "full" | "compat_investor";
  };
  ria_onboarding?: {
    exists: boolean;
    ria_profile_id?: string;
    verification_status: string;
    display_name?: string;
    legal_name?: string | null;
    finra_crd?: string | null;
    sec_iard?: string | null;
  } | null;
  summary: ConsentCenterSummary;
  incoming_requests: ConsentCenterEntry[];
  outgoing_requests: ConsentCenterEntry[];
  active_grants: ConsentCenterEntry[];
  history: ConsentCenterEntry[];
  invites: ConsentCenterEntry[];
  developer_requests: ConsentCenterEntry[];
  requestor_groups: {
    pending: ConsentRequestorGroup[];
    active: ConsentRequestorGroup[];
    previous: ConsentRequestorGroup[];
  };
  self_activity_summary?: SelfActivitySummary | null;
}

export interface ConsentCenterPageSummary {
  user_id: string;
  actor: ConsentCenterActor;
  counts: {
    pending: number;
    active: number;
    previous: number;
  };
}

export interface ConsentCenterPageListResponse {
  user_id: string;
  actor: ConsentCenterActor;
  surface: "pending" | "active" | "previous";
  query: string;
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  items: ConsentCenterEntry[];
}

interface FetchCenterOptions {
  idToken: string;
  userId: string;
  actor?: ConsentCenterActor;
  view?: ConsentCenterView;
  force?: boolean;
}

interface CreateRequestOptions {
  idToken: string;
  userId: string;
  payload: {
    subject_user_id: string;
    requester_actor_type?: "ria";
    subject_actor_type?: "investor";
    scope_template_id: string;
    selected_scope?: string;
    duration_mode?: "preset" | "custom";
    duration_hours?: number;
    firm_id?: string;
    reason?: string;
  };
}

interface DisconnectRelationshipOptions {
  idToken: string;
  investor_user_id?: string;
  ria_profile_id?: string;
}

interface ErrorPayload {
  detail?: string;
  error?: string;
}

export class ConsentCenterService {
  static async getCenter(options: FetchCenterOptions): Promise<ConsentCenterResponse> {
    const { idToken, userId, actor = "investor", view = "incoming", force = false } = options;
    const cacheKey = CACHE_KEYS.CONSENT_CENTER(userId, `${actor}:${view}`);
    const cache = CacheService.getInstance();

    if (!force) {
      const cached = cache.get<ConsentCenterResponse>(cacheKey);
      if (cached) return cached;
    }

    const query = new URLSearchParams({ actor, view });
    const response = await ApiService.apiFetch(`/api/consent/center?${query.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    const payload = (await response.json().catch(() => ({}))) as ConsentCenterResponse & {
      detail?: string;
      error?: string;
    };

    if (!response.ok) {
      const message = payload.detail || payload.error || `Request failed: ${response.status}`;
      throw new Error(message);
    }

    payload.requestor_groups = payload.requestor_groups || {
      pending: [],
      active: [],
      previous: [],
    };
    payload.self_activity_summary = payload.self_activity_summary || null;

    cache.set(cacheKey, payload, CACHE_TTL.SHORT);
    cache.set(CACHE_KEYS.CONSENT_CENTER(userId, "all"), payload, CACHE_TTL.SHORT);
    return payload;
  }

  static async listOutgoingRequests(idToken: string): Promise<{ items: ConsentCenterEntry[] }> {
    const response = await ApiService.apiFetch("/api/consent/requests/outgoing", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });
    const payload = (await response.json().catch(() => ({ items: [] }))) as {
      items?: ConsentCenterEntry[];
      detail?: string;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `Request failed: ${response.status}`);
    }
    return { items: payload.items || [] };
  }

  static async getSummary(options: {
    idToken: string;
    userId: string;
    actor?: ConsentCenterActor;
    force?: boolean;
  }): Promise<ConsentCenterPageSummary> {
    const actor = options.actor || "investor";
    const cacheKey = CACHE_KEYS.CONSENT_CENTER_SUMMARY(options.userId, actor);
    const cache = CacheService.getInstance();
    if (!options.force) {
      const cached = cache.get<ConsentCenterPageSummary>(cacheKey);
      if (cached) return cached;
    }
    const query = new URLSearchParams({ actor });
    const response = await ApiService.apiFetch(`/api/consent/center/summary?${query.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.idToken}`,
      },
    });
    const payload = (await response.json().catch(() => ({}))) as ConsentCenterPageSummary & ErrorPayload;
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `Request failed: ${response.status}`);
    }
    cache.set(cacheKey, payload, CACHE_TTL.SHORT);
    return payload;
  }

  static async listEntries(options: {
    idToken: string;
    userId: string;
    actor?: ConsentCenterActor;
    surface: "pending" | "active" | "previous";
    q?: string;
    page?: number;
    limit?: number;
    top?: number;
    force?: boolean;
  }): Promise<ConsentCenterPageListResponse> {
    const actor = options.actor || "investor";
    const q = options.q || "";
    const previewTop = typeof options.top === "number" ? Math.max(1, Math.min(options.top, 10)) : null;
    const page = previewTop ? 1 : options.page || 1;
    const limit = previewTop ?? (options.limit || CONSENT_CENTER_PAGE_SIZE);
    const cacheKey = previewTop
      ? CACHE_KEYS.CONSENT_CENTER_PREVIEW(options.userId, actor, options.surface, previewTop)
      : CACHE_KEYS.CONSENT_CENTER_LIST(options.userId, actor, options.surface, q, page, limit);
    const cache = CacheService.getInstance();
    if (!options.force) {
      const cached = cache.get<ConsentCenterPageListResponse>(cacheKey);
      if (cached) return cached;
    }
    const query = new URLSearchParams({
      actor,
      surface: options.surface,
    });
    if (previewTop) {
      query.set("top", String(previewTop));
    } else {
      query.set("page", String(page));
      query.set("limit", String(limit));
    }
    if (q.trim()) query.set("q", q.trim());
    const response = await ApiService.apiFetch(`/api/consent/center/list?${query.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.idToken}`,
      },
    });
    const payload = (await response.json().catch(() => ({}))) as ConsentCenterPageListResponse &
      ErrorPayload;
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `Request failed: ${response.status}`);
    }
    payload.items = Array.isArray(payload.items) ? payload.items : [];
    cache.set(cacheKey, payload, CACHE_TTL.SHORT);
    return payload;
  }

  static async createRequest(options: CreateRequestOptions) {
    const { idToken, userId, payload } = options;
    const response = await ApiService.apiFetch("/api/consent/requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        requester_actor_type: "ria",
        subject_actor_type: "investor",
        duration_mode: "preset",
        ...payload,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      detail?: string;
      error?: string;
      request_id?: string;
      scope?: string;
      status?: string;
      expires_at?: number;
    };

    if (!response.ok) {
      throw new Error(body.detail || body.error || `Request failed: ${response.status}`);
    }

    CacheSyncService.onConsentMutated(userId);
    return body;
  }

  static async disconnectRelationship(options: DisconnectRelationshipOptions) {
    const response = await ApiService.apiFetch("/api/consent/relationships/disconnect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.idToken}`,
      },
      body: JSON.stringify({
        investor_user_id: options.investor_user_id,
        ria_profile_id: options.ria_profile_id,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      detail?: string;
      error?: string;
      relationship_status?: string;
      revoked_scopes?: string[];
    };

    if (!response.ok) {
      throw new Error(body.detail || body.error || `Request failed: ${response.status}`);
    }

    if (options.investor_user_id) {
      CacheSyncService.onConsentMutated(options.investor_user_id);
    }
    return body;
  }
}
