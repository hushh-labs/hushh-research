"use client";

/**
 * One speaks with a single fixed voice identity across surfaces. Full-duplex
 * realtime voice (the primary lane) uses the Gemini Live relay's server-side
 * voice; this constant keeps the turn-based chat TTS lane consistent with
 * that posture. There is deliberately no per-device voice picker: a future
 * user-selectable voice belongs server-side (Live speech_config) so one
 * setting governs both lanes.
 */
export const DEFAULT_AGENT_GEMINI_TTS_VOICE = "Sulafat";

// Dispatched by the agent bar's conversational-mode control to request the
// agent workspace auto-start a voice turn once it has opened and is ready.
export const AGENT_CONVERSATION_REQUEST_EVENT = "hushh:agent-conversation-request";

/**
 * Ask the agent workspace to start conversational (voice) mode. Safe to call
 * before the workspace mounts; the workspace re-checks the pending request on
 * mount. Callers should also open the agent surface (openAgent) alongside this.
 */
export function requestAgentConversation(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AGENT_CONVERSATION_REQUEST_EVENT));
}

const DISABLED_FLAG_VALUES = new Set(["0", "false", "off", "disabled", "no"]);

export function isAgentGeminiVoiceEnabled(): boolean {
  const configured =
    process.env.NEXT_PUBLIC_AGENT_GEMINI_VOICE_ENABLED ??
    process.env.AGENT_GEMINI_VOICE_ENABLED;
  if (configured === undefined || configured === null || String(configured).trim() === "") {
    return true;
  }
  return !DISABLED_FLAG_VALUES.has(String(configured).trim().toLowerCase());
}


