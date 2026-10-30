"use client";

import { Preferences } from "@capacitor/preferences";
import {
  getLocalItem,
  removeLocalItem,
  setLocalItem,
} from "@/lib/utils/session-storage";

const KEY_PREFIX = "kai_nav_tour_v1";
const VERSION = 1 as const;
const FALLBACK_STORAGE_PREFIX = `${KEY_PREFIX}:fallback`;

export type KaiNavTourLocalState = {
  version: 1;
  completed_at: string | null;
  skipped_at: string | null;
  synced_to_vault_at: string | null;
  updated_at: string;
};

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function keyForUser(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

function fallbackKeyForUser(userId: string): string {
  return `${FALLBACK_STORAGE_PREFIX}:${userId}`;
}

function createDefaultState(now?: Date): KaiNavTourLocalState {
  const iso = nowIso(now);
  return {
    version: VERSION,
    completed_at: null,
    skipped_at: null,
    synced_to_vault_at: null,
    updated_at: iso,
  };
}

function normalizeState(raw: unknown): KaiNavTourLocalState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const fallback = createDefaultState();

  const normalizeIso = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  return {
    version: VERSION,
    completed_at: normalizeIso(record.completed_at),
    skipped_at: normalizeIso(record.skipped_at),
    synced_to_vault_at: normalizeIso(record.synced_to_vault_at),
    updated_at: normalizeIso(record.updated_at) ?? fallback.updated_at,
  };
}

async function persist(userId: string, state: KaiNavTourLocalState): Promise<void> {
  const serialized = JSON.stringify(state);
  try {
    await Preferences.set({
      key: keyForUser(userId),
      value: serialized,
    });
    setLocalItem(fallbackKeyForUser(userId), serialized);
    return;
  } catch (error) {
    if (typeof window !== "undefined") {
      setLocalItem(fallbackKeyForUser(userId), serialized);
      return;
    }
    throw error;
  }
}

export class KaiNavTourLocalService {
  static async load(userId: string): Promise<KaiNavTourLocalState | null> {
    try {
      const { value } = await Preferences.get({ key: keyForUser(userId) });
      if (value) return normalizeState(JSON.parse(value));
    } catch {
      // Fall through to localStorage fallback on environments where
      // Capacitor Preferences may be temporarily unavailable.
    }

    if (typeof window !== "undefined") {
      try {
        const fallback = getLocalItem(fallbackKeyForUser(userId));
        if (!fallback) return null;
        return normalizeState(JSON.parse(fallback));
      } catch {
        return null;
      }
    }

    return null;
  }

  static async markCompleted(userId: string, now?: Date): Promise<KaiNavTourLocalState> {
    const current = (await this.load(userId)) ?? createDefaultState(now);
    const iso = nowIso(now);

    const next: KaiNavTourLocalState = {
      ...current,
      completed_at: iso,
      skipped_at: null,
      synced_to_vault_at: null,
      updated_at: iso,
    };

    await persist(userId, next);
    return next;
  }

  static async markSkipped(userId: string, now?: Date): Promise<KaiNavTourLocalState> {
    const current = (await this.load(userId)) ?? createDefaultState(now);
    const iso = nowIso(now);

    const next: KaiNavTourLocalState = {
      ...current,
      completed_at: null,
      skipped_at: iso,
      synced_to_vault_at: null,
      updated_at: iso,
    };

    await persist(userId, next);
    return next;
  }

  static async markSynced(userId: string, now?: Date): Promise<KaiNavTourLocalState | null> {
    const current = await this.load(userId);
    if (!current) return null;

    const iso = nowIso(now);
    const next: KaiNavTourLocalState = {
      ...current,
      synced_to_vault_at: iso,
      updated_at: iso,
    };

    await persist(userId, next);
    return next;
  }

  static async clear(userId: string): Promise<void> {
    try {
      await Preferences.remove({ key: keyForUser(userId) });
    } finally {
      removeLocalItem(fallbackKeyForUser(userId));
    }
  }
}
