import type { ObservabilityEnvironment } from "@/lib/observability/env";
import type { RouteId } from "@/lib/observability/route-map";

export type ObservabilityPlatform = "web" | "ios" | "android";
export type ObservabilityEventCategory = "funnel" | "feature" | "system";
export type GrowthJourney = "investor" | "ria";
export type GrowthEntrySurface =
  | "login"
  | "kai_home"
  | "kai_onboarding"
  | "kai_import"
  | "marketplace"
  | "ria_home"
  | "ria_onboarding"
  | "unknown";
export type GrowthPortfolioSource = "statement" | "plaid";
export type GrowthWorkspaceSource =
  | "ria_home"
  | "ria_client_workspace"
  | "developer_activation"
  | "unknown";
export type GrowthInvestorStep =
  | "entered"
  | "auth_completed"
  | "vault_ready"
  | "onboarding_completed"
  | "portfolio_ready";
export type GrowthRiaStep =
  | "entered"
  | "auth_completed"
  | "profile_submitted"
  | "request_created"
  | "workspace_ready";

export type ObservabilityEventName =
  | "page_view"
  | "auth_started"
  | "auth_succeeded"
  | "auth_failed"
  | "onboarding_started"
  | "onboarding_step_completed"
  | "onboarding_completed"
  | "import_upload_started"
  | "import_parse_completed"
  | "import_quality_gate_passed"
  | "import_quality_gate_failed"
  | "import_save_completed"
  | "market_insights_loaded"
  | "portfolio_viewed"
  | "recommendation_viewed"
  | "profile_picks_loaded"
  | "analysis_stream_started"
  | "analysis_stream_terminal_decision"
  | "analysis_stream_aborted"
  | "analysis_stream_error"
  | "consent_pending_loaded"
  | "consent_action_submitted"
  | "consent_action_result"
  | "phone_verification_started"
  | "phone_verification_completed"
  | "persona_switched"
  | "ria_onboarding_submitted"
  | "ria_verification_status_changed"
  | "marketplace_profile_viewed"
  | "ria_request_created"
  | "ria_request_blocked_policy"
  | "ria_workspace_opened"
  | "mcp_ria_read_tool_called"
  | "profile_method_switch_result"
  | "account_delete_requested"
  | "account_delete_completed"
  | "gmail_connect_started"
  | "gmail_connect_result"
  | "gmail_disconnect_result"
  | "gmail_sync_requested"
  | "gmail_sync_result"
  | "gmail_receipts_loaded"
  | "growth_funnel_step_completed"
  | "investor_activation_completed"
  | "ria_activation_completed"
  | "api_request_completed"
  | "route_readiness_completed"
  | "cache_resource_resolved"
  | "route_refresh_completed"
  | "warmup_completed"
  | "startup_readiness_warmup_completed"
  | "one_location_foreground_retry"
  | "one_location_share_confirmed"
  | "one_location_contact_signal_synced"
  | "one_location_request_sent"
  | "one_location_public_link_created"
  | "one_location_recommendation_selected"
  | "one_location_share_review_opened";

export type StatusBucket =
  | "2xx"
  | "3xx"
  | "4xx_expected"
  | "4xx_unexpected"
  | "5xx"
  | "network_error";

export type DurationBucket =
  | "lt_100ms"
  | "100ms_300ms"
  | "300ms_1s"
  | "1s_3s"
  | "3s_10s"
  | "gte_10s";

export type EventResult = "success" | "expected_error" | "error";
export type CacheTier =
  | "memory"
  | "secure_device"
  | "plain_device"
  | "network"
  | "none";
export type CacheFreshness = "fresh" | "stale" | "missing" | "locked" | "unsafe";
export type CacheResourceClass =
  | "public_static"
  | "auth_state"
  | "vault_metadata"
  | "pkm_metadata"
  | "pkm_projection"
  | "financial_resource"
  | "consent_list"
  | "market_data"
  | "ria_workspace"
  | "realtime_stream"
  | "unknown";
export type RouteRenderPath =
  | "fresh_memory"
  | "secure_device_stale"
  | "plain_device_stale"
  | "background_refresh"
  | "cold_loader"
  | "blocked_locked"
  | "realtime_patch";
export type RefreshTrigger =
  | "initial_load"
  | "route_change"
  | "focus"
  | "manual"
  | "mutation"
  | "warmup";
export type CacheFootprintBucket =
  | "none"
  | "lt_50kb"
  | "50kb_250kb"
  | "250kb_1mb"
  | "1mb_5mb"
  | "gte_5mb";

export type AuthMethod = "google" | "apple" | "reviewer" | "redirect" | "existing_session";
export type ConsentAction = "approve" | "deny" | "revoke";

export interface EventContext {
  env: ObservabilityEnvironment;
  platform: ObservabilityPlatform;
  event_category: ObservabilityEventCategory;
  app_version: string;
  route_id?: RouteId;
}

const EVENT_CATEGORY_BY_NAME: Record<
  ObservabilityEventName,
  ObservabilityEventCategory
> = {
  page_view: "system",
  auth_started: "system",
  auth_succeeded: "system",
  auth_failed: "system",
  onboarding_started: "system",
  onboarding_step_completed: "system",
  onboarding_completed: "system",
  import_upload_started: "system",
  import_parse_completed: "system",
  import_quality_gate_passed: "system",
  import_quality_gate_failed: "system",
  import_save_completed: "system",
  market_insights_loaded: "feature",
  portfolio_viewed: "feature",
  recommendation_viewed: "feature",
  profile_picks_loaded: "feature",
  analysis_stream_started: "feature",
  analysis_stream_terminal_decision: "feature",
  analysis_stream_aborted: "feature",
  analysis_stream_error: "feature",
  consent_pending_loaded: "system",
  consent_action_submitted: "system",
  consent_action_result: "system",
  phone_verification_started: "system",
  phone_verification_completed: "system",
  persona_switched: "system",
  ria_onboarding_submitted: "system",
  ria_verification_status_changed: "system",
  marketplace_profile_viewed: "feature",
  ria_request_created: "system",
  ria_request_blocked_policy: "system",
  ria_workspace_opened: "system",
  mcp_ria_read_tool_called: "system",
  profile_method_switch_result: "system",
  account_delete_requested: "system",
  account_delete_completed: "system",
  gmail_connect_started: "system",
  gmail_connect_result: "system",
  gmail_disconnect_result: "system",
  gmail_sync_requested: "system",
  gmail_sync_result: "system",
  gmail_receipts_loaded: "system",
  growth_funnel_step_completed: "funnel",
  investor_activation_completed: "funnel",
  ria_activation_completed: "funnel",
  api_request_completed: "system",
  route_readiness_completed: "system",
  cache_resource_resolved: "system",
  route_refresh_completed: "system",
  warmup_completed: "system",
  startup_readiness_warmup_completed: "system",
  one_location_foreground_retry: "feature",
  one_location_share_confirmed: "feature",
  one_location_contact_signal_synced: "feature",
  one_location_request_sent: "feature",
  one_location_public_link_created: "feature",
  one_location_recommendation_selected: "feature",
  one_location_share_review_opened: "feature",
};

export function resolveObservabilityEventCategory(
  eventName: ObservabilityEventName
): ObservabilityEventCategory {
  return EVENT_CATEGORY_BY_NAME[eventName];
}

export interface EventPayloadMap {
  page_view: {
    route_id: RouteId;
    nav_type?: "route_change" | "initial_load" | "redirect";
  };
  auth_started: {
    action: AuthMethod;
  };
  auth_succeeded: {
    action: AuthMethod;
    result: "success";
  };
  auth_failed: {
    action: AuthMethod;
    result: "error";
    error_class?: string;
  };
  onboarding_started: {
    source: "pre_vault" | "vault";
  };
  onboarding_step_completed: {
    action: "preferences" | "persona";
    result: EventResult;
  };
  onboarding_completed: {
    result: EventResult;
    action: "skip" | "complete";
  };
  import_upload_started: {
    result: EventResult;
  };
  import_parse_completed: {
    result: EventResult;
  };
  import_quality_gate_passed: {
    result: "success";
  };
  import_quality_gate_failed: {
    result: "error";
  };
  import_save_completed: {
    result: EventResult;
  };
  market_insights_loaded: {
    result: EventResult;
    status_bucket?: StatusBucket;
    duration_ms_bucket?: DurationBucket;
  };
  portfolio_viewed: {
    result: EventResult;
    portfolio_source?: GrowthPortfolioSource;
  };
  recommendation_viewed: {
    result: EventResult;
    portfolio_source?: GrowthPortfolioSource;
  };
  profile_picks_loaded: {
    result: EventResult;
    status_bucket?: StatusBucket;
    duration_ms_bucket?: DurationBucket;
  };
  analysis_stream_started: {
    result: "success";
  };
  analysis_stream_terminal_decision: {
    result: EventResult;
  };
  analysis_stream_aborted: {
    result: "expected_error";
    reason?: string;
  };
  analysis_stream_error: {
    result: "error";
    error_class?: string;
  };
  consent_pending_loaded: {
    result: EventResult;
  };
  consent_action_submitted: {
    action: ConsentAction;
    result: "success";
  };
  consent_action_result: {
    action: ConsentAction;
    result: EventResult;
    status_bucket?: StatusBucket;
  };
  phone_verification_started: {
    action: "link" | "replace";
    result: EventResult;
  };
  phone_verification_completed: {
    action: "link" | "replace" | "existing";
    result: EventResult;
  };
  persona_switched: {
    action: "investor" | "ria";
    result: EventResult;
  };
  ria_onboarding_submitted: {
    result: EventResult;
  };
  ria_verification_status_changed: {
    action: "draft" | "submitted" | "verified" | "active" | "rejected";
    result: EventResult;
  };
  marketplace_profile_viewed: {
    action: "ria" | "investor";
    result: EventResult;
  };
  ria_request_created: {
    result: EventResult;
    status_bucket?: StatusBucket;
  };
  ria_request_blocked_policy: {
    result: "expected_error";
    error_class?: string;
  };
  ria_workspace_opened: {
    result: EventResult;
    status_bucket?: StatusBucket;
  };
  mcp_ria_read_tool_called: {
    action: "list_ria_profiles" | "get_ria_profile" | "list_marketplace_investors" | "get_ria_verification_status" | "get_ria_client_access_summary";
    result: EventResult;
  };
  profile_method_switch_result: {
    result: EventResult;
  };
  account_delete_requested: {
    result: "success";
  };
  account_delete_completed: {
    result: EventResult;
    status_bucket?: StatusBucket;
  };
  gmail_connect_started: {
    action: "incremental" | "full";
    result: "success";
  };
  gmail_connect_result: {
    action: "start" | "complete";
    result: EventResult;
  };
  gmail_disconnect_result: {
    result: EventResult;
  };
  gmail_sync_requested: {
    action: "manual";
    result: "success";
  };
  gmail_sync_result: {
    action: "queue" | "already_running";
    result: EventResult;
  };
  gmail_receipts_loaded: {
    result: EventResult;
  };
  growth_funnel_step_completed: {
    journey: GrowthJourney;
    step: GrowthInvestorStep | GrowthRiaStep;
    entry_surface?: GrowthEntrySurface;
    auth_method?: AuthMethod;
    portfolio_source?: GrowthPortfolioSource;
    workspace_source?: GrowthWorkspaceSource;
    app_version: string;
  };
  investor_activation_completed: {
    journey: "investor";
    entry_surface?: GrowthEntrySurface;
    auth_method?: AuthMethod;
    portfolio_source?: GrowthPortfolioSource;
    app_version: string;
  };
  ria_activation_completed: {
    journey: "ria";
    entry_surface?: GrowthEntrySurface;
    auth_method?: AuthMethod;
    workspace_source?: GrowthWorkspaceSource;
    app_version: string;
  };
  api_request_completed: {
    route_id?: RouteId;
    endpoint_template: string;
    http_method: string;
    result: EventResult;
    status_bucket: StatusBucket;
    duration_ms_bucket: DurationBucket;
    retry_count?: number;
  };
  route_readiness_completed: {
    route_id: RouteId;
    result: EventResult;
    render_path: RouteRenderPath;
    cache_tier: CacheTier;
    resource_class: CacheResourceClass;
    duration_ms_bucket: DurationBucket;
    blocking_loader_shown: boolean;
    stale_rendered: boolean;
  };
  cache_resource_resolved: {
    route_id?: RouteId;
    result: EventResult;
    resource_class: CacheResourceClass;
    cache_tier: CacheTier;
    freshness: CacheFreshness;
    duration_ms_bucket: DurationBucket;
    footprint_bucket?: CacheFootprintBucket;
  };
  route_refresh_completed: {
    route_id: RouteId;
    result: EventResult;
    resource_class: CacheResourceClass;
    refresh_trigger: RefreshTrigger;
    duration_ms_bucket: DurationBucket;
    retry_count?: number;
  };
  warmup_completed: {
    route_id?: RouteId;
    result: EventResult;
    resource_class: CacheResourceClass;
    cache_tier: CacheTier;
    warm_priority: string;
    duration_ms_bucket: DurationBucket;
    footprint_bucket?: CacheFootprintBucket;
  };
  startup_readiness_warmup_completed: {
    result: EventResult;
    warm_priority: string;
    duration_ms: number;
    duration_ms_bucket: DurationBucket;
    onboarding_synced: boolean;
    metadata_warmed: boolean;
    financial_warmed: boolean;
    kai_market_warmed: boolean;
    dashboard_picks_warmed: boolean;
    consents_warmed: boolean;
    vault_status_warmed: boolean;
  };
  one_location_foreground_retry: {
    route_id: RouteId;
    operation: string;
    trigger: string;
    result: EventResult;
    attempt_count: number;
    retry_count: number;
    backoff_bucket: string;
    duration_ms_bucket: DurationBucket;
    error_class: string;
  };
  one_location_share_confirmed: {
    route_id: RouteId;
    result: EventResult;
    selected_count: number;
    success_count: number;
    failure_count: number;
    duration_bucket: string;
    review_required: boolean;
  };
  one_location_contact_signal_synced: {
    route_id: RouteId;
    result: EventResult;
    source_platform: string;
    contact_count_bucket: string;
    matched_count: number;
    invite_candidate_count: number;
  };
  one_location_request_sent: {
    route_id: RouteId;
    result: EventResult;
    selected_count: number;
    success_count: number;
    failure_count: number;
    has_note: boolean;
  };
  one_location_public_link_created: {
    route_id: RouteId;
    result: EventResult;
    duration_bucket: string;
    copied_to_clipboard: boolean;
    active_invite_count: number;
  };
  one_location_recommendation_selected: {
    route_id: RouteId;
    action: string;
    result: EventResult;
    selection_surface: string;
    recommendation_category: string;
    recommendation_tier: string;
    selected_count: number;
    can_receive_location: boolean;
  };
  one_location_share_review_opened: {
    route_id: RouteId;
    result: EventResult;
    selected_count: number;
    duration_bucket: string;
    has_permission_warning: boolean;
    has_professional_signal: boolean;
    has_setup_warning: boolean;
  };
}

export type EventPayloadFor<T extends ObservabilityEventName> = EventPayloadMap[T];
export type EventPayloadWithContextFor<T extends ObservabilityEventName> =
  EventContext & EventPayloadFor<T>;
export type PrimitiveEventValue = string | number | boolean | null;

export interface ObservabilityAdapter {
  readonly name: string;
  isAvailable(): boolean;
  track(
    eventName: ObservabilityEventName,
    payload: Record<string, PrimitiveEventValue>
  ): Promise<void>;
}
