"use client";

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

const KEY_PREFIX = "vault_quick_unlock_trust_v1";

/**
 * On the phone, the vault gate starts the quick method (Face ID, passkey) by
 * itself only after that method has unlocked the vault once on this device.
 * Until then a cold launch opens on the passphrase form with the quick
 * method one tap away, so a phone that has never held the passkey never
 * sees the system's "sign in another way" sheet at every launch (bug log
 * B38). Founder decision, 2026-09-21. Web keeps the automatic prompt.
 */
export function isQuickUnlockTrustRequired(): boolean {
  return Capacitor.isNativePlatform();
}

export type QuickUnlockTrustRecord = {
  method: string;
  succeeded_at: string;
};

function keyForUser(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export class VaultQuickUnlockTrustLocalService {
  static async load(userId: string): Promise<QuickUnlockTrustRecord | null> {
    try {
      const { value } = await Preferences.get({ key: keyForUser(userId) });
      if (!value) return null;
      const parsed = JSON.parse(value) as QuickUnlockTrustRecord;
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.method !== "string" || typeof parsed.succeeded_at !== "string") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** Record that `method` unlocked (or enrolled) the vault on this device. */
  static async mark(userId: string, method: string): Promise<void> {
    const record: QuickUnlockTrustRecord = {
      method,
      succeeded_at: new Date().toISOString(),
    };
    try {
      await Preferences.set({ key: keyForUser(userId), value: JSON.stringify(record) });
    } catch {
      // A failed write only means the next launch asks once more.
    }
  }

  static async clear(userId: string): Promise<void> {
    try {
      await Preferences.remove({ key: keyForUser(userId) });
    } catch {
      // Nothing to keep.
    }
  }
}
