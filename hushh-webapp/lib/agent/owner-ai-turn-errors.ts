/**
 * Copy for a turn the person's own AI key could not run.
 *
 * A private agent with a sealed "Bring your own AI" selection never falls back
 * to managed models, so a refused or exhausted key ends the turn with a typed
 * code. The person is pointed at the screen that fixes it. Every output is a
 * fixed sentence: the provider is recognised only from its stable id, and no
 * server text is ever echoed into the transcript.
 */
import { ROUTES } from "@/lib/navigation/routes";

const BRING_YOUR_OWN_AI = ROUTES.PROFILE_PREFERENCES_GEMINI;
const PROVIDER_NAMES: Readonly<Record<string, string>> = { openai: "OpenAI", gemini: "Gemini" };

const FIXED_MESSAGES: Readonly<Record<string, string>> = {
  AGENT_RUNTIME_CREDENTIAL_MISSING:
    "One needs your Gemini key. Add it in Connections settings, or switch to Hussh managed Gemini.",
  AGENT_RUNTIME_CREDENTIAL_INVALID:
    "Your saved Gemini key could not be used. Update it in Connections settings, or switch to Hussh managed Gemini.",
};

function providerName(message: string): string | null {
  const id = /\b(openai|gemini)\b/i.exec(message)?.[1]?.toLowerCase();
  return id ? PROVIDER_NAMES[id] ?? null : null;
}

export function ownerAiRunErrorMessage(code: string | undefined, message: string): string | null {
  if (!code) return null;
  const fixed = FIXED_MESSAGES[code];
  if (fixed) return fixed;
  const name = providerName(message);
  if (code === "OWNER_AI_KEY_REFUSED") {
    const lead = name ? `${name} did not accept your key.` : "Your AI provider did not accept your key.";
    return `${lead} [Check it in Bring your own AI](${BRING_YOUR_OWN_AI}).`;
  }
  if (code === "OWNER_AI_QUOTA_EXCEEDED") {
    const lead = name ? `Your ${name} key is out of quota.` : "Your own AI key is out of quota.";
    return `${lead} Check your account with the provider, or [change it in Bring your own AI](${BRING_YOUR_OWN_AI}).`;
  }
  return null;
}
