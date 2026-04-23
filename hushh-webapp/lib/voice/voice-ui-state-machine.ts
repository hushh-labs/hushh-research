// Signed-off-by: Madhvi Rathor <madhvirathor14@gmail.com>
"use client";

export type VoiceUiState =
  | "idle"
  | "sheet_listening"
  | "sheet_muted"
  | "sheet_submitting"
  | "processing_compact"
  | "speaking_compact"
  | "retry_ready"
  | "error_terminal"
  | "error_microphone_denied"
  | "error_network"
  | "loading";

const TRANSITIONS: Record<VoiceUiState, VoiceUiState[]> = {
  idle: ["sheet_listening", "retry_ready", "error_terminal", "loading"],
  loading: ["sheet_listening", "error_microphone_denied", "error_terminal", "idle"],
  sheet_listening: [
    "sheet_muted",
    "sheet_submitting",
    "processing_compact",
    "speaking_compact",
    "retry_ready",
    "idle",
    "error_terminal",
    "error_network",
  ],
  sheet_muted: [
    "sheet_listening",
    "sheet_submitting",
    "retry_ready",
    "idle",
    "error_terminal",
  ],
  sheet_submitting: [
    "processing_compact",
    "idle",
    "error_terminal",
    "error_network",
  ],
  processing_compact: [
    "speaking_compact",
    "retry_ready",
    "idle",
    "sheet_listening",
    "error_terminal",
    "error_network",
  ],
  speaking_compact: [
    "processing_compact",
    "retry_ready",
    "idle",
    "sheet_listening",
    "error_terminal",
  ],
  retry_ready: [
    "sheet_listening",
    "processing_compact",
    "speaking_compact",
    "idle",
    "error_terminal",
  ],
  error_terminal: ["idle", "sheet_listening"],
  error_microphone_denied: ["idle"],
  error_network: ["idle", "retry_ready", "sheet_listening"],
};

export function canTransitionVoiceUiState(
  from: VoiceUiState,
  to: VoiceUiState
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function getAllowedVoiceUiTransitions(
  from: VoiceUiState
): VoiceUiState[] {
  return [...(TRANSITIONS[from] ?? [])];
}

/** Returns true if the given state represents an error condition */
export function isVoiceErrorState(state: VoiceUiState): boolean {
  return (
    state === "error_terminal" ||
    state === "error_microphone_denied" ||
    state === "error_network"
  );
}

/** Returns a user-friendly message for each UI state */
export function getVoiceUiStateMessage(state: VoiceUiState): string {
  const messages: Record<VoiceUiState, string> = {
    idle: "Tap to speak",
    loading: "Setting up voice...",
    sheet_listening: "Listening...",
    sheet_muted: "Microphone muted",
    sheet_submitting: "Sending your message...",
    processing_compact: "Kai is thinking...",
    speaking_compact: "Kai is speaking...",
    retry_ready: "Tap to try again",
    error_terminal: "Something went wrong. Tap to restart.",
    error_microphone_denied:
      "Microphone access denied. Please allow microphone in browser settings.",
    error_network: "Connection lost. Please check your internet.",
  };
  return messages[state];
}
