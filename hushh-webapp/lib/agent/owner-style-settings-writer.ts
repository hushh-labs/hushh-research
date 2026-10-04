"use client";

/**
 * The Settings writer for the owner's standing style settings. An explicit
 * owner save, encrypted on device, through the coordinator's version guard.
 * Settings is the only caller; chat can only propose (see owner-style-settings.ts).
 */
import {
  OWNER_STYLE_DOMAIN,
  OWNER_STYLE_SETTINGS_SOURCE,
  mergeOwnerStyleSettings,
  type OwnerStyleSettings,
} from "@/lib/agent/owner-style-settings";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

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
