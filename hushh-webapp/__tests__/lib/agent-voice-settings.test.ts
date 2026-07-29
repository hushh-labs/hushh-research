import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AGENT_GEMINI_TTS_VOICE,
  isAgentGeminiVoiceEnabled,
  normalizeAgentGeminiTtsVoice,
  readAgentVoiceSettings,
  writeAgentVoiceSettings,
} from "@/lib/agent/agent-voice-settings";
import {
  resolveVoiceDirectBackendPreference,
  resolveVoiceForceProxyPreference,
} from "@/lib/runtime/settings";

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
});

// ── runtime/settings — boolean string coercion protection ────────────────────
//
// isTruthy() in settings.ts uses an explicit allowlist
// ["1", "true", "yes", "on", "enabled"] rather than a naive !!raw cast.
// The critical contract: "false" and "0" are non-empty strings and would
// evaluate to true under !!raw, but MUST evaluate to false here so that
// feature flags set to "false" in environment config are correctly disabled.

describe("runtime settings — boolean string coercion protection", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false for string 'false', not a truthy non-empty string (direct backend pref)", () => {
    vi.stubEnv("NEXT_PUBLIC_VOICE_DIRECT_BACKEND", "false");
    expect(resolveVoiceDirectBackendPreference()).toBe(false);
  });

  it("returns true for string 'true', the canonical truthy form (direct backend pref)", () => {
    vi.stubEnv("NEXT_PUBLIC_VOICE_DIRECT_BACKEND", "true");
    expect(resolveVoiceDirectBackendPreference()).toBe(true);
  });

  it("returns false for string '0', not a truthy non-empty string (direct backend pref)", () => {
    vi.stubEnv("NEXT_PUBLIC_VOICE_DIRECT_BACKEND", "0");
    expect(resolveVoiceDirectBackendPreference()).toBe(false);
  });

  it("defaults to false when the env var is absent (direct backend pref)", () => {
    expect(resolveVoiceDirectBackendPreference()).toBe(false);
  });

  it("applies the same coercion contract to resolveVoiceForceProxyPreference", () => {
    vi.stubEnv("NEXT_PUBLIC_VOICE_FORCE_PROXY", "false");
    expect(resolveVoiceForceProxyPreference()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_VOICE_FORCE_PROXY", "true");
    expect(resolveVoiceForceProxyPreference()).toBe(true);
  });
});
