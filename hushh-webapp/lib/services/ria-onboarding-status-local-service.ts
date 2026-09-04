"use client";

import { Preferences } from "@capacitor/preferences";

import type { RiaOnboardingStatus } from "@/lib/services/ria-service";

// Native-persistent (KV, survives cold relaunch) snapshot of the RIA regulatory
// profile status. Used ONLY as a stale hint to paint the profile/entry surfaces
// instantly on a cold app start before the network/IndexedDB tiers resolve — it
// is never authoritative for gating (always revalidated via SWR). Mirrors
// RiaOnboardingDraftLocalService. On web, @capacitor/preferences falls back to
// localStorage; the IndexedDB device tier is the primary web persistence.
const KEY_PREFIX = "ria_onboarding_status_v1";

function keyForUser(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export class RiaOnboardingStatusLocalService {
  static async load(userId: string): Promise<RiaOnboardingStatus | null> {
    if (!userId) return null;
    try {
      const { value } = await Preferences.get({ key: keyForUser(userId) });
      if (!value) return null;
      return JSON.parse(value) as RiaOnboardingStatus;
    } catch {
      return null;
    }
  }

  static async save(userId: string, status: RiaOnboardingStatus): Promise<void> {
    if (!userId || !status) return;
    try {
      await Preferences.set({
        key: keyForUser(userId),
        value: JSON.stringify(status),
      });
    } catch {
      // Best-effort hint; ignore storage failures.
    }
  }

  static async clear(userId: string): Promise<void> {
    if (!userId) return;
    try {
      await Preferences.remove({ key: keyForUser(userId) });
    } catch {
      // ignore
    }
  }
}
