"use client";

/**
 * Client-side record of an active SOS incident: which grants THIS device
 * created when the alert went out, so the "LIVE LOCATION ACTIVE" banner and the
 * "I'm safe" stop survive a reload.
 *
 * What this record is NOT is the only way to tell an SOS grant from an ordinary
 * one. An earlier version of this comment claimed the server-side `sos_panic`
 * marker was "not exposed via getState/OneLocationGrant"; that was already
 * false, and acting on it would mean re-deriving a workaround for something the
 * API already answers. `_grant_payload` puts `shareKind` on EVERY grant it
 * returns, owner grants included, and `isSmsTriggeredGrant` in
 * `lib/one-location/notifications.ts` is the single client-side reader of it.
 * Use that to ask "is this the SMS share?" -- the two-lane replacement rule the
 * backend now enforces depends on client and server agreeing on that question.
 *
 * What this record still uniquely holds is the SET of grants one particular
 * "hold SOS" produced, which is what makes "I'm safe" tear down exactly what it
 * created and nothing else.
 *
 * Owner scoping: the record carries the signed-in user it belongs to. A shared
 * device (or an account switch without clearing site data) must never show one
 * person's live alert to the next person who signs in, so `loadSosIncident`
 * hands a record back only to the owner it was written for. A record written
 * before owner scoping existed carries no `ownerUserId`; it is returned only to
 * a caller that does not name an owner (a legacy read) and is treated as a
 * mismatch for any owner-scoped read. Nothing is lost by that: the server still
 * holds the SOS grants, `isSmsTriggeredGrant` finds them, and the stop path
 * revokes the union of the record and the live SOS grants.
 *
 * Coordinate-free by construction: only grant ids, an ISO timestamp and the
 * owner's user id are stored.
 */
export type SosIncident = {
  grantIds: string[];
  startedAt: string;
  /** The signed-in user this record belongs to; absent on a legacy record. */
  ownerUserId?: string;
};

const STORAGE_KEY = "one_location_sos_incident_v1";

function readStoredIncident(): SosIncident | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SosIncident> | null;
    if (
      !parsed ||
      !Array.isArray(parsed.grantIds) ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    const owner =
      typeof parsed.ownerUserId === "string" && parsed.ownerUserId.trim()
        ? parsed.ownerUserId.trim()
        : null;
    return {
      grantIds: parsed.grantIds.map((id) => String(id)),
      startedAt: parsed.startedAt,
      ...(owner ? { ownerUserId: owner } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The stored incident for `ownerUserId`, or null.
 *
 * - With an owner: only a record written for that same owner is returned. A
 *   record for another owner, or a legacy record with no owner, is a mismatch.
 * - Without an owner (legacy read): only a legacy record with no owner is
 *   returned; an owner-scoped record is never handed to a caller that has not
 *   said who it is.
 */
export function loadSosIncident(
  ownerUserId?: string | null,
): SosIncident | null {
  const stored = readStoredIncident();
  if (!stored) return null;
  const requested = String(ownerUserId ?? "").trim() || null;
  if (requested) {
    return stored.ownerUserId === requested ? stored : null;
  }
  return stored.ownerUserId ? null : stored;
}

export function saveSosIncident(incident: SosIncident): void {
  if (typeof window === "undefined") return;
  try {
    const owner = String(incident.ownerUserId ?? "").trim();
    const record: SosIncident = {
      grantIds: incident.grantIds.map((id) => String(id)),
      startedAt: incident.startedAt,
      ...(owner ? { ownerUserId: owner } : {}),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* storage unavailable — banner degrades to session-only, sharing still works */
  }
}

export function clearSosIncident(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Whether a server-state snapshot loaded at `stateLoadedAt` (ms since epoch)
 * is recent enough to say which of the incident's grants still exist.
 *
 * - `undefined`: the caller has no freshness information; the snapshot is
 *   taken at face value (the historical behaviour).
 * - `null`: the snapshot is not a fresh load — a memory-only presentation that
 *   outlived an `invalidate()`, or a cache the caller knows to be stale. It
 *   cannot be trusted to list grants created since.
 * - a number: trusted only when it is not older than the incident. A snapshot
 *   read before the alert was armed (Location visited earlier, then armed by
 *   voice from Home) simply does not contain the new grants; pruning against
 *   it would erase the record the publisher bridge just wrote.
 */
export function isSosStateFreshEnough(
  incident: Pick<SosIncident, "startedAt">,
  stateLoadedAt: number | null | undefined,
): boolean {
  if (stateLoadedAt === undefined) return true;
  if (stateLoadedAt === null || !Number.isFinite(stateLoadedAt)) return false;
  const startedAt = Date.parse(incident.startedAt);
  if (!Number.isFinite(startedAt)) return true;
  return stateLoadedAt >= startedAt;
}

/**
 * Keep only grant ids still present in `activeGrantIds`. Returns null when the
 * incident is over (no tracked grants remain active) so callers can drop it.
 *
 * `stateLoadedAt` says when the snapshot behind `activeGrantIds` was loaded
 * (see `isSosStateFreshEnough`); a snapshot that is not fresh enough leaves
 * the incident untouched (same reference) rather than pruning against grants
 * it could not have seen.
 */
export function reconcileSosIncident(
  incident: SosIncident | null,
  activeGrantIds: string[],
  stateLoadedAt?: number | null,
): SosIncident | null {
  if (!incident) return null;
  if (!isSosStateFreshEnough(incident, stateLoadedAt)) return incident;
  const active = new Set(activeGrantIds);
  const grantIds = incident.grantIds.filter((id) => active.has(id));
  if (!grantIds.length) return null;
  if (grantIds.length === incident.grantIds.length) return incident; // unchanged → stable ref
  return { ...incident, grantIds };
}

/**
 * Every grant a stop must revoke: the ids this device recorded for the
 * incident plus every SOS grant the server still holds for the owner
 * (`isSmsTriggeredGrant`), whichever device or voice session created them.
 * Order is the incident's first, then the live grants; duplicates and blank
 * ids are dropped.
 */
export function mergeSosGrantIds(
  incident: Pick<SosIncident, "grantIds"> | null | undefined,
  activeSosGrantIds: readonly string[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of [...(incident?.grantIds ?? []), ...activeSosGrantIds]) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged;
}
