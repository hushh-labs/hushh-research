"use client";

/**
 * The Settings writer for the owner's standing style settings. An explicit
 * owner save, encrypted on device, through the coordinator's version guard.
 * Settings saves the full style; chat saves only an explicitly chosen name.
 */
import {
  OWNER_STYLE_DOMAIN,
  OWNER_STYLE_SETTINGS_SOURCE,
  mergeOwnerStyleSettings,
  type OwnerStyleSettings,
} from "@/lib/agent/owner-style-settings";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { mergeCommunicationPreferences } from "@/lib/agent/chat-onboarding/chat-onboarding-preferences";
import { PREFERRED_NAME_MAX, sanitizeStyleText } from "@/lib/agent/owner-style-settings";
import { containsSecretSpan } from "@/lib/pkm/secret-patterns";

/** A live, owner-confirmed name change preserves every other identity setting. */
export async function saveChatPreferredName(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  name: string;
  beforeEffect: () => Promise<void>;
  mayPublish: () => boolean;
}): Promise<boolean> {
  if (!params.name || params.name.length > PREFERRED_NAME_MAX ||
    sanitizeStyleText(params.name) !== params.name || containsSecretSpan(params.name)) return false;
  const savedAt = new Date().toISOString();
  const result = await PkmWriteCoordinator.saveMergedDomain({
    userId: params.userId,
    domain: OWNER_STYLE_DOMAIN,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    beforeEffect: params.beforeEffect,
    mayPublish: params.mayPublish,
    confirmation: { confirmedByUser: true, surface: "chat", source: "one_chat_preferred_name" },
    build: (context) => ({
      domainData: mergeCommunicationPreferences(context.currentDomainData, { name: params.name, tone: null }, savedAt),
      summary: { communication_preferences_updated: true },
    }),
  });
  return result.success;
}

export async function saveOwnerStyleSettings(params: {
  userId: string;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  settings: OwnerStyleSettings;
}): Promise<boolean> {
  const savedAt = new Date().toISOString();
  const result = await PkmWriteCoordinator.saveMergedDomain({
    userId: params.userId,
    domain: OWNER_STYLE_DOMAIN,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    confirmation: {
      confirmedByUser: true,
      surface: "web",
      source: OWNER_STYLE_SETTINGS_SOURCE,
    },
    build: (context) => ({
      domainData: mergeOwnerStyleSettings(context.currentDomainData, params.settings, savedAt),
      // Values stay out of the readable projection, as other identity writes do.
      summary: { communication_preferences_updated: true },
    }),
  });
  return result.success;
}
