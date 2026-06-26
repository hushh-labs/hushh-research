import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AGENT_GEMINI_TTS_VOICE,
  isAgentGeminiVoiceEnabled,
  isAgentRealtimeVoiceEnabled,
  normalizeAgentGeminiTtsVoice,
  readAgentVoiceSettings,
  writeAgentVoiceSettings,
} from "@/lib/agent/agent-voice-settings";

describe("agent voice settings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllEnvs();
  });

  it("defaults to Sulafat", () => {
    expect(readAgentVoiceSettings().ttsVoice).toBe(DEFAULT_AGENT_GEMINI_TTS_VOICE);
    expect(DEFAULT_AGENT_GEMINI_TTS_VOICE).toBe("Sulafat");
  });

  it("persists a supported Gemini TTS voice locally", () => {
    const saved = writeAgentVoiceSettings({ ttsVoice: "Kore" });

    expect(saved.ttsVoice).toBe("Kore");
    expect(readAgentVoiceSettings().ttsVoice).toBe("Kore");
  });

  it("normalizes invalid voices back to the default", () => {
    expect(normalizeAgentGeminiTtsVoice("unknown")).toBe("Sulafat");
  });

  it("treats the Agent Gemini voice flag as enabled unless explicitly disabled", () => {
    expect(isAgentGeminiVoiceEnabled()).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_AGENT_GEMINI_VOICE_ENABLED", "false");
    expect(isAgentGeminiVoiceEnabled()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_AGENT_GEMINI_VOICE_ENABLED", "1");
    expect(isAgentGeminiVoiceEnabled()).toBe(true);
  });

  it("treats realtime voice as disabled by default and only enables on an explicit opt-in", () => {
    expect(isAgentRealtimeVoiceEnabled()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_AGENT_REALTIME_VOICE_ENABLED", "");
    expect(isAgentRealtimeVoiceEnabled()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_AGENT_REALTIME_VOICE_ENABLED", "false");
    expect(isAgentRealtimeVoiceEnabled()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_AGENT_REALTIME_VOICE_ENABLED", "true");
    expect(isAgentRealtimeVoiceEnabled()).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_AGENT_REALTIME_VOICE_ENABLED", "1");
    expect(isAgentRealtimeVoiceEnabled()).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_AGENT_REALTIME_VOICE_ENABLED", "on");
    expect(isAgentRealtimeVoiceEnabled()).toBe(true);
  });
});
