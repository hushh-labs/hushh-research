"use client";

import { Preferences } from "@capacitor/preferences";

const KEY_PREFIX = "vault_method_prompt_v1";

type PromptState = {
  dismissed_for_method: string;
  dismissed_at: string;
  dismissed_for_rp_id?: string;
};

function keyForUser(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export class VaultMethodPromptLocalService {
  static async load(userId: string): Promise<PromptState | null> {
    try {
      const { value } = await Preferences.get({ key: keyForUser(userId) });
      if (!value) return null;
      const parsed = JSON.parse(value) as PromptState;
      if (!parsed || typeof parsed !== "object") return null;
      if (
        typeof parsed.dismissed_for_method !== "string" ||
        typeof parsed.dismissed_at !== "string"
      ) {
        return null;
      }
      if (
        parsed.dismissed_for_rp_id !== undefined &&
        typeof parsed.dismissed_for_rp_id !== "string"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  static async dismiss(
    userId: string,
    method: string,
    rpId?: string
  ): Promise<void> {
    const normalizedRp = rpId?.trim();
    const state: PromptState = {
      dismissed_for_method: method,
      dismissed_at: new Date().toISOString(),
      ...(normalizedRp ? { dismissed_for_rp_id: normalizedRp } : {}),
    };

    await Preferences.set({
      key: keyForUser(userId),
      value: JSON.stringify(state),
    });
  }

  static async clear(userId: string): Promise<void> {
    await Preferences.remove({ key: keyForUser(userId) });
  }
}
