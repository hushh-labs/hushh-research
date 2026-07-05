"use client";

export type VoiceUiState =
  | "idle"
  | "opening"
  | "listening"
  | "understanding"
  | "intent_preview"
  | "needs_consent"
  | "acting"
  | "navigation_settling"
  | "result"
  | "follow_up"
  | "error_recovery"
  | "sheet_listening"
  | "sheet_muted"
  | "sheet_submitting"
  | "processing_compact"
  | "speaking_compact"
  | "retry_ready"
  | "error_terminal";

export type OneVoiceUiState = Exclude<
  VoiceUiState,
  | "sheet_listening"
  | "sheet_muted"
  | "sheet_submitting"
  | "processing_compact"
  | "speaking_compact"
  | "retry_ready"
  | "error_terminal"
>;

export type OneVoiceTransition = {
  from: VoiceUiState;
  to: VoiceUiState;
  atMs: number;
  transitionSeq?: number;
  sessionId?: string | null;
  sourceId?: string | null;
  reason?: string | null;
  ariaLive: "off" | "polite" | "assertive";
  label: string;
};

const TRANSITIONS: Record<VoiceUiState, VoiceUiState[]> = {
  idle: [
    "opening",
    "listening",
    "sheet_listening",
    "retry_ready",
    "error_recovery",
    "error_terminal",
  ],
  opening: ["listening", "understanding", "idle", "error_recovery"],
  listening: [
    "understanding",
    "intent_preview",
    "needs_consent",
    "acting",
    "result",
    "follow_up",
    "idle",
    "error_recovery",
  ],
  understanding: [
    "intent_preview",
    "needs_consent",
    "acting",
    "navigation_settling",
    "result",
    "follow_up",
    "listening",
    "idle",
    "error_recovery",
  ],
  intent_preview: [
    "needs_consent",
    "acting",
    "result",
    "follow_up",
    "listening",
    "idle",
    "error_recovery",
  ],
  needs_consent: ["acting", "result", "follow_up", "listening", "idle", "error_recovery"],
  acting: ["navigation_settling", "result", "follow_up", "listening", "idle", "error_recovery"],
  navigation_settling: ["result", "follow_up", "listening", "idle", "error_recovery"],
  result: ["follow_up", "listening", "idle", "error_recovery"],
  follow_up: ["listening", "understanding", "idle", "error_recovery"],
  error_recovery: ["opening", "listening", "idle"],
  sheet_listening: [
    "sheet_muted",
    "sheet_submitting",
    "processing_compact",
    "speaking_compact",
    "retry_ready",
    "idle",
    "error_terminal",
  ],
  sheet_muted: ["sheet_listening", "sheet_submitting", "retry_ready", "idle", "error_terminal"],
  sheet_submitting: ["processing_compact", "idle", "error_terminal"],
  processing_compact: ["speaking_compact", "retry_ready", "idle", "sheet_listening", "error_terminal"],
  speaking_compact: ["processing_compact", "retry_ready", "idle", "sheet_listening", "error_terminal"],
  retry_ready: ["sheet_listening", "processing_compact", "speaking_compact", "idle", "error_terminal"],
  error_terminal: ["idle", "sheet_listening"],
};

const ONE_VOICE_LABELS: Record<OneVoiceUiState, string> = {
  idle: "One Voice idle",
  opening: "One Voice opening",
  listening: "One is listening",
  understanding: "One is understanding",
  intent_preview: "One is previewing the intent",
  needs_consent: "One needs confirmation",
  acting: "One is acting",
  navigation_settling: "One is opening the next view",
  result: "One has a result",
  follow_up: "One is ready for a follow-up",
  error_recovery: "One Voice needs attention",
};

const LEGACY_TO_ONE_STATE: Record<VoiceUiState, OneVoiceUiState> = {
  idle: "idle",
  opening: "opening",
  listening: "listening",
  understanding: "understanding",
  intent_preview: "intent_preview",
  needs_consent: "needs_consent",
  acting: "acting",
  navigation_settling: "navigation_settling",
  result: "result",
  follow_up: "follow_up",
  error_recovery: "error_recovery",
  sheet_listening: "listening",
  sheet_muted: "follow_up",
  sheet_submitting: "understanding",
  processing_compact: "understanding",
  speaking_compact: "result",
  retry_ready: "follow_up",
  error_terminal: "error_recovery",
};

const AGENT_STATUS_TO_ONE_STATE: Record<string, OneVoiceUiState> = {
  idle: "idle",
  connecting: "opening",
  listening: "listening",
  muted: "follow_up",
  transcribing: "understanding",
  thinking: "understanding",
  speaking: "result",
  error: "error_recovery",
};

export function canTransitionVoiceUiState(from: VoiceUiState, to: VoiceUiState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function getAllowedVoiceUiTransitions(from: VoiceUiState): VoiceUiState[] {
  return [...(TRANSITIONS[from] ?? [])];
}

export function normalizeOneVoiceUiState(state: VoiceUiState): OneVoiceUiState {
  return LEGACY_TO_ONE_STATE[state] ?? "idle";
}

export function mapAgentVoiceStatusToOneVoiceState(status: string): OneVoiceUiState {
  return AGENT_STATUS_TO_ONE_STATE[status] ?? "idle";
}

export function getOneVoiceStateLabel(state: VoiceUiState): string {
  return ONE_VOICE_LABELS[normalizeOneVoiceUiState(state)];
}

export function createOneVoiceTransition(
  from: VoiceUiState,
  to: VoiceUiState,
  reason?: string | null,
  atMs = Date.now(),
  metadata?: {
    transitionSeq?: number;
    sessionId?: string | null;
    sourceId?: string | null;
  }
): OneVoiceTransition {
  const normalizedTo = normalizeOneVoiceUiState(to);
  return {
    from,
    to,
    atMs,
    transitionSeq: metadata?.transitionSeq,
    sessionId: metadata?.sessionId ?? null,
    sourceId: metadata?.sourceId ?? null,
    reason: reason ?? null,
    ariaLive:
      normalizedTo === "error_recovery"
        ? "assertive"
        : normalizedTo === "idle"
          ? "off"
          : "polite",
    label: getOneVoiceStateLabel(normalizedTo),
  };
}
