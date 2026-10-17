import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AGENT_GEMINI_TTS_VOICE,
  isAgentGeminiVoiceEnabled,
  isVoiceWakePhrase,
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

  describe("isVoiceWakePhrase", () => {
    it.each([
      "Hello Agent One",
      "hello agent one",
      "HELLO AGENT ONE",
      "Hello Agent One!",
      "Hello Agent One?",
      "Hello One",
      "hello one",
      "Hello One.",
      "Hi Agent One",
      "hi one",
      "Hey One",
      "hey agent one",
      "Talk to One",
      "talk to one",
      "Start voice mode",
      "start voice mode",
      "start voice",
      "trigger voice agent",
      "open voice mode",
    ])("recognizes positive wake phrase: %s", (phrase) => {
      expect(isVoiceWakePhrase(phrase)).toBe(true);
    });

    it.each([
      "Hello",
      "Hi",
      "Hey",
      "One",
      "Agent",
      "What is the weather today?",
      "Take me to profile",
      "Hello world",
      "",
      "   ",
      null,
      undefined,
    ])("rejects non-wake phrase: %s", (phrase) => {
      expect(isVoiceWakePhrase(phrase)).toBe(false);
    });
  });
});
