"use client";

export type VoiceUiState =
  | "idle"
  | "sheet_listening"
  | "sheet_muted"
  | "sheet_submitting"
  | "processing_compact"
  | "speaking_compact"
  | "retry_ready"
  | "error_terminal";

const TRANSITIONS: Record<VoiceUiState, VoiceUiState[]> = {
  idle: ["sheet_listening", "retry_ready", "error_terminal"],
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

export function canTransitionVoiceUiState(from: VoiceUiState, to: VoiceUiState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function getAllowedVoiceUiTransitions(from: VoiceUiState): VoiceUiState[] {
  return [...(TRANSITIONS[from] ?? [])];
}
