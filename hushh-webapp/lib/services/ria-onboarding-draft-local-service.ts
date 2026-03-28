"use client";

import { Preferences } from "@capacitor/preferences";

import {
  normalizeRiaOnboardingDraft,
  type RiaOnboardingDraft,
} from "@/lib/ria/ria-onboarding-flow";

const KEY_PREFIX = "ria_onboarding_draft_v1";

function keyForUser(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export class RiaOnboardingDraftLocalService {
  static async load(userId: string): Promise<RiaOnboardingDraft | null> {
    try {
      const { value } = await Preferences.get({ key: keyForUser(userId) });
      if (!value) return null;
      const parsed = JSON.parse(value) as Partial<RiaOnboardingDraft>;
      return normalizeRiaOnboardingDraft(parsed);
    } catch {
      return null;
    }
  }

  static async save(userId: string, draft: RiaOnboardingDraft): Promise<void> {
    await Preferences.set({
      key: keyForUser(userId),
      value: JSON.stringify(normalizeRiaOnboardingDraft(draft)),
    });
  }

  static async clear(userId: string): Promise<void> {
    await Preferences.remove({ key: keyForUser(userId) });
  }
}
