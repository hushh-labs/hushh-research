import { describe, expect, it } from "vitest";

import {
  VOICE_PERSONA_OPTIONS,
  isVoicePersonaName,
} from "@/lib/agent/voice-persona-options";

describe("voice persona options", () => {
  it("accepts every listed option and rejects anything else", () => {
    for (const option of VOICE_PERSONA_OPTIONS) {
      expect(isVoicePersonaName(option.name)).toBe(true);
    }

    expect(isVoicePersonaName("not-a-real-voice")).toBe(false);
    expect(isVoicePersonaName(null)).toBe(false);
    expect(isVoicePersonaName(undefined)).toBe(false);
    expect(isVoicePersonaName(42)).toBe(false);
  });
});
