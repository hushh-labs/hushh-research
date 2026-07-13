import type { DriveDestination, PlainLocationPoint } from "@/lib/one-location/types";

/**
 * Durable persistence for the owner-side drive/ETA session.
 *
 * The live ETA rides inside each shared point as a `drive` payload, attached by
 * the publisher's watch loop only while the grant is in the in-memory
 * `driveSessionRef`. That ref does NOT survive a page refresh/remount, so
 * without this the ETA silently stops after a refresh (the point keeps updating
 * but loses its ETA). We persist the session and rehydrate it on mount for
 * still-active grants so the watch loop resumes attaching the ETA.
 */

/** Serializable session (persisted to localStorage). */
export type PersistedDriveSession = {
  grantIds: string[];
  destination: DriveDestination;
  etaSeconds: number | null;
  distanceMeters: number | null;
  etaComputedAt: string;
};

/** In-memory session shape (mirrors `driveSessionRef.current`). */
export type DriveSession = {
  grantIds: Set<string>;
  destination: DriveDestination;
  etaSeconds: number | null;
  distanceMeters: number | null;
  etaComputedAt: string;
  lastEtaPoint: PlainLocationPoint | null;
  lastEtaAt: number;
};

function storageKey(userId: string): string {
  return `hushh.one-location.drive-session.${userId}`;
}

function readStore(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export async function saveDriveSession(
  userId: string,
  session: PersistedDriveSession,
): Promise<void> {
  const store = readStore();
  if (!store || !userId) return;
  try {
    store.setItem(storageKey(userId), JSON.stringify(session));
  } catch {
    // best-effort; a failed persist only means ETA won't survive a refresh.
  }
}

export async function loadPersistedDriveSession(
  userId: string,
): Promise<PersistedDriveSession | null> {
  const store = readStore();
  if (!store || !userId) return null;
  try {
    const raw = store.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedDriveSession;
    if (!parsed || !Array.isArray(parsed.grantIds) || !parsed.destination) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearDriveSession(userId: string): Promise<void> {
  const store = readStore();
  if (!store || !userId) return;
  try {
    store.removeItem(storageKey(userId));
  } catch {
    // best-effort
  }
}

/**
 * Rebuild the in-memory session from a persisted one, keeping only grants that
 * are still active. Returns null when there's nothing to restore. The recompute
 * cursor (`lastEtaPoint`/`lastEtaAt`) is reset so the next publish recomputes a
 * fresh ETA, while the last-known ETA is kept so the recipient sees a value
 * immediately after the publisher's refresh. Pure — safe to unit-test.
 */
export function restoreDriveSession(
  persisted: PersistedDriveSession | null,
  activeGrantIds: Set<string>,
): DriveSession | null {
  if (!persisted) return null;
  const stillActive = persisted.grantIds.filter((id) => activeGrantIds.has(id));
  if (stillActive.length === 0) return null;
  return {
    grantIds: new Set(stillActive),
    destination: persisted.destination,
    etaSeconds: persisted.etaSeconds,
    distanceMeters: persisted.distanceMeters,
    etaComputedAt: persisted.etaComputedAt,
    lastEtaPoint: null,
    lastEtaAt: 0,
  };
}
