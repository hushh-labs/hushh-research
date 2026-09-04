import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isAgentGeminiVoiceEnabled,
} from "@/lib/agent/agent-voice-settings";

describe("agent voice settings", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats the Agent Gemini voice flag as enabled unless explicitly disabled", () => {
    expect(isAgentGeminiVoiceEnabled()).toBe(true);

    vi.stubEnv("NEXT_PUBLIC_AGENT_GEMINI_VOICE_ENABLED", "false");
    expect(isAgentGeminiVoiceEnabled()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_AGENT_GEMINI_VOICE_ENABLED", "1");
    expect(isAgentGeminiVoiceEnabled()).toBe(true);
  });

});
