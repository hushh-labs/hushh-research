import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AGENT_GEMINI_TTS_VOICE,
  isAgentGeminiVoiceEnabled,
} from "@/lib/agent/agent-voice-settings";

describe("agent voice settings", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins One's single fixed voice identity", () => {
    expect(DEFAULT_AGENT_GEMINI_TTS_VOICE).toBe("Sulafat");
  });

  it("treats the Agent Gemini voice flag as enabled unless explicitly disabled", () => {
    expect(isAgentGeminiVoiceEnabled()).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_AGENT_GEMINI_VOICE_ENABLED", "false");
    expect(isAgentGeminiVoiceEnabled()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_AGENT_GEMINI_VOICE_ENABLED", "1");
    expect(isAgentGeminiVoiceEnabled()).toBe(true);
  });

});
