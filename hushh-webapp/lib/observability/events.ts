import type { ObservabilityEnvironment } from "@/lib/observability/env";
import type { RouteId } from "@/lib/observability/route-map";

export type ObservabilityPlatform = "web" | "ios" | "android";
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
  | "portfolio_ready"
  | "activated";
export type GrowthRiaStep =
  | "entered"
  | "auth_completed"
  | "profile_submitted"
  | "request_created"
  | "workspace_ready"
  | "activated";

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
  | "profile_picks_loaded"
  | "analysis_stream_started"
  | "analysis_stream_terminal_decision"
  | "analysis_stream_aborted"
  | "analysis_stream_error"
  | "consent_pending_loaded"
  | "consent_action_submitted"
  | "consent_action_result"
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
  | "api_request_completed";

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

export type AuthMethod = "google" | "apple" | "reviewer" | "redirect";
export type ConsentAction = "approve" | "deny" | "revoke";

export interface EventContext {
  env: ObservabilityEnvironment;
  platform: ObservabilityPlatform;
  route_id?: RouteId;
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
  persona_switched: {
    action: "investor" | "ria";
    result: EventResult;
  };
  ria_onboarding_submitted: {
    result: EventResult;
  };
  ria_verification_status_changed: {
    action: "draft" | "submitted" | "verified" | "active" | "rejected" | "bypassed";
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
