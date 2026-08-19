"use client";

/**
 * Client-side record of the live location shares YOU started.
 *
 * The Location workspace's server-state snapshot is memory-only and expires
 * after a minute (`CACHE_TTL.SHORT`). Leaving /one/location and coming back a
 * few minutes later therefore re-entered the screen with no idea a share was
 * running: the status read as if nothing was live, and the remaining time only
 * reappeared once the network round-trip finished. For a person who deliberately
 * chose "1 hour", that reads as "my share was forgotten".
 *
 * This store closes that gap. It survives route changes, a page reload, and an
 * app relaunch, so the live status can paint on the first frame and keep
 * counting while the authoritative state reconciles in the background.
 *
 * Coordinate-free by construction, exactly like the SOS incident record: grant
 * ids and two timestamps. No names, no coordinates, no vault token. The server
 * remains the authority — {@link reconcileLiveShareEntries} runs on every load
 * and this record never adds a share the backend does not report.
 */

import type { OneLocationGrant } from "@/lib/one-location/types";

export type LiveShareSessionEntry = {
  grantId: string;
  /** When this share started, ISO 8601. */
  startedAt: string;
  /** When it auto-stops, ISO 8601. `null` means "until you stop". */
  expiresAt: string | null;
};

/** The window every currently-live share of yours adds up to. */
export type LiveShareWindow = {
  count: number;
  /** Earliest start across the live shares. */
  startedAt: string;
  /**
   * When you stop being visible to everyone — the LAST expiry, since an earlier
   * one ending does not end the others. `null` when any share runs until you
   * stop it.
   */
  endsAt: string | null;
};

const STORAGE_PREFIX = "one_location_live_share_v1:";

/**
 * An "until you stop" record has no expiry to prune against, so a stale one
 * could otherwise claim you are sharing forever. After a day we stop trusting
 * it for the instant first paint; the server state re-adds it within the same
 * session if the share is genuinely still running. Under-claiming is the safe
 * direction for a privacy status.
 */
const STALE_OPEN_ENDED_MS = 24 * 60 * 60 * 1000;

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function toTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isEntry(value: unknown): value is LiveShareSessionEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<LiveShareSessionEntry>;
  if (typeof entry.grantId !== "string" || !entry.grantId) return false;
  if (typeof entry.startedAt !== "string" || toTime(entry.startedAt) === null) {
    return false;
  }
  if (entry.expiresAt === null || entry.expiresAt === undefined) return true;
  return typeof entry.expiresAt === "string" && toTime(entry.expiresAt) !== null;
}

/** Drop shares that have already ended, plus open-ended records gone stale. */
export function pruneLiveShareEntries(
  entries: LiveShareSessionEntry[],
  nowMs: number,
): LiveShareSessionEntry[] {
  return entries.filter((entry) => {
    const expiresAt = toTime(entry.expiresAt);
    if (expiresAt !== null) return expiresAt > nowMs;
    const startedAt = toTime(entry.startedAt);
    if (startedAt === null) return false;
    return nowMs - startedAt < STALE_OPEN_ENDED_MS;
  });
}

export function loadLiveShareEntries(
  userId: string,
  nowMs: number = Date.now(),
): LiveShareSessionEntry[] {
  if (typeof window === "undefined" || !userId) return [];
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return pruneLiveShareEntries(
      parsed.filter(isEntry).map((entry) => ({
        grantId: entry.grantId,
        startedAt: entry.startedAt,
        expiresAt: entry.expiresAt ?? null,
      })),
      nowMs,
    );
  } catch {
    return [];
  }
}

export function saveLiveShareEntries(
  userId: string,
  entries: LiveShareSessionEntry[],
): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    if (!entries.length) {
      window.localStorage.removeItem(storageKey(userId));
      return;
    }
    window.localStorage.setItem(storageKey(userId), JSON.stringify(entries));
  } catch {
    // Blocked storage only costs the instant first paint on the next visit.
    // Sharing itself, and the countdown for this session, still work.
  }
}

export function clearLiveShareEntries(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.removeItem(storageKey(userId));
  } catch {
    /* ignore */
  }
}

/**
 * Rebuild the record from the grants the backend reports as active.
 *
 * The server owns which shares exist; this record only remembers when each one
 * started, because a grant's `createdAt` is the one field that survives a
 * refresh unchanged and the progress bar needs an origin.
 */
export function reconcileLiveShareEntries(
  previous: LiveShareSessionEntry[],
  activeGrants: OneLocationGrant[],
  nowMs: number = Date.now(),
): LiveShareSessionEntry[] {
  const knownStart = new Map(
    previous.map((entry) => [entry.grantId, entry.startedAt]),
  );
  const nowIso = new Date(nowMs).toISOString();
  const next: LiveShareSessionEntry[] = [];

  for (const grant of activeGrants) {
    if (grant.status !== "active") continue;
    const openEnded = grant.durationMode === "until_stopped";
    const expiresAt = openEnded ? null : (grant.expiresAt ?? null);
    if (!openEnded) {
      const expiryTime = toTime(expiresAt);
      // A timed grant with no usable expiry cannot be counted down, and a
      // finished one must never keep the status alive.
      if (expiryTime === null || expiryTime <= nowMs) continue;
    }
    next.push({
      grantId: grant.id,
      startedAt: knownStart.get(grant.id) ?? grant.createdAt ?? nowIso,
      expiresAt,
    });
  }

  next.sort((a, b) => {
    const left = toTime(a.expiresAt);
    const right = toTime(b.expiresAt);
    if (left === right) return a.grantId.localeCompare(b.grantId);
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right;
  });
  return next;
}

export function liveShareEntriesEqual(
  a: LiveShareSessionEntry[],
  b: LiveShareSessionEntry[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      Boolean(other) &&
      entry.grantId === other?.grantId &&
      entry.startedAt === other?.startedAt &&
      entry.expiresAt === other?.expiresAt
    );
  });
}

/** Collapse the live shares into the one window the status card renders. */
export function summarizeLiveShareEntries(
  entries: LiveShareSessionEntry[],
): LiveShareWindow | null {
  if (!entries.length) return null;

  let startedAt = entries[0]?.startedAt ?? new Date().toISOString();
  let earliestStart = toTime(startedAt) ?? Number.POSITIVE_INFINITY;
  let endsAt: string | null = null;
  let latestEnd = Number.NEGATIVE_INFINITY;
  let openEnded = false;

  for (const entry of entries) {
    const start = toTime(entry.startedAt);
    if (start !== null && start < earliestStart) {
      earliestStart = start;
      startedAt = entry.startedAt;
    }
    if (entry.expiresAt === null) {
      openEnded = true;
      continue;
    }
    const end = toTime(entry.expiresAt);
    if (end !== null && end > latestEnd) {
      latestEnd = end;
      endsAt = entry.expiresAt;
    }
  }

  return {
    count: entries.length,
    startedAt,
    endsAt: openEnded ? null : endsAt,
  };
}
