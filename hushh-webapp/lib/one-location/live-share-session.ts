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

import {
  normalizeOneLocationShareKind,
  type OneLocationShareKind,
} from "@/lib/one-location/notifications";
import type { OneLocationGrant } from "@/lib/one-location/types";

export type LiveShareSessionEntry = {
  grantId: string;
  /**
   * Who can see you through this grant.
   *
   * A pair can hold TWO live grants at once -- one ordinary share and one SOS
   * -- so a grant is no longer a person. The count in {@link LiveShareWindow}
   * is a headcount, and a headcount needs the head.
   *
   * Still identity-free by the standard this file sets: an opaque user id the
   * device already holds, never a name, never a number.
   */
  recipientUserId: string;
  /**
   * Which replacement lane this share belongs to. Normalized to the same four
   * kinds the rest of the client uses, from the `shareKind` the server puts on
   * every grant -- so "is this the SMS one?" is answered here exactly as
   * `isSmsTriggeredGrant` answers it everywhere else.
   */
  shareKind: OneLocationShareKind;
  /** When this share started, ISO 8601. */
  startedAt: string;
  /** When it auto-stops, ISO 8601. `null` means "until you stop". */
  expiresAt: string | null;
};

/** The window every currently-live share of yours adds up to. */
export type LiveShareWindow = {
  /**
   * How many PEOPLE can see you -- distinct recipients, not grants. One person
   * holding both an ordinary share and an SOS share is one person, and saying
   * "2 people" for a pair of shares to the same friend is simply wrong.
   */
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
  // `recipientUserId`/`shareKind` are deliberately NOT required here. Records
  // written by a build from before this change are still perfectly good
  // countdowns, and refusing them would blank a running share's first paint
  // on the very upgrade that introduced the fields. They are normalized on
  // read instead, and the server reconciliation fills them in within a second.
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
        recipientUserId:
          typeof entry.recipientUserId === "string" ? entry.recipientUserId : "",
        shareKind: normalizeOneLocationShareKind(entry.shareKind),
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
      recipientUserId: grant.recipientUserId ?? "",
      shareKind: normalizeOneLocationShareKind(grant.shareKind),
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
      entry.recipientUserId === other?.recipientUserId &&
      entry.shareKind === other?.shareKind &&
      entry.startedAt === other?.startedAt &&
      entry.expiresAt === other?.expiresAt
    );
  });
}

/**
 * A stable grouping key for "which person is this share pointing at".
 *
 * Records written before recipient ids were stored have none. Such an entry
 * becomes its own person rather than silently merging into somebody else's
 * row -- over-counting for the second it takes the server state to reconcile,
 * which is the safe direction for a privacy status.
 */
function recipientKey(entry: LiveShareSessionEntry, index: number): string {
  return entry.recipientUserId || `grant:${entry.grantId || index}`;
}

/**
 * The one grant the hero card's Stop (and its duration editor) may act on.
 *
 * The rule was "exactly one live entry", which read a GRANT count as a PERSON
 * count. Once an ordinary share and an SOS share to the same person can both be
 * live, that silently returned `null` for a single friend -- taking away the
 * owner's Stop button and their end-time editor at the exact moment they had
 * the most sharing running.
 *
 * The rule is a headcount now. With more than one person there is still no
 * single share to end, so the card keeps offering Manage. With one person the
 * ORDINARY share is what this resolves to: the SMS-lane share has its own Stop
 * on the SOS screen, ending it is a distinct decision ("I'm safe") from ending
 * a normal share, and after the two-lane split neither one stops the other.
 * When the SOS share is the only thing running it resolves to that, which is
 * exactly what happened before.
 */
export function resolveStoppableGrantId(
  entries: LiveShareSessionEntry[],
): string | null {
  if (!entries.length) return null;
  const people = new Set(entries.map(recipientKey));
  if (people.size !== 1) return null;

  const ordinary = entries.filter((entry) => entry.shareKind !== "sos");
  const candidates = ordinary.length ? ordinary : entries;
  // Same-lane replacement still guarantees one live grant per lane per pair, so
  // this is a belt-and-braces refusal: given an ambiguity that should not exist,
  // offer Manage rather than guess which share a tap meant to end.
  if (candidates.length !== 1) return null;
  return candidates[0]?.grantId ?? null;
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

  // Count is per PERSON; time is per EXPOSURE. Only the headcount collapses to
  // distinct recipients -- the start/end fold above deliberately ran over EVERY
  // entry, because `endsAt` is documented as "when you stop being visible to
  // everyone". Dropping a duplicate recipient's second grant to dedupe would
  // render a 1-hour share plus an 8-hour SOS to one person as "ends in 1 hour"
  // while the owner stays visible for eight: under-claiming your own exposure,
  // which is the one direction this file must never round.
  //
  // An entry restored from a record written before recipient ids were stored
  // has no id to group on. It counts as its own person rather than silently
  // merging into somebody else's row -- over-counting for the second it takes
  // the server to reconcile, which is the safe direction for a privacy status.
  const people = new Set(entries.map(recipientKey));

  return {
    count: people.size,
    startedAt,
    endsAt: openEnded ? null : endsAt,
  };
}
