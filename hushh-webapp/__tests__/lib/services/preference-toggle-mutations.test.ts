import { describe, expect, it } from "vitest";

/**
 * Characterization: user preference toggle resilience to arbitrary text mutations.
 *
 * Verified repo truth (truth-first)
 * ---------------------------------
 * The public preference-modification helpers for the agent voice setting live in
 * `hushh-webapp/lib/agent/agent-voice-settings.ts`:
 *   - `normalizeAgentGeminiTtsVoice(value: unknown)` — coerces any input to a
 *     valid `AgentGeminiTtsVoice`, falling back to `DEFAULT_AGENT_GEMINI_TTS_VOICE`
 *     ("Sulafat") for any non-matching / non-string input.
 *   - `readAgentVoiceSettings(storage?)` — reads + JSON.parses the persisted
 *     descriptor, normalizing `ttsVoice`; returns the default on parse failure.
 *   - `writeAgentVoiceSettings(settings, storage?)` — merges a partial settings
 *     patch over current, normalizes the toggle value, and persists it.
 *
 * These accept an injectable `Storage`, so the parsing layer can be exercised
 * deterministically without a DOM. This suite passes randomized strings, emoji,
 * spatial / zero-width / control whitespace, and structurally hostile persisted
 * payloads, asserting the parser never throws and always resolves to a value
 * within the allowed `AGENT_GEMINI_TTS_VOICES` set.
 *
 * No source is modified; this only documents existing resilience behavior. The
 * file lives at the requested `__tests__/lib/services/` path even though the unit
 * under test is `lib/agent/agent-voice-settings.ts`.
 */

import {
  AGENT_GEMINI_TTS_VOICES,
  DEFAULT_AGENT_GEMINI_TTS_VOICE,
  normalizeAgentGeminiTtsVoice,
  readAgentVoiceSettings,
  writeAgentVoiceSettings,
} from "@/lib/agent/agent-voice-settings";

const STORAGE_KEY = "hushh.agent.voice.settings.v1";

/** Minimal in-memory Storage stub for deterministic, DOM-free parsing tests. */
function createMemoryStorage(seed?: string): Storage {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set(STORAGE_KEY, seed);
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

const VALID_VOICES = new Set<string>(AGENT_GEMINI_TTS_VOICES);

const ARBITRARY_TEXT_MUTATIONS: string[] = [
  "🎙️🔥✨",
  "  Charon  ",
  "C\u200bharon", // zero-width space inside a real voice name
  "\t\n  \r\f\v",
  "\u00a0\u2003\u3000", // nbsp + em space + ideographic space
  "ＳＵＬＡＦＡＴ", // full-width spatial characters
  "voice\u0000name", // embedded null byte
  "🧪".repeat(2048), // large emoji payload
  "Kore\uD83D\uDE00", // valid prefix + surrogate-pair emoji
  "'; DROP TABLE settings; --",
  "{{__proto__}}",
  "\u202Ereversed\u202C", // bidi override controls
  "",
  "   ",
];

describe("normalizeAgentGeminiTtsVoice · arbitrary text mutation resilience", () => {
  it("always resolves to a valid voice without throwing for arbitrary strings", () => {
    for (const mutation of ARBITRARY_TEXT_MUTATIONS) {
      let resolved: string | undefined;
      expect(() => {
        resolved = normalizeAgentGeminiTtsVoice(mutation);
      }).not.toThrow();
      expect(VALID_VOICES.has(resolved as string)).toBe(true);
    }
  });

  it("falls back to the default for non-string / nullish inputs", () => {
    const nonStrings: unknown[] = [
      null,
      undefined,
      42,
      Number.NaN,
      true,
      Symbol("x"),
      { ttsVoice: "Charon" },
      ["Charon"],
      () => "Charon",
    ];
    for (const value of nonStrings) {
      expect(normalizeAgentGeminiTtsVoice(value)).toBe(
        DEFAULT_AGENT_GEMINI_TTS_VOICE
      );
    }
  });

  it("matches valid voices case-insensitively after trimming surrounding spaces", () => {
    expect(normalizeAgentGeminiTtsVoice("  charon ")).toBe("Charon");
    expect(normalizeAgentGeminiTtsVoice("KORE")).toBe("Kore");
    expect(normalizeAgentGeminiTtsVoice("pUcK")).toBe("Puck");
  });
});

describe("readAgentVoiceSettings · hostile persisted payload resilience", () => {
  const hostilePayloads: string[] = [
    "not json at all 🤖",
    "{ this is : broken",
    "[]",
    "null",
    "12345",
    '"a-bare-string"',
    '{"ttsVoice": "🎤🎶"}',
    '{"ttsVoice": 999}',
    '{"ttsVoice": {"nested": true}}',
    '{"ttsVoice": "  KoRe \u3000"}',
    `{"ttsVoice": "${"x".repeat(5000)}"}`,
    '{"__proto__": {"polluted": true}, "ttsVoice": "Puck"}',
  ];

  it("never throws and always yields a valid toggle value for hostile storage", () => {
    for (const payload of hostilePayloads) {
      const storage = createMemoryStorage(payload);
      let result: { ttsVoice: string } | undefined;
      expect(() => {
        result = readAgentVoiceSettings(storage);
      }).not.toThrow();
      expect(VALID_VOICES.has(result!.ttsVoice)).toBe(true);
    }
  });

  it("returns the default toggle when storage is empty or absent", () => {
    expect(readAgentVoiceSettings(createMemoryStorage()).ttsVoice).toBe(
      DEFAULT_AGENT_GEMINI_TTS_VOICE
    );
    expect(readAgentVoiceSettings(null).ttsVoice).toBe(
      DEFAULT_AGENT_GEMINI_TTS_VOICE
    );
  });

  it("does not allow prototype pollution from a crafted persisted payload", () => {
    const storage = createMemoryStorage(
      '{"__proto__": {"polluted": true}, "ttsVoice": "Puck"}'
    );
    readAgentVoiceSettings(storage);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("writeAgentVoiceSettings · arbitrary mutation round-trip stability", () => {
  it("persists a normalized, valid descriptor for arbitrary string mutations", () => {
    for (const mutation of ARBITRARY_TEXT_MUTATIONS) {
      const storage = createMemoryStorage();
      let next: { ttsVoice: string } | undefined;
      expect(() => {
        next = writeAgentVoiceSettings(
          { ttsVoice: mutation as never },
          storage
        );
      }).not.toThrow();
      expect(VALID_VOICES.has(next!.ttsVoice)).toBe(true);

      // The persisted blob must be valid JSON that reads back to a valid voice.
      const persisted = storage.getItem(STORAGE_KEY);
      expect(persisted).not.toBeNull();
      const roundTripped = readAgentVoiceSettings(storage);
      expect(VALID_VOICES.has(roundTripped.ttsVoice)).toBe(true);
      expect(roundTripped.ttsVoice).toBe(next!.ttsVoice);
    }
  });

  it("preserves the current toggle when the patch omits ttsVoice (undefined)", () => {
    const storage = createMemoryStorage('{"ttsVoice": "Kore"}');
    const next = writeAgentVoiceSettings({}, storage);
    expect(next.ttsVoice).toBe("Kore");
  });

  it("keeps successive arbitrary writes isolated and always valid", () => {
    const storage = createMemoryStorage();
    for (const mutation of ["🌀", "charon", "💥💥💥", "puck"]) {
      const next = writeAgentVoiceSettings({ ttsVoice: mutation as never }, storage);
      expect(VALID_VOICES.has(next.ttsVoice)).toBe(true);
    }
  });
});
