"use client";

export const AGENT_GEMINI_TTS_VOICES = ["Charon", "Sulafat", "Kore", "Puck"] as const;

export type AgentGeminiTtsVoice = (typeof AGENT_GEMINI_TTS_VOICES)[number];

export type AgentVoiceSettings = {
  ttsVoice: AgentGeminiTtsVoice;
};

export const DEFAULT_AGENT_GEMINI_TTS_VOICE: AgentGeminiTtsVoice = "Sulafat";

export const AGENT_VOICE_SETTINGS_CHANGED_EVENT = "hushh:agent-voice-settings-changed";

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

const AGENT_VOICE_SETTINGS_STORAGE_KEY = "hushh.agent.voice.settings.v1";
const DISABLED_FLAG_VALUES = new Set(["0", "false", "off", "disabled", "no"]);

function getStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function normalizeAgentGeminiTtsVoice(value: unknown): AgentGeminiTtsVoice {
  if (typeof value !== "string") return DEFAULT_AGENT_GEMINI_TTS_VOICE;
  const normalized = AGENT_GEMINI_TTS_VOICES.find(
    (voice) => voice.toLowerCase() === value.trim().toLowerCase()
  );
  return normalized || DEFAULT_AGENT_GEMINI_TTS_VOICE;
}

export function readAgentVoiceSettings(storage?: Storage | null): AgentVoiceSettings {
  const targetStorage = getStorage(storage);
  if (!targetStorage) {
    return { ttsVoice: DEFAULT_AGENT_GEMINI_TTS_VOICE };
  }

  try {
    const raw = targetStorage.getItem(AGENT_VOICE_SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { ttsVoice?: unknown }) : {};
    return {
      ttsVoice: normalizeAgentGeminiTtsVoice(parsed.ttsVoice),
    };
  } catch {
    return { ttsVoice: DEFAULT_AGENT_GEMINI_TTS_VOICE };
  }
}

export function writeAgentVoiceSettings(
  settings: Partial<AgentVoiceSettings>,
  storage?: Storage | null
): AgentVoiceSettings {
  const current = readAgentVoiceSettings(storage);
  const next: AgentVoiceSettings = {
    ...current,
    ...settings,
    ttsVoice:
      settings.ttsVoice === undefined
        ? current.ttsVoice
        : normalizeAgentGeminiTtsVoice(settings.ttsVoice),
  };
  const targetStorage = getStorage(storage);
  if (targetStorage) {
    targetStorage.setItem(AGENT_VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(next));
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(AGENT_VOICE_SETTINGS_CHANGED_EVENT, { detail: next })
    );
  }
  return next;
}

export function isAgentGeminiVoiceEnabled(): boolean {
  const configured =
    process.env.NEXT_PUBLIC_AGENT_GEMINI_VOICE_ENABLED ??
    process.env.AGENT_GEMINI_VOICE_ENABLED;
  if (configured === undefined || configured === null || String(configured).trim() === "") {
    return true;
  }
  return !DISABLED_FLAG_VALUES.has(String(configured).trim().toLowerCase());
}
