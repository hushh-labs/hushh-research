"use client";

/**
 * Client-side record of an active SOS incident. The grant `metadata.reason`
 * ("sos_panic") is written server-side but NOT exposed via getState/OneLocationGrant,
 * so we persist the incident (its grant ids + start time) here to drive the
 * "LIVE LOCATION ACTIVE" banner and the "I'm safe" stop across reloads.
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
  return grantIds.length ? { ...incident, grantIds } : null;
}
