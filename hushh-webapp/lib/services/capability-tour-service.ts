"use client";

import { Preferences } from "@capacitor/preferences";
import {
  getLocalItem,
  removeLocalItem,
  setLocalItem,
} from "@/lib/utils/session-storage";

/**
 * CapabilityTourService — local-first persistence for "explore-only" capability
 * tours.
 *
 * Some capabilities collect nothing from the user (email, location, consent):
 * the tab is usable the moment it opens. Their "setup" is a one-time look — a
 * first-visit Explore card. This service records WHICH explore-only
 * capabilities a user has explored at least once, so the setup resolver can
 * flip those tiles from "Explore" (actionable) to "Explored" (done).
 *
 * It mirrors `KaiNavTourLocalService`: Capacitor Preferences is the primary
 * store (works on web + native), with a localStorage fallback for environments
 * where Preferences is briefly unavailable. The local copy is the source of
 * truth; the backend pre-vault mirror is a durable, cross-device echo synced
 * separately via `PreVaultUserStateService`.
 */

const KEY_PREFIX = "one_capability_tour_v1";
const VERSION = 1 as const;
const FALLBACK_STORAGE_PREFIX = `${KEY_PREFIX}:fallback`;

export type CapabilityTourLocalState = {
  version: 1;
  exploredIds: string[];
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

function createDefaultState(now?: Date): CapabilityTourLocalState {
  return {
    version: VERSION,
    exploredIds: [],
    updated_at: nowIso(now),
  };
}

function normalizeExploredIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return Array.from(seen).sort();
}

function normalizeState(raw: unknown): CapabilityTourLocalState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const fallback = createDefaultState();
  const updatedAt =
    typeof record.updated_at === "string" && record.updated_at.trim().length > 0
      ? record.updated_at.trim()
      : fallback.updated_at;

  return {
    version: VERSION,
    exploredIds: normalizeExploredIds(record.exploredIds),
    updated_at: updatedAt,
  };
}

async function persist(userId: string, state: CapabilityTourLocalState): Promise<void> {
  const serialized = JSON.stringify(state);
  try {
    await Preferences.set({ key: keyForUser(userId), value: serialized });
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

export class CapabilityTourService {
  static async load(userId: string): Promise<CapabilityTourLocalState | null> {
    try {
      const { value } = await Preferences.get({ key: keyForUser(userId) });
      if (value) return normalizeState(JSON.parse(value));
    } catch {
      // Fall through to the localStorage fallback when Preferences is briefly
      // unavailable; never throw on a read.
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

  /** The set of explore-only capability ids this user has explored once. */
  static async loadExploredIds(userId: string): Promise<string[]> {
    const state = await this.load(userId);
    return state?.exploredIds ?? [];
  }

  /**
   * Record that the user has explored a capability. Idempotent — exploring an
   * already-explored capability only bumps `updated_at`.
   */
  static async markExplored(
    userId: string,
    capabilityId: string,
    now?: Date,
  ): Promise<CapabilityTourLocalState> {
    const current = (await this.load(userId)) ?? createDefaultState(now);
    const explored = new Set(current.exploredIds);
    const trimmed = capabilityId.trim();
    if (trimmed.length > 0) explored.add(trimmed);

    const next: CapabilityTourLocalState = {
      version: VERSION,
      exploredIds: Array.from(explored).sort(),
      updated_at: nowIso(now),
    };

    await persist(userId, next);
    return next;
  }

  /**
   * Replace the local explored set with the authoritative server mirror (used
   * when the backend has a newer, cross-device record). Union semantics: a
   * locally-explored id is never dropped by a stale server snapshot.
   */
  static async mergeFromServer(
    userId: string,
    serverExploredIds: readonly string[],
    now?: Date,
  ): Promise<CapabilityTourLocalState> {
    const current = (await this.load(userId)) ?? createDefaultState(now);
    const merged = new Set(current.exploredIds);
    for (const id of normalizeExploredIds([...serverExploredIds])) merged.add(id);

    const next: CapabilityTourLocalState = {
      version: VERSION,
      exploredIds: Array.from(merged).sort(),
      updated_at: nowIso(now),
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
