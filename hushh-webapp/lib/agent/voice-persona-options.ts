/**
 * The voice picker Voice Settings offers, keyed by the exact Gemini TTS
 * prebuilt voice name sent to the relay. Must mirror
 * ONE_LIVE_VOICE_OPTIONS in consent-protocol/hushh_mcp/one_adk/agent_tree.py
 * exactly -- the backend validates against its own copy of this list and
 * silently falls back to the deployment default for anything else, so a
 * name added here without a matching backend entry would offer a choice
 * that quietly does nothing.
 */
export type VoicePersonaOption = {
  name: string;
  descriptor: string;
};

export const VOICE_PERSONA_OPTIONS: readonly VoicePersonaOption[] = [
  { name: "Leda", descriptor: "Youthful" },
  { name: "Aoede", descriptor: "Breezy" },
  { name: "Achernar", descriptor: "Soft" },
  { name: "Sulafat", descriptor: "Warm" },
  { name: "Kore", descriptor: "Firm" },
  { name: "Puck", descriptor: "Upbeat" },
] as const;

export const VOICE_PERSONA_NAMES: ReadonlySet<string> = new Set(
  VOICE_PERSONA_OPTIONS.map((option) => option.name),
);

export function isVoicePersonaName(value: unknown): value is string {
  return typeof value === "string" && VOICE_PERSONA_NAMES.has(value);
}
