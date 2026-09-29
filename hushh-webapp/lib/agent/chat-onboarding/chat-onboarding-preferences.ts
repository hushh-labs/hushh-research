"use client";

/**
 * Saves the onboarding answers the person confirmed (what to call them, how
 * One should talk) to their encrypted memory.
 *
 * This is a typed structured write through `PkmWriteCoordinator` (client-side
 * encryption, optimistic version guard with conflict retry), the same path the
 * identity onboarding uses. It deliberately does not use
 * `prepareNaturalLanguagePkm`: structured writers must not send decrypted
 * domain data back through a model.
 *
 * The values land in `identity.communication_preferences`, which the per-turn
 * memory packet renders as "Identity > Communication Preferences > ...", and
 * One's authored instruction ("How to speak") treats as a style preference.
 */
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  CHAT_ONBOARDING_TONE_LABEL,
  type ChatOnboardingTone,
} from "@/lib/agent/chat-onboarding/chat-onboarding-script";

export const CHAT_ONBOARDING_PKM_DOMAIN = "identity" as const;
export const COMMUNICATION_PREFERENCES_BRANCH = "communication_preferences" as const;

/** Phrased as a style preference, because the packet shows the value verbatim. */
export const REPLY_STYLE_TEXT: Record<ChatOnboardingTone, string> = {
  short_direct: "Short and direct replies",
  detailed: "Detailed replies",
  casual: "Casual, conversational replies",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Merge confirmed answers into the existing branch. Only supplied answers are
 * written; an absent answer never clears a value saved earlier.
 */
export function mergeCommunicationPreferences(
  currentDomainData: Record<string, unknown> | null | undefined,
  answers: { name: string | null; tone: ChatOnboardingTone | null },
  savedAt: string,
): Record<string, unknown> {
  const current = asRecord(currentDomainData);
  return {
    ...current,
    [COMMUNICATION_PREFERENCES_BRANCH]: {
      ...asRecord(current[COMMUNICATION_PREFERENCES_BRANCH]),
      ...(answers.name ? { preferred_name: answers.name } : {}),
      ...(answers.tone ? { reply_style: REPLY_STYLE_TEXT[answers.tone] } : {}),
      updated_at: savedAt,
    },
  };
}

export async function saveChatOnboardingPreferences(params: {
  userId: string;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  name: string | null;
  tone: ChatOnboardingTone | null;
}): Promise<boolean> {
  if (!params.name && !params.tone) return true;
  if (params.tone && !(params.tone in CHAT_ONBOARDING_TONE_LABEL)) return false;
  const savedAt = new Date().toISOString();
  const result = await PkmWriteCoordinator.saveMergedDomain({
    userId: params.userId,
    domain: CHAT_ONBOARDING_PKM_DOMAIN,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    confirmation: {
      confirmedByUser: true,
      surface: "chat",
      source: "one_chat_onboarding",
    },
    build: (context) => ({
      domainData: mergeCommunicationPreferences(
        context.currentDomainData,
        { name: params.name, tone: params.tone },
        savedAt,
      ),
      // Keep the values out of the readable projection, as identity writes do.
      summary: { communication_preferences_updated: true },
    }),
  });
  return result.success;
}
