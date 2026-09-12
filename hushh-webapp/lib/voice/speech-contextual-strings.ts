import { listKaiActions } from "./kai-action-gateway";

/** Apple documents a maximum of 100 short contextual phrases. */
export const IOS_SPEECH_CONTEXTUAL_STRING_LIMIT = 100;
const MAX_CONTEXTUAL_STRING_LENGTH = 64;

function normalizePhrase(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_CONTEXTUAL_STRING_LENGTH);
}

function phraseWordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

/**
 * Build recognition hints from the generated action catalog only.
 *
 * These strings are ASR vocabulary hints, not an intent registry and not an
 * authorization surface. Keep them short because Apple's recognizer is more
 * effective with one- or two-word app-specific terms than long commands.
 */
export function buildSpeechContextualStrings(): string[] {
  const phrases = new Map<string, string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const phrase = normalizePhrase(value);
    if (!phrase || phraseWordCount(phrase) > 3) return;
    const key = phrase.toLocaleLowerCase();
    if (!phrases.has(key)) phrases.set(key, phrase);
  };

  [
    "Agent One",
    "Hussh",
    "Circle",
    "Circles",
    "Location",
    "location sharing",
    "SOS",
  ].forEach(add);

  const actions = [...listKaiActions()].sort((left, right) => {
    const leftLocation = left.delegate_agent_id === "agent_location" ? 0 : 1;
    const rightLocation = right.delegate_agent_id === "agent_location" ? 0 : 1;
    return leftLocation - rightLocation || left.action_id.localeCompare(right.action_id);
  });
  for (const action of actions) {
    add(action.label);
    for (const alias of action.aliases) add(alias);
    for (const keyword of action.search_keywords) add(keyword);
    if (phrases.size >= IOS_SPEECH_CONTEXTUAL_STRING_LIMIT) break;
  }

  return [...phrases.values()].slice(0, IOS_SPEECH_CONTEXTUAL_STRING_LIMIT);
}
