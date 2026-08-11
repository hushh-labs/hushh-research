"use client";

/**
 * What this person actually does, so search can lead with it.
 *
 * The gateway knows every action in the app; nothing knew which ones YOU use.
 * That is the difference between a command palette and something that has met
 * you before: the same six rows in the same order forever, however many times
 * you have opened Location and never once opened the RIA workspace.
 *
 * Deliberately local and deliberately thin:
 *
 * - **Local only.** This is behavioural data about one person. It stays in
 *   their browser, is keyed per account so a shared device cannot leak one
 *   person's habits into another's suggestions, and never crosses the voice
 *   trust boundary -- the model is told what a screen offers, never what its
 *   owner tends to pick.
 * - **Ids only.** An action id is a generated, public contract name. No slots,
 *   no arguments, no query text: "you analysed a stock" is a habit, "you
 *   analysed NVDA" is a holding.
 * - **Bounded.** A fixed number of entries, pruned by usefulness, so this
 *   cannot grow without limit in storage a person never asked to spend.
 */

const STORAGE_PREFIX = "hushh.action-usage.v1";
/** Entries kept per account. Beyond this the least useful are dropped. */
const MAX_ENTRIES = 40;
/** How many recents the palette offers before it becomes a list of everything. */
export const RECENT_ACTION_LIMIT = 4;
/**
 * A use stops counting toward the habit after this long. Someone who imported
 * a portfolio once in March should not still be told about it in August.
 */
const RECENCY_HORIZON_MS = 1000 * 60 * 60 * 24 * 45;

export type ActionUsageEntry = {
  actionId: string;
  count: number;
  lastUsedAt: number;
};

function storageKey(userId: string | null | undefined): string | null {
  const clean = String(userId || "").trim();
  return clean ? `${STORAGE_PREFIX}.${clean}` : null;
}

function readAll(userId: string | null | undefined): ActionUsageEntry[] {
  const key = storageKey(userId);
  if (!key || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Partial<ActionUsageEntry>;
      const actionId = String(entry.actionId || "").trim();
      const count = Number(entry.count);
      const lastUsedAt = Number(entry.lastUsedAt);
      if (!actionId || !Number.isFinite(count) || !Number.isFinite(lastUsedAt)) {
        return [];
      }
      return [{ actionId, count: Math.max(1, count), lastUsedAt }];
    });
  } catch {
    // Corrupt or unavailable storage is not worth an error path here: the
    // worst case is a palette that has simply not met you yet.
    return [];
  }
}

function writeAll(
  userId: string | null | undefined,
  entries: ActionUsageEntry[],
): void {
  const key = storageKey(userId);
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(entries));
  } catch {
    /* storage full or blocked; usage memory is an enhancement, never required */
  }
}

/**
 * Usefulness, for both ranking and pruning.
 *
 * Frequency alone entrenches whatever you did most last month; recency alone
 * forgets the thing you do every morning because you happened to do something
 * else twice today. Multiplying a log-damped count by a linear recency decay
 * keeps a daily habit ahead of a one-off burst without freezing the list.
 */
function usefulness(entry: ActionUsageEntry, now: number): number {
  const age = Math.max(0, now - entry.lastUsedAt);
  if (age > RECENCY_HORIZON_MS) return 0;
  const recency = 1 - age / RECENCY_HORIZON_MS;
  return Math.log2(entry.count + 1) * recency;
}

/** Record that the person ran `actionId`. Ids only -- never slots. */
export function recordActionUse(
  userId: string | null | undefined,
  actionId: string,
): void {
  const clean = String(actionId || "").trim();
  if (!storageKey(userId) || !clean) return;
  const now = Date.now();
  const entries = readAll(userId);
  const existing = entries.find((entry) => entry.actionId === clean);
  if (existing) {
    existing.count += 1;
    existing.lastUsedAt = now;
  } else {
    entries.push({ actionId: clean, count: 1, lastUsedAt: now });
  }
  const pruned = entries
    .filter((entry) => usefulness(entry, now) > 0 || entry.actionId === clean)
    .sort((left, right) => usefulness(right, now) - usefulness(left, now))
    .slice(0, MAX_ENTRIES);
  writeAll(userId, pruned);
}

/** The person's habits, most useful first. */
export function readActionUsage(
  userId: string | null | undefined,
): ActionUsageEntry[] {
  const now = Date.now();
  return readAll(userId)
    .filter((entry) => usefulness(entry, now) > 0)
    .sort((left, right) => usefulness(right, now) - usefulness(left, now));
}

/**
 * A small ranking bonus for something this person uses, in the same units as
 * `scoreSearchMatch`.
 *
 * Capped deliberately. Habit is a tie-breaker between things that already
 * match what was typed, never a way for a familiar action to outrank a better
 * answer -- typing "circle" must find Create a circle whether or not you have
 * ever created one.
 */
export function usageBoostFor(
  usage: readonly ActionUsageEntry[],
  actionId: string,
): number {
  const now = Date.now();
  const entry = usage.find((item) => item.actionId === actionId);
  if (!entry) return 0;
  return Math.min(3, usefulness(entry, now));
}

/** Forget this account's habits. */
export function clearActionUsage(userId: string | null | undefined): void {
  const key = storageKey(userId);
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}
