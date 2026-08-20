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
 * Coordinate-free by construction: only grant ids and an ISO timestamp are stored.
 */
export type SosIncident = { grantIds: string[]; startedAt: string };

const STORAGE_KEY = "one_location_sos_incident_v1";

export function loadSosIncident(): SosIncident | null {
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
    return {
      grantIds: parsed.grantIds.map((id) => String(id)),
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

export function saveSosIncident(incident: SosIncident): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(incident));
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
 * Keep only grant ids still present in `activeGrantIds`. Returns null when the
 * incident is over (no tracked grants remain active) so callers can drop it.
 */
export function reconcileSosIncident(
  incident: SosIncident | null,
  activeGrantIds: string[],
): SosIncident | null {
  if (!incident) return null;
  const active = new Set(activeGrantIds);
  const grantIds = incident.grantIds.filter((id) => active.has(id));
  if (!grantIds.length) return null;
  if (grantIds.length === incident.grantIds.length) return incident; // unchanged → stable ref
  return { ...incident, grantIds };
}
