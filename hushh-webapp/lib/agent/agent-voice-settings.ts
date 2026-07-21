"use client";

// One Live is the only interactive audio owner. Other surfaces may request a
// session, but only the persistent Agent Bar can acquire the microphone,
// create the Live transport, or render native-audio playback.
export const AGENT_CONVERSATION_REQUEST_EVENT = "hushh:agent-conversation-request";

/**
 * Ask the persistent Agent Bar to toggle One Live. The event deliberately
 * carries no text, credentials, or audio and cannot start a fallback STT/TTS
 * pipeline.
 */
export function requestAgentConversation(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AGENT_CONVERSATION_REQUEST_EVENT));
}

const DISABLED_FLAG_VALUES = new Set(["0", "false", "off", "disabled", "no"]);

export function isAgentGeminiVoiceEnabled(): boolean {
  const configured = process.env.NEXT_PUBLIC_AGENT_GEMINI_VOICE_ENABLED;
  if (configured === undefined || configured === null || String(configured).trim() === "") {
    return true;
  }
  return !DISABLED_FLAG_VALUES.has(String(configured).trim().toLowerCase());
}
