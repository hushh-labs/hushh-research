import { ApiService } from "@/lib/services/api-service";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import { DeviceResourceCacheService } from "@/lib/services/device-resource-cache-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

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
  is_test_profile?: boolean;
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
  is_test_profile?: boolean;
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
  investor_email?: string | null;
  investor_secondary_label?: string | null;
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
  relationship_shares?: Array<{
    grant_key: string;
    label: string;
    description: string;
    status: string;
    share_origin?: string | null;
    granted_at?: string | null;
    revoked_at?: string | null;
    has_active_pick_upload?: boolean;
  }>;
  picks_feed_status?: string | null;
  picks_feed_granted_at?: string | null;
  has_active_pick_upload?: boolean;
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
  investor_email?: string | null;
  investor_secondary_label?: string | null;
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
  relationship_shares?: Array<{
    grant_key: string;
    label: string;
    description: string;
    status: string;
    share_origin?: string | null;
    granted_at?: string | null;
    revoked_at?: string | null;
    has_active_pick_upload?: boolean;
  }>;
  picks_feed_status?: string | null;
  picks_feed_granted_at?: string | null;
  has_active_pick_upload?: boolean;
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

export interface RiaClientListResponse {
  items: RiaClientAccess[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
}

export interface RiaHomeResponse {
  onboarding: RiaOnboardingStatus;
  verification_status: string;
  primary_action: {
    label: string;
    href: string;
    description: string;
  };
  counts: {
    active_clients: number;
    needs_attention: number;
    invites: number;
  };
  needs_attention: Array<{
    id: string;
    title: string;
    subtitle?: string | null;
    status: string;
    next_action?: string | null;
    href: string;
  }>;
  active_picks: {
    status: string;
    active_rows: number;
  };
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

export interface RiaPickPackageRecord {
  upload_id: string;
  label: string;
  status: string;
  source_filename?: string | null;
  row_count: number;
  package_note?: string | null;
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

export interface RiaAvoidRow {
  ticker: string;
  company_name?: string | null;
  sector?: string | null;
  category?: string | null;
  why_avoid?: string | null;
  note?: string | null;
}

export interface RiaScreeningRow {
  section?: string | null;
  rule_index?: number | null;
  title: string;
  detail: string;
  value_text?: string | null;
}

export interface RiaScreeningSection {
  section: string;
  rows: RiaScreeningRow[];
}

export interface RiaPickPackage {
  top_picks: RiaPickRow[];
  avoid_rows: RiaAvoidRow[];
  screening_sections: RiaScreeningSection[];
  package_note?: string | null;
}

export interface RiaPicksRevisionMetadata {
  has_package: boolean;
  storage_source: "pkm" | "legacy" | "empty";
  package_revision: number;
  top_pick_count: number;
  avoid_count: number;
  screening_row_count: number;
  last_updated?: string | null;
  active_share_count: number;
  path?: string | null;
}

export interface RiaPicksResponse {
  package: RiaPickPackage;
  metadata?: RiaPicksRevisionMetadata;
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

interface CachedReadOptions {
  userId?: string;
  force?: boolean;
}

interface ErrorPayload {
  detail?: string;
  error?: string;
  code?: string;
  hint?: string;
}

const RIA_PICKS_DOMAIN = "ria";
const RIA_PICKS_PATH = "advisor_package";
const RIA_PICKS_DOMAIN_SCHEMA_VERSION = 1;

function emptyRiaPickPackage(): RiaPickPackage {
  return {
    top_picks: [],
    avoid_rows: [],
    screening_sections: [
      { section: "investable_requirements", rows: [] },
      { section: "automatic_avoid_triggers", rows: [] },
      { section: "the_math", rows: [] },
    ],
    package_note: null,
  };
}

function countScreeningRows(sections: RiaScreeningSection[] | null | undefined): number {
  if (!Array.isArray(sections)) return 0;
  return sections.reduce((total, section) => {
    if (!section || !Array.isArray(section.rows)) return total;
    return total + section.rows.length;
  }, 0);
}

function normalizePickPackage(input: Partial<RiaPickPackage> | null | undefined): RiaPickPackage {
  const empty = emptyRiaPickPackage();
  const packageValue = input && typeof input === "object" ? input : {};
  const screeningSections = Array.isArray(packageValue.screening_sections)
    ? packageValue.screening_sections
        .filter((section): section is RiaScreeningSection => Boolean(section) && typeof section === "object")
        .map((section) => ({
          section: String(section.section || "").trim(),
          rows: Array.isArray(section.rows)
            ? section.rows
                .filter((row): row is RiaScreeningRow => Boolean(row) && typeof row === "object")
                .map((row) => ({
                  section: String(row.section || section.section || "").trim() || undefined,
                  rule_index:
                    typeof row.rule_index === "number" && Number.isFinite(row.rule_index)
                      ? row.rule_index
                      : undefined,
                  title: String(row.title || "").trim(),
                  detail: String(row.detail || "").trim(),
                  value_text: String(row.value_text || "").trim() || null,
                }))
            : [],
        }))
    : empty.screening_sections;

  return {
    top_picks: Array.isArray(packageValue.top_picks)
      ? packageValue.top_picks
          .filter((row): row is RiaPickRow => Boolean(row) && typeof row === "object")
          .map((row) => ({
            ticker: String(row.ticker || "").trim().toUpperCase(),
            company_name: String(row.company_name || "").trim() || null,
            sector: String(row.sector || "").trim() || null,
            tier: String(row.tier || "").trim().toUpperCase() || null,
            tier_rank:
              typeof row.tier_rank === "number" && Number.isFinite(row.tier_rank)
                ? row.tier_rank
                : null,
            conviction_weight:
              typeof row.conviction_weight === "number" && Number.isFinite(row.conviction_weight)
                ? row.conviction_weight
                : null,
            recommendation_bias: String(row.recommendation_bias || "").trim() || null,
            investment_thesis: String(row.investment_thesis || "").trim() || null,
            fcf_billions:
              typeof row.fcf_billions === "number" && Number.isFinite(row.fcf_billions)
                ? row.fcf_billions
                : null,
          }))
      : [],
    avoid_rows: Array.isArray(packageValue.avoid_rows)
      ? packageValue.avoid_rows
          .filter((row): row is RiaAvoidRow => Boolean(row) && typeof row === "object")
          .map((row) => ({
            ticker: String(row.ticker || "").trim().toUpperCase(),
            company_name: String(row.company_name || "").trim() || null,
            sector: String(row.sector || "").trim() || null,
            category: String(row.category || "").trim() || null,
            why_avoid: String(row.why_avoid || "").trim() || null,
            note: String(row.note || "").trim() || null,
          }))
      : [],
    screening_sections:
      screeningSections.length > 0 ? screeningSections : empty.screening_sections,
    package_note: String(packageValue.package_note || "").trim() || null,
  };
}

function buildRiaPickSummary(
  pkg: RiaPickPackage,
  metadata?: Partial<RiaPicksRevisionMetadata> | null
): RiaPicksRevisionMetadata {
  return {
    has_package:
      metadata?.has_package ??
      Boolean(pkg.top_picks.length || pkg.avoid_rows.length || countScreeningRows(pkg.screening_sections)),
    storage_source: metadata?.storage_source || "pkm",
    package_revision: Number(metadata?.package_revision || 0),
    top_pick_count:
      typeof metadata?.top_pick_count === "number" ? metadata.top_pick_count : pkg.top_picks.length,
    avoid_count:
      typeof metadata?.avoid_count === "number" ? metadata.avoid_count : pkg.avoid_rows.length,
    screening_row_count:
      typeof metadata?.screening_row_count === "number"
        ? metadata.screening_row_count
        : countScreeningRows(pkg.screening_sections),
    last_updated: metadata?.last_updated || null,
    active_share_count: Number(metadata?.active_share_count || 0),
    path: metadata?.path || RIA_PICKS_PATH,
  };
}

function parseRiaPicksDomain(domainData: Record<string, unknown> | null | undefined): {
  package: RiaPickPackage;
  revision: number;
  updatedAt: string | null;
} | null {
  if (!domainData || typeof domainData !== "object" || Array.isArray(domainData)) {
    return null;
  }
  const raw = domainData[RIA_PICKS_PATH];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const payload = raw as Record<string, unknown>;
  const packageValue = normalizePickPackage({
    top_picks: Array.isArray(payload.top_picks) ? (payload.top_picks as RiaPickRow[]) : [],
    avoid_rows: Array.isArray(payload.avoid_rows) ? (payload.avoid_rows as RiaAvoidRow[]) : [],
    screening_sections: Array.isArray(payload.screening_sections)
      ? (payload.screening_sections as RiaScreeningSection[])
      : [],
    package_note: typeof payload.package_note === "string" ? payload.package_note : null,
  });
  return {
    package: packageValue,
    revision: Number(payload.revision || 0),
    updatedAt: typeof payload.updated_at === "string" ? payload.updated_at : null,
  };
}

function buildRiaPicksDomainData(params: {
  pkg: RiaPickPackage;
  revision: number;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    schema_version: RIA_PICKS_DOMAIN_SCHEMA_VERSION,
    domain_intent: {
      primary: RIA_PICKS_DOMAIN,
      secondary: RIA_PICKS_PATH,
      source: "ria_picks_editor",
      contract_version: 1,
      updated_at: params.updatedAt,
    },
    [RIA_PICKS_PATH]: {
      ...normalizePickPackage(params.pkg),
      revision: params.revision,
      updated_at: params.updatedAt,
    },
    updated_at: params.updatedAt,
  };
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
  let rawFirms = payload?.firms;
  // Backend may return firms as a JSON string — parse it
  if (typeof rawFirms === "string") {
    try {
      rawFirms = JSON.parse(rawFirms);
    } catch {
      rawFirms = [];
    }
  }
  const firms = Array.isArray(rawFirms)
    ? rawFirms.filter(
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
    const detailMessage = (() => {
      if (typeof payload.detail === "string" && payload.detail) {
        return payload.detail;
      }
      if (Array.isArray(payload.detail)) {
        const messages = payload.detail
          .map((item) => {
            if (typeof item === "string") return item.trim();
            if (item && typeof item === "object") {
              const message =
                typeof (item as { msg?: unknown }).msg === "string"
                  ? (item as { msg: string }).msg
                  : null;
              const loc = Array.isArray((item as { loc?: unknown }).loc)
                ? (item as { loc: unknown[] }).loc.join(" > ")
                : null;
              if (message && loc) return `${loc}: ${message}`;
              return message;
            }
            return null;
          })
          .filter((message): message is string => Boolean(message && message.trim()));
        return messages[0] || null;
      }
      return null;
    })();
    const message =
      detailMessage ||
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
  private static inflight = new Map<string, Promise<unknown>>();
  private static readonly DEVICE_TTL_MS = CACHE_TTL.MEDIUM;

  private static logRequest(stage: string, detail: Record<string, unknown>): void {
    console.info(`[RequestAudit:ria_resource] ${stage}`, detail);
  }

  private static readCached<T>(key: string, force?: boolean): T | null {
    if (force) return null;
    return CacheService.getInstance().get<T>(key);
  }

  private static writeCached<T>(key: string, value: T, ttl: number = CACHE_TTL.SHORT): T {
    CacheService.getInstance().set(key, value, ttl);
    return value;
  }

  private static async runDeduped<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const inflight = this.inflight.get(key) as Promise<T> | undefined;
    if (inflight) {
      return inflight;
    }

    const request = factory().finally(() => {
      if (this.inflight.get(key) === request) {
        this.inflight.delete(key);
      }
    });
    this.inflight.set(key, request);
    return request;
  }

  private static async refreshCachedResource<T>(params: {
    cacheKey: string | null;
    userId?: string;
    deviceResourceKey?: string;
    ttl?: number;
    inflightKey: string;
    resourceLabel: string;
    loader: () => Promise<T>;
  }): Promise<T> {
    const payload = await this.runDeduped(params.inflightKey, async () => {
      this.logRequest("network_fetch", {
        label: params.resourceLabel,
        cacheKey: params.cacheKey,
        resourceKey: params.deviceResourceKey || null,
        userId: params.userId || null,
      });
      return await params.loader();
    });
    if (params.cacheKey) {
      this.writeCached(params.cacheKey, payload, params.ttl);
    }
    if (params.userId && params.deviceResourceKey) {
      await DeviceResourceCacheService.write({
        userId: params.userId,
        resourceKey: params.deviceResourceKey,
        value: payload,
        ttlMs: params.ttl ?? this.DEVICE_TTL_MS,
      });
    }
    return payload;
  }

  private static async readCachedOrFetch<T>(params: {
    cacheKey: string | null;
    userId?: string;
    deviceResourceKey?: string;
    force?: boolean;
    ttl?: number;
    inflightKey: string;
    resourceLabel: string;
    loader: () => Promise<T>;
  }): Promise<T> {
    if (params.cacheKey) {
      const snapshot = params.force ? null : CacheService.getInstance().peek<T>(params.cacheKey);
      if (snapshot?.isFresh) {
        this.logRequest("cache_hit", {
          label: params.resourceLabel,
          tier: "memory",
          cacheKey: params.cacheKey,
          userId: params.userId || null,
        });
        return snapshot.data;
      }
    }

    if (!params.force && params.userId && params.deviceResourceKey) {
      const stored = await DeviceResourceCacheService.read<T>({
        userId: params.userId,
        resourceKey: params.deviceResourceKey,
      });
      if (stored) {
        if (params.cacheKey) {
          CacheService.getInstance().set(
            params.cacheKey,
            stored,
            params.ttl ?? CACHE_TTL.SHORT
          );
        }
        this.logRequest("device_hit", {
          label: params.resourceLabel,
          cacheKey: params.cacheKey,
          resourceKey: params.deviceResourceKey,
          userId: params.userId,
        });
        void this.refreshCachedResource(params).catch(() => undefined);
        return stored;
      }
    }

    this.logRequest("cache_miss", {
      label: params.resourceLabel,
      cacheKey: params.cacheKey,
      resourceKey: params.deviceResourceKey || null,
      userId: params.userId || null,
    });

    return await this.refreshCachedResource(params);
  }

  static async getPersonaState(
    idToken: string,
    options?: CachedReadOptions
  ): Promise<PersonaState> {
    const cacheKey = options?.userId ? CACHE_KEYS.PERSONA_STATE(options.userId) : null;
    return this.readCachedOrFetch({
      cacheKey,
      userId: options?.userId,
      deviceResourceKey: options?.userId ? `ria:persona_state:${options.userId}` : undefined,
      force: options?.force,
      ttl: CACHE_TTL.SESSION,
      inflightKey: cacheKey || "ria_persona_state",
      resourceLabel: "persona_state",
      loader: async () => {
        const response = await authFetch("/api/iam/persona", {
          method: "GET",
          idToken,
        });
        return toJsonOrThrow<PersonaState>(response);
      },
    });
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
      force_live_verification?: boolean;
    }
  ): Promise<{
    ria_profile_id: string;
    verification_status: string;
    verification_provider?: string;
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

  static async getOnboardingStatus(
    idToken: string,
    options?: CachedReadOptions
  ): Promise<RiaOnboardingStatus> {
    const cacheKey = options?.userId ? CACHE_KEYS.RIA_ONBOARDING_STATUS(options.userId) : null;
    return this.readCachedOrFetch({
      cacheKey,
      userId: options?.userId,
      deviceResourceKey: options?.userId
        ? `ria:onboarding_status:${options.userId}`
        : undefined,
      force: options?.force,
      ttl: CACHE_TTL.SHORT,
      inflightKey: cacheKey || "ria_onboarding_status",
      resourceLabel: "onboarding_status",
      loader: async () => {
        const response = await authFetch("/api/ria/onboarding/status", {
          method: "GET",
          idToken,
        });
        return toJsonOrThrow<RiaOnboardingStatus>(response);
      },
    });
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
    verification_provider?: string;
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

  static async getHome(
    idToken: string,
    options: CachedReadOptions & { userId: string }
  ): Promise<RiaHomeResponse> {
    const cacheKey = CACHE_KEYS.RIA_HOME(options.userId);
    return this.readCachedOrFetch({
      cacheKey,
      userId: options.userId,
      deviceResourceKey: `ria:home:${options.userId}`,
      force: options.force,
      ttl: CACHE_TTL.SHORT,
      inflightKey: cacheKey,
      resourceLabel: "ria_home",
      loader: async () => {
        const response = await authFetch("/api/ria/home", {
          method: "GET",
          idToken,
        });
        return toJsonOrThrow<RiaHomeResponse>(response);
      },
    });
  }

  static async listClients(
    idToken: string,
    options?: CachedReadOptions & {
      q?: string;
      status?: string;
      page?: number;
      limit?: number;
    }
  ): Promise<RiaClientListResponse> {
    const query = new URLSearchParams();
    if (options?.q) query.set("q", options.q);
    if (options?.status) query.set("status", options.status);
    query.set("page", String(options?.page || 1));
    query.set("limit", String(options?.limit || 50));
    const queryKey = `${options?.q || ""}_${options?.status || ""}_${options?.page || 1}_${options?.limit || 50}`;
    const cacheKey = options?.userId
      ? CACHE_KEYS.RIA_CLIENTS(
          options.userId,
          options.q || "",
          options.status || "",
          options?.page || 1,
          options?.limit || 50
        )
      : null;
    return this.readCachedOrFetch({
      cacheKey,
      userId: options?.userId,
      deviceResourceKey: options?.userId
        ? `ria:clients:${options.userId}:${queryKey}`
        : undefined,
      force: options?.force,
      ttl: CACHE_TTL.SHORT,
      inflightKey: cacheKey || `ria_clients_${queryKey}`,
      resourceLabel: "ria_clients",
      loader: async () => {
        const response = await authFetch(`/api/ria/clients?${query.toString()}`, {
          method: "GET",
          idToken,
        });
        return toJsonOrThrow<RiaClientListResponse>(response);
      },
    });
  }

  static async getClientDetail(
    idToken: string,
    investorUserId: string,
    options?: CachedReadOptions
  ): Promise<RiaClientDetail> {
    const cacheKey =
      options?.userId ? CACHE_KEYS.RIA_CLIENT_DETAIL(options.userId, investorUserId) : null;
    return this.readCachedOrFetch({
      cacheKey,
      userId: options?.userId,
      deviceResourceKey: options?.userId
        ? `ria:client_detail:${options.userId}:${investorUserId}`
        : undefined,
      force: options?.force,
      ttl: CACHE_TTL.SHORT,
      inflightKey: cacheKey || `ria_client_detail_${investorUserId}`,
      resourceLabel: "ria_client_detail",
      loader: async () => {
        const response = await authFetch(`/api/ria/clients/${encodeURIComponent(investorUserId)}`, {
          method: "GET",
          idToken,
        });
        return toJsonOrThrow<RiaClientDetail>(response);
      },
    });
  }

  static async listRequests(idToken: string): Promise<RiaRequestRecord[]> {
    const response = await authFetch("/api/ria/requests", {
      method: "GET",
      idToken,
    });
    const payload = await toJsonOrThrow<{ items: RiaRequestRecord[] }>(response);
    return payload.items;
  }

  static async listRequestBundles(
    idToken: string,
    options?: CachedReadOptions
  ): Promise<RiaRequestBundleRecord[]> {
    const cacheKey = options?.userId ? `ria_request_bundles_${options.userId}` : null;
    return this.readCachedOrFetch({
      cacheKey,
      userId: options?.userId,
      deviceResourceKey: options?.userId
        ? `ria:request_bundles:${options.userId}`
        : undefined,
      force: options?.force,
      ttl: CACHE_TTL.SHORT,
      inflightKey: cacheKey || "ria_request_bundles",
      resourceLabel: "ria_request_bundles",
      loader: async () => {
        const response = await authFetch("/api/ria/request-bundles", {
          method: "GET",
          idToken,
        });
        const payload = await toJsonOrThrow<{ items: RiaRequestBundleRecord[] }>(response);
        return payload.items;
      },
    });
  }

  static async listRequestScopes(idToken: string): Promise<RiaRequestScopeTemplate[]> {
    const response = await authFetch("/api/ria/request-scopes", {
      method: "GET",
      idToken,
    });
    const payload = await toJsonOrThrow<{ items: RiaRequestScopeTemplate[] }>(response);
    return payload.items;
  }

  static async listInvites(idToken: string, options?: CachedReadOptions): Promise<RiaInviteRecord[]> {
    const cacheKey = options?.userId ? `ria_invites_${options.userId}` : null;
    return this.readCachedOrFetch({
      cacheKey,
      userId: options?.userId,
      deviceResourceKey: options?.userId ? `ria:invites:${options.userId}` : undefined,
      force: options?.force,
      ttl: CACHE_TTL.SHORT,
      inflightKey: cacheKey || "ria_invites",
      resourceLabel: "ria_invites",
      loader: async () => {
        const response = await authFetch("/api/ria/invites", {
          method: "GET",
          idToken,
        });
        const payload = await toJsonOrThrow<{ items: RiaInviteRecord[] }>(response);
        return payload.items;
      },
    });
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
    investorUserId: string,
    options?: CachedReadOptions
  ): Promise<{
    investor_user_id: string;
    investor_display_name?: string | null;
    investor_email?: string | null;
    investor_secondary_label?: string | null;
    investor_headline?: string | null;
    workspace_ready: boolean;
    available_domains: string[];
    domain_summaries: Record<string, unknown>;
    total_attributes: number;
    relationship_status: string;
    scope: string;
    relationship_shares?: Array<{
      grant_key: string;
      label: string;
      description: string;
      status: string;
      share_origin?: string | null;
      granted_at?: string | null;
      revoked_at?: string | null;
      has_active_pick_upload?: boolean;
    }>;
    picks_feed_status?: string | null;
    picks_feed_granted_at?: string | null;
    has_active_pick_upload?: boolean;
    granted_scopes?: Array<{
      scope: string;
      label: string;
      expires_at?: number | string | null;
      issued_at?: number | string | null;
    }>;
      consent_expires_at?: number | string | null;
      updated_at?: string;
    }> {
    const cacheKey =
      options?.userId ? CACHE_KEYS.RIA_WORKSPACE(options.userId, investorUserId) : null;
    if (cacheKey) {
      const cached = this.readCached<{
        investor_user_id: string;
        investor_display_name?: string | null;
        investor_email?: string | null;
        investor_secondary_label?: string | null;
        investor_headline?: string | null;
        workspace_ready: boolean;
        available_domains: string[];
        domain_summaries: Record<string, unknown>;
        total_attributes: number;
        relationship_status: string;
        scope: string;
        relationship_shares?: Array<{
          grant_key: string;
          label: string;
          description: string;
          status: string;
          share_origin?: string | null;
          granted_at?: string | null;
          revoked_at?: string | null;
          has_active_pick_upload?: boolean;
        }>;
        picks_feed_status?: string | null;
        picks_feed_granted_at?: string | null;
        has_active_pick_upload?: boolean;
        granted_scopes?: Array<{
          scope: string;
          label: string;
          expires_at?: number | string | null;
          issued_at?: number | string | null;
        }>;
        consent_expires_at?: number | string | null;
        updated_at?: string;
      }>(cacheKey, options?.force);
      if (cached) return cached;
    }
    const response = await authFetch(
      `/api/ria/workspace/${encodeURIComponent(investorUserId)}`,
      {
        method: "GET",
        idToken,
      }
    );
    const payload = await toJsonOrThrow<{
      investor_user_id: string;
      investor_display_name?: string | null;
      investor_email?: string | null;
      investor_secondary_label?: string | null;
      investor_headline?: string | null;
      workspace_ready: boolean;
      available_domains: string[];
      domain_summaries: Record<string, unknown>;
      total_attributes: number;
      relationship_status: string;
      scope: string;
      relationship_shares?: Array<{
        grant_key: string;
        label: string;
        description: string;
        status: string;
        share_origin?: string | null;
        granted_at?: string | null;
        revoked_at?: string | null;
        has_active_pick_upload?: boolean;
      }>;
      picks_feed_status?: string | null;
      picks_feed_granted_at?: string | null;
      has_active_pick_upload?: boolean;
      granted_scopes?: Array<{
        scope: string;
        label: string;
        expires_at?: number | string | null;
        issued_at?: number | string | null;
      }>;
      consent_expires_at?: number | string | null;
      updated_at?: string;
    }>(response);
    return cacheKey ? this.writeCached(cacheKey, payload, CACHE_TTL.SHORT) : payload;
  }

  static async listPicks(params: {
    idToken: string;
    userId: string;
    vaultKey?: string | null;
    vaultOwnerToken?: string | null;
    force?: boolean;
  }): Promise<RiaPicksResponse> {
    const cacheKey = CACHE_KEYS.RIA_PICKS(params.userId);
    const cached = this.readCached<RiaPicksResponse>(cacheKey, params.force);
    if (cached) return cached;

    const bootstrapResponse = await authFetch("/api/ria/picks", {
      method: "GET",
      idToken: params.idToken,
    });
    const bootstrap = await toJsonOrThrow<RiaPicksResponse>(bootstrapResponse);
    const bootstrapPackage = normalizePickPackage(bootstrap.package);
    const bootstrapMetadata = buildRiaPickSummary(bootstrapPackage, bootstrap.metadata);

    if (!params.vaultKey || !params.vaultOwnerToken) {
      const lockedPayload: RiaPicksResponse = {
        package:
          bootstrapMetadata.storage_source === "legacy"
            ? bootstrapPackage
            : emptyRiaPickPackage(),
        metadata: bootstrapMetadata,
      };
      return this.writeCached(cacheKey, lockedPayload, CACHE_TTL.SHORT);
    }

    try {
      const domainData = await PersonalKnowledgeModelService.loadDomainData({
        userId: params.userId,
        domain: RIA_PICKS_DOMAIN,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
      });
      const parsed = parseRiaPicksDomain(
        domainData && typeof domainData === "object" && !Array.isArray(domainData)
          ? (domainData as Record<string, unknown>)
          : null
      );
      if (parsed) {
        const payload: RiaPicksResponse = {
          package: parsed.package,
          metadata: buildRiaPickSummary(parsed.package, {
            ...bootstrapMetadata,
            storage_source: "pkm",
            package_revision: parsed.revision,
            last_updated: parsed.updatedAt || bootstrapMetadata.last_updated,
          }),
        };
        return this.writeCached(cacheKey, payload, CACHE_TTL.SHORT);
      }
    } catch {
      // Fall through to bootstrap/legacy seed.
    }

    return this.writeCached(
      cacheKey,
      {
        package: bootstrapPackage,
        metadata: bootstrapMetadata,
      },
      CACHE_TTL.SHORT
    );
  }

  static async savePickPackage(params: {
    idToken: string;
    userId: string;
    vaultKey?: string | null;
    vaultOwnerToken?: string | null;
    label?: string;
    package_note?: string;
    top_picks?: RiaPickRow[];
    avoid_rows?: RiaAvoidRow[];
    screening_sections?: RiaScreeningSection[];
  }): Promise<RiaPicksResponse> {
    if (!params.vaultKey || !params.vaultOwnerToken) {
      throw new Error("Unlock the vault before saving advisor picks.");
    }

    const nextPackage = normalizePickPackage({
      top_picks: params.top_picks || [],
      avoid_rows: params.avoid_rows || [],
      screening_sections: params.screening_sections || [],
      package_note: params.package_note || null,
    });
    const nextUpdatedAt = new Date().toISOString();
    const currentDomain = await PersonalKnowledgeModelService.loadDomainData({
      userId: params.userId,
      domain: RIA_PICKS_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch(() => null);
    const currentParsed = parseRiaPicksDomain(
      currentDomain && typeof currentDomain === "object" && !Array.isArray(currentDomain)
        ? (currentDomain as Record<string, unknown>)
        : null
    );
    const nextRevision = Math.max(1, Number(currentParsed?.revision || 0) + 1);
    const result = await PkmWriteCoordinator.saveMergedDomain({
      userId: params.userId,
      domain: RIA_PICKS_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      build: () => ({
        domainData: buildRiaPicksDomainData({
          pkg: nextPackage,
          revision: nextRevision,
          updatedAt: nextUpdatedAt,
        }),
        summary: {
          domain_contract_version: 1,
          package_revision: nextRevision,
          top_pick_count: nextPackage.top_picks.length,
          avoid_count: nextPackage.avoid_rows.length,
          screening_row_count: countScreeningRows(nextPackage.screening_sections),
          last_updated: nextUpdatedAt,
        },
      }),
    });
    if (!result.success) {
      throw new Error(result.message || "Failed to store RIA picks package.");
    }

    const shareSyncResponse = await authFetch("/api/ria/picks", {
      method: "POST",
      idToken: params.idToken,
      body: {
        label: params.label,
        package_note: nextPackage.package_note || undefined,
        top_picks: nextPackage.top_picks,
        avoid_rows: nextPackage.avoid_rows,
        screening_sections: nextPackage.screening_sections,
        source_data_version: result.dataVersion,
        source_manifest_revision: undefined,
        retire_legacy: true,
      },
    });
    const synced = await toJsonOrThrow<RiaPicksResponse>(shareSyncResponse);
    const payload: RiaPicksResponse = {
      package: nextPackage,
      metadata: buildRiaPickSummary(nextPackage, {
        ...(synced.metadata || {}),
        storage_source: "pkm",
        package_revision: result.dataVersion || nextRevision,
        last_updated: result.updatedAt || nextUpdatedAt,
      }),
    };
    return this.writeCached(CACHE_KEYS.RIA_PICKS(params.userId), payload, CACHE_TTL.SHORT);
  }

  static async importPickCsv(params: {
    idToken: string;
    userId: string;
    vaultKey?: string | null;
    vaultOwnerToken?: string | null;
    csv_content: string;
    source_filename?: string;
    label?: string;
    package_note?: string;
    avoid_rows?: RiaAvoidRow[];
    screening_sections?: RiaScreeningSection[];
  }): Promise<RiaPicksResponse> {
    if (!params.csv_content.trim()) {
      throw new Error("csv_content is required");
    }

    const parsedResponse = await authFetch("/api/ria/picks/parse", {
      method: "POST",
      idToken: params.idToken,
      body: {
        csv_content: params.csv_content,
        source_filename: params.source_filename,
        package_note: params.package_note || undefined,
        avoid_rows: params.avoid_rows || [],
        screening_sections: params.screening_sections || [],
      },
    });
    const parsed = await toJsonOrThrow<RiaPicksResponse>(parsedResponse);
    const parsedPackage = normalizePickPackage(parsed.package);
    return this.savePickPackage({
      idToken: params.idToken,
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      label: params.label,
      package_note: parsedPackage.package_note || params.package_note,
      top_picks: parsedPackage.top_picks,
      avoid_rows: parsedPackage.avoid_rows,
      screening_sections: parsedPackage.screening_sections,
    });
  }

  static async uploadPicks(params: {
    idToken: string;
    userId: string;
    vaultKey?: string | null;
    vaultOwnerToken?: string | null;
    csv_content?: string;
    source_filename?: string;
    label?: string;
    package_note?: string;
    top_picks?: RiaPickRow[];
    avoid_rows?: RiaAvoidRow[];
    screening_sections?: RiaScreeningSection[];
  }): Promise<RiaPicksResponse> {
    if (params.csv_content && params.csv_content.trim()) {
      return this.importPickCsv({
        idToken: params.idToken,
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        csv_content: params.csv_content,
        source_filename: params.source_filename,
        label: params.label,
        package_note: params.package_note,
        avoid_rows: params.avoid_rows,
        screening_sections: params.screening_sections,
      });
    }
    return this.savePickPackage({
      idToken: params.idToken,
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      label: params.label,
      package_note: params.package_note,
      top_picks: params.top_picks,
      avoid_rows: params.avoid_rows,
      screening_sections: params.screening_sections,
    });
  }

  static async getRenaissanceUniverse(
    idToken: string,
    tier?: string
  ): Promise<{ items: RiaPickRow[]; total: number }> {
    const params = tier ? `?tier=${encodeURIComponent(tier)}` : "";
    const response = await authFetch(`/api/ria/universe${params}`, {
      method: "GET",
      idToken,
    });
    return toJsonOrThrow(response);
  }

  static async getRenaissanceAvoid(
    idToken: string
  ): Promise<{ items: Array<{ ticker: string; company_name?: string; sector?: string; category?: string; why_avoid?: string }> }> {
    const response = await authFetch("/api/ria/universe/avoid", {
      method: "GET",
      idToken,
    });
    return toJsonOrThrow(response);
  }

  static async getRenaissanceScreening(
    idToken: string
  ): Promise<{ items: Array<{ section: string; rule_index: number; title: string; detail: string; value_text?: string }> }> {
    const response = await authFetch("/api/ria/universe/screening", {
      method: "GET",
      idToken,
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
