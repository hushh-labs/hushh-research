import { ApiService } from "@/lib/services/api-service";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";

export type Persona = "investor" | "ria";

export interface PersonaState {
  user_id: string;
  personas: Persona[];
  last_active_persona: Persona;
  active_persona: Persona;
  primary_nav_persona: Persona;
  ria_setup_available: boolean;
  ria_switch_available: boolean;
  dev_ria_bypass_allowed: boolean;
  investor_marketplace_opt_in: boolean;
  iam_schema_ready: boolean;
  mode: "full" | "compat_investor";
}

export interface MarketplaceRia {
  id: string;
  user_id: string;
  display_name: string;
  headline?: string | null;
  strategy_summary?: string | null;
  bio?: string | null;
  strategy?: string | null;
  disclosures_url?: string | null;
  verification_status: string;
  firms?: Array<{
    firm_id: string;
    legal_name: string;
    role_title?: string | null;
    is_primary?: boolean;
  }>;
}

export interface MarketplaceInvestor {
  user_id: string;
  display_name: string;
  headline?: string | null;
  location_hint?: string | null;
  strategy_summary?: string | null;
}

export interface RiaOnboardingStatus {
  exists: boolean;
  ria_profile_id?: string;
  verification_status: string;
  advisory_status?: string;
  brokerage_status?: string;
  requested_capabilities?: string[];
  dev_ria_bypass_allowed?: boolean;
  display_name?: string;
  individual_legal_name?: string | null;
  individual_crd?: string | null;
  advisory_firm_legal_name?: string | null;
  advisory_firm_iapd_number?: string | null;
  broker_firm_legal_name?: string | null;
  broker_firm_crd?: string | null;
  legal_name?: string | null;
  finra_crd?: string | null;
  sec_iard?: string | null;
  latest_verification_event?: {
    outcome: string;
    checked_at: string;
    expires_at?: string | null;
    reference_metadata?: Record<string, unknown>;
  } | null;
  latest_advisory_event?: {
    outcome: string;
    checked_at: string;
    expires_at?: string | null;
    reference_metadata?: Record<string, unknown>;
  } | null;
  latest_brokerage_event?: {
    outcome: string;
    checked_at: string;
    expires_at?: string | null;
    reference_metadata?: Record<string, unknown>;
  } | null;
}

export interface RiaFirmMembership {
  id: string;
  legal_name: string;
  finra_firm_crd?: string | null;
  sec_iard?: string | null;
  website_url?: string | null;
  role_title?: string | null;
  membership_status?: string | null;
  is_primary?: boolean;
}

export interface RiaClientAccess {
  id: string;
  investor_user_id?: string | null;
  status: string;
  relationship_status?: string | null;
  granted_scope?: string | null;
  last_request_id?: string | null;
  investor_display_name?: string | null;
  investor_headline?: string | null;
  acquisition_source?: string | null;
  invite_status?: string | null;
  invite_id?: string | null;
  invite_token?: string | null;
  invite_expires_at?: string | null;
  delivery_channel?: string | null;
  consent_expires_at?: string | null;
  next_action?: string | null;
  scope_template_id?: string | null;
  is_invite_only?: boolean;
  disconnect_allowed?: boolean;
  is_self_relationship?: boolean;
}

export interface RiaAvailableScopeMetadata {
  scope: string;
  label: string;
  description: string;
  kind: string;
  summary_only: boolean;
  available?: boolean;
  domain_key?: string | null;
}

export interface RiaClientRequestSummary {
  request_id?: string | null;
  scope?: string | null;
  action: string;
  issued_at?: number | string | null;
  expires_at?: number | string | null;
  bundle_id?: string | null;
  bundle_label?: string | null;
  scope_metadata?: RiaRequestScopeMetadata;
}

export interface RiaClientDetail {
  investor_user_id: string;
  investor_display_name?: string | null;
  investor_headline?: string | null;
  relationship_status: string;
  granted_scope?: string | null;
  last_request_id?: string | null;
  consent_granted_at?: string | null;
  consent_expires_at?: number | string | null;
  revoked_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  disconnect_allowed: boolean;
  is_self_relationship: boolean;
  next_action?: string | null;
  granted_scopes: Array<{
    scope: string;
    label: string;
    expires_at?: number | string | null;
    issued_at?: number | string | null;
  }>;
  request_history: RiaClientRequestSummary[];
  invite_history: RiaInviteRecord[];
  requestable_scope_templates: RiaRequestScopeTemplate[];
  available_scope_metadata: RiaAvailableScopeMetadata[];
  available_domains: string[];
  domain_summaries: Record<string, unknown>;
  total_attributes: number;
  workspace_ready: boolean;
  pkm_updated_at?: string | null;
}

export interface RiaRequestRecord {
  request_id: string;
  user_id: string;
  scope: string;
  action: string;
  issued_at: number;
  expires_at?: number | null;
  metadata?: Record<string, unknown>;
  subject_display_name?: string | null;
  subject_headline?: string | null;
}

export interface RiaRequestScopeMetadata {
  scope: string;
  label: string;
  description: string;
  kind: string;
  summary_only: boolean;
}

export interface RiaRequestScopeTemplate {
  template_id: string;
  template_name: string;
  description?: string | null;
  default_duration_hours: number;
  max_duration_hours: number;
  scopes: RiaRequestScopeMetadata[];
}

export interface RiaRequestBundleRecord {
  bundle_id: string;
  bundle_label: string;
  subject_user_id?: string | null;
  subject_display_name?: string | null;
  subject_headline?: string | null;
  status: string;
  issued_at?: number | null;
  expires_at?: number | null;
  request_count: number;
  requests: Array<{
    request_id: string;
    scope: string;
    action: string;
    issued_at?: number | null;
    expires_at?: number | null;
    scope_metadata?: RiaRequestScopeMetadata;
  }>;
}

export interface RiaInviteRecord {
  invite_id: string;
  invite_token: string;
  invite_path?: string;
  status: string;
  expires_at?: string | null;
  scope_template_id?: string;
  duration_mode?: string;
  duration_hours?: number | null;
  source?: string;
  delivery_channel?: string;
  target_display_name?: string | null;
  target_email?: string | null;
  target_phone?: string | null;
  target_investor_user_id?: string | null;
  accepted_by_user_id?: string | null;
  accepted_request_id?: string | null;
  delivery_status?: string | null;
  delivery_message?: string | null;
  delivery_message_id?: string | null;
}

export interface RiaPickUploadRecord {
  upload_id: string;
  label: string;
  status: string;
  source_filename?: string | null;
  row_count: number;
  activated_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface RiaPickRow {
  ticker: string;
  company_name?: string | null;
  sector?: string | null;
  tier?: string | null;
  tier_rank?: number | null;
  conviction_weight?: number | null;
  recommendation_bias?: string | null;
  investment_thesis?: string | null;
  fcf_billions?: number | null;
}

export interface RiaInviteResolution {
  invite_id: string;
  invite_token: string;
  status: string;
  firm_id?: string | null;
  scope_template_id: string;
  duration_mode: string;
  duration_hours?: number | null;
  reason?: string | null;
  expires_at?: string | null;
  target_display_name?: string | null;
  target_email?: string | null;
  target_phone?: string | null;
  accepted_by_user_id?: string | null;
  accepted_request_id?: string | null;
  ria: MarketplaceRia;
}

interface FetchOptions {
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  idToken?: string;
}

interface ErrorPayload {
  detail?: string;
  error?: string;
  code?: string;
  hint?: string;
}

export class RiaApiError extends Error {
  status: number;
  code?: string;
  hint?: string;

  constructor(message: string, status: number, code?: string, hint?: string) {
    super(message);
    this.name = "RiaApiError";
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

function normalizeMarketplaceRia(payload: MarketplaceRia): MarketplaceRia {
  const firms = Array.isArray(payload?.firms)
    ? payload.firms.filter(
        (
          firm
        ): firm is NonNullable<MarketplaceRia["firms"]>[number] =>
          Boolean(firm) && typeof firm === "object"
      )
    : [];

  return {
    ...payload,
    firms,
  };
}

export function isIAMSchemaNotReadyError(error: unknown): error is RiaApiError {
  return error instanceof RiaApiError && error.code === "IAM_SCHEMA_NOT_READY";
}

async function toJsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & ErrorPayload;
  if (!response.ok) {
    const message =
      (typeof payload.detail === "string" && payload.detail) ||
      (typeof payload.error === "string" && payload.error) ||
      `Request failed: ${response.status}`;
    const code = typeof payload.code === "string" ? payload.code : undefined;
    const hint = typeof payload.hint === "string" ? payload.hint : undefined;
    throw new RiaApiError(message, response.status, code, hint);
  }
  return payload;
}

async function authFetch(path: string, options: FetchOptions): Promise<Response> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  if (options.idToken) {
    headers.Authorization = `Bearer ${options.idToken}`;
  }

  return ApiService.apiFetch(path, {
    method: options.method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

export class RiaService {
  static async getPersonaState(idToken: string): Promise<PersonaState> {
    const response = await authFetch("/api/iam/persona", {
      method: "GET",
      idToken,
    });
    return toJsonOrThrow<PersonaState>(response);
  }

  static async switchPersona(idToken: string, persona: Persona): Promise<PersonaState> {
    const response = await authFetch("/api/iam/persona/switch", {
      method: "POST",
      idToken,
      body: { persona },
    });
    return toJsonOrThrow<PersonaState>(response);
  }

  static async setInvestorMarketplaceOptIn(
    idToken: string,
    enabled: boolean
  ): Promise<{ user_id: string; investor_marketplace_opt_in: boolean }> {
    const response = await authFetch("/api/iam/marketplace/opt-in", {
      method: "POST",
      idToken,
      body: { enabled },
    });
    return toJsonOrThrow<{ user_id: string; investor_marketplace_opt_in: boolean }>(response);
  }

  static async searchRias(params: {
    query?: string;
    limit?: number;
    firm?: string;
    verification_status?: string;
  }): Promise<MarketplaceRia[]> {
    const cache = CacheService.getInstance();
    const query = new URLSearchParams();
    if (params.query) query.set("query", params.query);
    if (params.firm) query.set("firm", params.firm);
    if (params.verification_status) {
      query.set("verification_status", params.verification_status);
    }
    if (typeof params.limit === "number") query.set("limit", String(params.limit));
    const queryKey = query.toString() || "all";
    const cached = cache.get<MarketplaceRia[]>(CACHE_KEYS.MARKETPLACE_RIAS_SEARCH(queryKey));
    if (cached) return cached;

    const response = await ApiService.apiFetch(`/api/marketplace/rias?${query.toString()}`, {
      method: "GET",
    });
    const payload = await toJsonOrThrow<{ items: MarketplaceRia[] }>(response);
    const normalized = payload.items.map(normalizeMarketplaceRia);
    cache.set(CACHE_KEYS.MARKETPLACE_RIAS_SEARCH(queryKey), normalized, CACHE_TTL.MEDIUM);
    return normalized;
  }

  static async searchInvestors(params: {
    query?: string;
    limit?: number;
  }): Promise<MarketplaceInvestor[]> {
    const cache = CacheService.getInstance();
    const query = new URLSearchParams();
    if (params.query) query.set("query", params.query);
    if (typeof params.limit === "number") query.set("limit", String(params.limit));
    const queryKey = query.toString() || "all";
    const cached = cache.get<MarketplaceInvestor[]>(CACHE_KEYS.MARKETPLACE_INVESTORS_SEARCH(queryKey));
    if (cached) return cached;

    const response = await ApiService.apiFetch(`/api/marketplace/investors?${query.toString()}`, {
      method: "GET",
    });
    const payload = await toJsonOrThrow<{ items: MarketplaceInvestor[] }>(response);
    cache.set(CACHE_KEYS.MARKETPLACE_INVESTORS_SEARCH(queryKey), payload.items, CACHE_TTL.MEDIUM);
    return payload.items;
  }

  static async getRiaPublicProfile(riaId: string): Promise<MarketplaceRia> {
    const response = await ApiService.apiFetch(`/api/marketplace/ria/${encodeURIComponent(riaId)}`, {
      method: "GET",
    });
    return normalizeMarketplaceRia(await toJsonOrThrow<MarketplaceRia>(response));
  }

  static async submitOnboarding(
    idToken: string,
    payload: {
      display_name: string;
      requested_capabilities: string[];
      individual_legal_name?: string;
      individual_crd?: string;
      advisory_firm_legal_name?: string;
      advisory_firm_iapd_number?: string;
      broker_firm_legal_name?: string;
      broker_firm_crd?: string;
      bio?: string;
      strategy?: string;
      disclosures_url?: string;
      primary_firm_role?: string;
    }
  ): Promise<{
    ria_profile_id: string;
    verification_status: string;
    advisory_status: string;
    brokerage_status: string;
    requested_capabilities: string[];
    verification_outcome: string;
    verification_message: string;
    brokerage_outcome: string;
    brokerage_message: string;
    professional_access_granted: boolean;
  }> {
    const response = await authFetch("/api/ria/onboarding/submit", {
      method: "POST",
      idToken,
      body: payload,
    });
    return toJsonOrThrow(response);
  }

  static async getOnboardingStatus(idToken: string): Promise<RiaOnboardingStatus> {
    const response = await authFetch("/api/ria/onboarding/status", {
      method: "GET",
      idToken,
    });
    return toJsonOrThrow<RiaOnboardingStatus>(response);
  }

  static async activateDevRia(
    idToken: string,
    payload: {
      display_name: string;
      requested_capabilities: string[];
      individual_legal_name?: string;
      individual_crd?: string;
      advisory_firm_legal_name?: string;
      advisory_firm_iapd_number?: string;
      broker_firm_legal_name?: string;
      broker_firm_crd?: string;
      bio?: string;
      strategy?: string;
      disclosures_url?: string;
      primary_firm_role?: string;
    }
  ): Promise<{
    ria_profile_id: string;
    verification_status: string;
    advisory_status: string;
    brokerage_status: string;
    requested_capabilities: string[];
    verification_outcome: string;
    verification_message: string;
    brokerage_outcome: string;
    brokerage_message: string;
    professional_access_granted: boolean;
  }> {
    const response = await authFetch("/api/ria/onboarding/dev-activate", {
      method: "POST",
      idToken,
      body: payload,
    });
    return toJsonOrThrow(response);
  }

  static async listFirms(idToken: string): Promise<RiaFirmMembership[]> {
    const response = await authFetch("/api/ria/firms", {
      method: "GET",
      idToken,
    });
    const payload = await toJsonOrThrow<{ items: RiaFirmMembership[] }>(response);
    return payload.items;
  }

  static async setRiaMarketplaceDiscoverability(
    idToken: string,
    payload: {
      enabled: boolean;
      headline?: string;
      strategy_summary?: string;
    }
  ): Promise<{ user_id: string; is_discoverable: boolean; verification_status: string }> {
    const response = await authFetch("/api/ria/marketplace/discoverability", {
      method: "POST",
      idToken,
      body: payload,
    });
    return toJsonOrThrow(response);
  }

  static async listClients(idToken: string): Promise<RiaClientAccess[]> {
    const response = await authFetch("/api/ria/clients", {
      method: "GET",
      idToken,
    });
    const payload = await toJsonOrThrow<{ items: RiaClientAccess[] }>(response);
    return payload.items;
  }

  static async getClientDetail(
    idToken: string,
    investorUserId: string
  ): Promise<RiaClientDetail> {
    const response = await authFetch(`/api/ria/clients/${encodeURIComponent(investorUserId)}`, {
      method: "GET",
      idToken,
    });
    return toJsonOrThrow<RiaClientDetail>(response);
  }

  static async listRequests(idToken: string): Promise<RiaRequestRecord[]> {
    const response = await authFetch("/api/ria/requests", {
      method: "GET",
      idToken,
    });
    const payload = await toJsonOrThrow<{ items: RiaRequestRecord[] }>(response);
    return payload.items;
  }

  static async listRequestBundles(idToken: string): Promise<RiaRequestBundleRecord[]> {
    const response = await authFetch("/api/ria/request-bundles", {
      method: "GET",
      idToken,
    });
    const payload = await toJsonOrThrow<{ items: RiaRequestBundleRecord[] }>(response);
    return payload.items;
  }

  static async listRequestScopes(idToken: string): Promise<RiaRequestScopeTemplate[]> {
    const response = await authFetch("/api/ria/request-scopes", {
      method: "GET",
      idToken,
    });
    const payload = await toJsonOrThrow<{ items: RiaRequestScopeTemplate[] }>(response);
    return payload.items;
  }

  static async listInvites(idToken: string): Promise<RiaInviteRecord[]> {
    const response = await authFetch("/api/ria/invites", {
      method: "GET",
      idToken,
    });
    const payload = await toJsonOrThrow<{ items: RiaInviteRecord[] }>(response);
    return payload.items;
  }

  static async createInvites(
    idToken: string,
    payload: {
      scope_template_id: string;
      duration_mode?: "preset" | "custom";
      duration_hours?: number;
      firm_id?: string;
      reason?: string;
      targets: Array<{
        display_name?: string;
        email?: string;
        phone?: string;
        investor_user_id?: string;
        source?: string;
        delivery_channel?: string;
      }>;
    }
  ): Promise<{ items: RiaInviteRecord[] }> {
    const response = await authFetch("/api/ria/invites", {
      method: "POST",
      idToken,
      body: payload,
    });
    return toJsonOrThrow(response);
  }

  static async createRequest(
    idToken: string,
    payload: {
      subject_user_id: string;
      scope_template_id: string;
      selected_scope?: string;
      duration_mode?: "preset" | "custom";
      duration_hours?: number;
      requester_actor_type?: "ria";
      subject_actor_type?: "investor";
      firm_id?: string;
      reason?: string;
    }
  ): Promise<{
    request_id: string;
    scope: string;
    status: string;
    expires_at: number;
  }> {
    const response = await authFetch("/api/ria/requests", {
      method: "POST",
      idToken,
      body: payload,
    });
    return toJsonOrThrow(response);
  }

  static async createRequestBundle(
    idToken: string,
    payload: {
      subject_user_id: string;
      scope_template_id: string;
      selected_scopes: string[];
      firm_id?: string;
      reason?: string;
    }
  ): Promise<{
    bundle_id: string;
    bundle_label: string;
    status: string;
    request_count: number;
    request_ids: string[];
    selected_scopes: string[];
    expires_at?: number | null;
  }> {
    const response = await authFetch("/api/ria/request-bundles", {
      method: "POST",
      idToken,
      body: payload,
    });
    return toJsonOrThrow(response);
  }

  static async getWorkspace(
    idToken: string,
    investorUserId: string
  ): Promise<{
    investor_user_id: string;
    investor_display_name?: string | null;
    investor_headline?: string | null;
    workspace_ready: boolean;
    available_domains: string[];
    domain_summaries: Record<string, unknown>;
    total_attributes: number;
    relationship_status: string;
    scope: string;
    granted_scopes?: Array<{
      scope: string;
      label: string;
      expires_at?: number | string | null;
      issued_at?: number | string | null;
    }>;
    consent_expires_at?: number | string | null;
    updated_at?: string;
  }> {
    const response = await authFetch(
      `/api/ria/workspace/${encodeURIComponent(investorUserId)}`,
      {
        method: "GET",
        idToken,
      }
    );
    return toJsonOrThrow(response);
  }

  static async listPicks(idToken: string): Promise<{
    items: RiaPickUploadRecord[];
    active_rows: RiaPickRow[];
  }> {
    const response = await authFetch("/api/ria/picks", {
      method: "GET",
      idToken,
    });
    return toJsonOrThrow(response);
  }

  static async uploadPicks(
    idToken: string,
    payload: {
      csv_content: string;
      source_filename?: string;
      label?: string;
    }
  ): Promise<RiaPickUploadRecord> {
    const response = await authFetch("/api/ria/picks", {
      method: "POST",
      idToken,
      body: payload,
    });
    return toJsonOrThrow(response);
  }

  static async resolveInvite(inviteToken: string): Promise<RiaInviteResolution> {
    const response = await ApiService.apiFetch(`/api/invites/${encodeURIComponent(inviteToken)}`, {
      method: "GET",
    });
    const payload = await toJsonOrThrow<RiaInviteResolution>(response);
    return {
      ...payload,
      ria: normalizeMarketplaceRia(payload.ria),
    };
  }

  static async acceptInvite(
    idToken: string,
    inviteToken: string
  ): Promise<{
    invite_token: string;
    request_id?: string;
    status: string;
    scope?: string;
    expires_at?: number;
    ria: MarketplaceRia;
  }> {
    const response = await authFetch(`/api/invites/${encodeURIComponent(inviteToken)}/accept`, {
      method: "POST",
      idToken,
    });
    const payload = await toJsonOrThrow<{
      invite_token: string;
      request_id?: string;
      status: string;
      scope?: string;
      expires_at?: number;
      ria: MarketplaceRia;
    }>(response);
    return {
      ...payload,
      ria: normalizeMarketplaceRia(payload.ria),
    };
  }
}
