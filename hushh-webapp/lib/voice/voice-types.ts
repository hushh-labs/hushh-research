import type { KaiCommandAction, KaiWorkspaceTab } from "@/lib/kai/kai-command-types";

export type VoiceSurfaceSectionDefinition = {
  id: string;
  title: string;
  purpose?: string | null;
  summary?: string | null;
};

export type VoiceSurfaceActionDefinition = {
  id: string;
  label: string;
  purpose?: string | null;
  description?: string | null;
  voiceAliases?: string[];
};

export type VoiceSurfaceControlDefinition = {
  id: string;
  label: string;
  type?: string | null;
  state?: string | null;
  purpose?: string | null;
  description?: string | null;
  actionId?: string | null;
  role?: string | null;
  voiceAliases?: string[];
};

export type VoiceSurfaceConceptDefinition = {
  id?: string | null;
  label: string;
  description?: string | null;
  explanation?: string | null;
  aliases?: string[];
};

export type VoiceSurfaceDefinition = {
  screenId?: string | null;
  title?: string | null;
  purpose?: string | null;
  primaryEntity?: string | null;
  sections: VoiceSurfaceSectionDefinition[];
  actions: VoiceSurfaceActionDefinition[];
  controls: VoiceSurfaceControlDefinition[];
  concepts: VoiceSurfaceConceptDefinition[];
  activeControlId?: string | null;
  lastInteractedControlId?: string | null;
};

export type VoiceExecuteKaiCommandCall = {
  tool_name: "execute_kai_command";
  args: {
    command: KaiCommandAction;
    params?: {
      symbol?: string;
      focus?: "active";
      tab?: KaiWorkspaceTab;
    };
  };
};

export type VoiceNavigateBackCall = {
  tool_name: "navigate_back";
  args: Record<string, never>;
};

export type VoiceResumeActiveAnalysisCall = {
  tool_name: "resume_active_analysis";
  args: Record<string, never>;
};

export type VoiceCancelActiveAnalysisCall = {
  tool_name: "cancel_active_analysis";
  args: {
    confirm: boolean;
  };
};

export type VoiceClarifyCall = {
  tool_name: "clarify";
  args: {
    question: string;
    options?: string[];
  };
};

export type VoiceToolCall =
  | VoiceExecuteKaiCommandCall
  | VoiceNavigateBackCall
  | VoiceResumeActiveAnalysisCall
  | VoiceCancelActiveAnalysisCall
  | VoiceClarifyCall;

export type AppRuntimeState = {
  auth: {
    signed_in: boolean;
    user_id: string | null;
  };
  vault: {
    unlocked: boolean;
    token_available: boolean;
    token_valid: boolean;
  };
  route: {
    pathname: string;
    screen: string;
    subview?: string | null;
  };
  runtime: {
    analysis_active: boolean;
    analysis_ticker?: string | null;
    analysis_run_id?: string | null;
    import_active: boolean;
    import_run_id?: string | null;
    busy_operations: string[];
  };
  portfolio: {
    has_portfolio_data: boolean;
  };
  voice: {
    available: boolean;
    tts_playing: boolean;
    last_tool_name?: string | null;
    last_ticker?: string | null;
  };
};

export type VoiceBlockedResponse = {
  kind: "blocked";
  reason: "auth_required" | "vault_required";
  message: string;
  speak: true;
};

export type VoiceClarifyResponse = {
  kind: "clarify";
  reason: "stt_unusable" | "ticker_ambiguous" | "ticker_unknown";
  message: string;
  candidate?: string | null;
  speak: true;
};

export type VoiceAlreadyRunningResponse = {
  kind: "already_running";
  task: "analysis" | "import";
  ticker?: string | null;
  run_id?: string | null;
  message: string;
  speak: true;
};

export type VoiceExecuteResponse = {
  kind: "execute";
  tool_call: VoiceToolCall;
  message: string;
  speak: true;
};

export type VoiceBackgroundStartedResponse = {
  kind: "background_started";
  task: "analysis";
  ticker: string;
  run_id: string;
  message: string;
  speak: true;
};

export type VoiceSpeakOnlyResponse = {
  kind: "speak_only";
  message: string;
  speak: true;
};

export type VoiceResponse =
  | VoiceBlockedResponse
  | VoiceClarifyResponse
  | VoiceAlreadyRunningResponse
  | VoiceExecuteResponse
  | VoiceBackgroundStartedResponse
  | VoiceSpeakOnlyResponse;

export type VoiceMemoryHint = {
  allow_durable_write: boolean;
};

export type VoicePlanPayload = {
  response: VoiceResponse;
  tool_call?: VoiceToolCall;
  memory?: VoiceMemoryHint;
  execution_allowed?: boolean;
  needs_confirmation?: boolean;
  elapsed_ms?: number;
  openai_http_ms?: number;
  model?: string;
};

export type PlannerV2Request = {
  turn_id: string;
  transcript_final: string;
  context: Record<string, unknown>;
  memory_short: Array<{
    turn_id: string;
    transcript_final: string;
    response_text: string;
    response_kind: string;
    created_at_ms: number;
  }>;
  memory_retrieved: Array<{
    id: string;
    category: string;
    summary: string;
    created_at_ms: number;
    last_used_ms: number;
  }>;
};

export type PlannerV2Response = {
  turn_id: string;
  response_id: string;
  intent?: { name: string; confidence: number };
  action?: { type: "navigate" | "tool" | "none"; payload?: Record<string, unknown> };
  execution_allowed?: boolean;
  needs_confirmation?: boolean;
  ack_text?: string;
  final_text?: string;
  is_long_running?: boolean;
  memory_write_candidates?: Array<{
    category: string;
    summary: string;
  }>;
};

export type VoiceCapabilityResponse = {
  enabled: boolean;
  reason: string | null;
  voice_enabled?: boolean;
  execution_allowed?: boolean;
  tool_execution_disabled?: boolean;
  rollout_reason?: string | null;
  bucket?: number | null;
  canary_percent?: number | null;
  realtime_enabled?: boolean;
  stt_enabled?: boolean;
  tts_enabled?: boolean;
  tts_timeout_ms?: number;
  tts_model?: string;
  tts_voice?: string;
  tts_format?: string;
};
