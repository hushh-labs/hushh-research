/**
 * One consent version shared by every surface that initializes Google Maps.
 * A renderer may receive coordinates only after the owner accepts this version.
 */
export const GOOGLE_MAPS_RENDERER_CONSENT_VERSION = "google-maps-renderer-v1";

/**
 * Local mirror of a previously-accepted renderer consent, so a returning
 * owner's map can start initializing on open instead of blocking on a
 * network round-trip to re-confirm consent it already gave. The network
 * check still runs in the background and is authoritative; this cache only
 * removes the wait before that check resolves.
 */
const ACCEPTED_CONSENT_PREFIX = "one_location_map_renderer_consent_v1:";

function acceptedConsentKey(userId: string): string {
  return `${ACCEPTED_CONSENT_PREFIX}${userId}`;
}

export function readCachedRendererConsentAccepted(
  userId: string | null | undefined,
): boolean {
  if (!userId || typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(acceptedConsentKey(userId)) ===
      GOOGLE_MAPS_RENDERER_CONSENT_VERSION
    );
  } catch {
    return false;
  }
}

export function writeCachedRendererConsentAccepted(
  userId: string | null | undefined,
  accepted: boolean,
): void {
  if (!userId || typeof window === "undefined") return;
  try {
    if (accepted) {
      window.localStorage.setItem(
        acceptedConsentKey(userId),
        GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
      );
    } else {
      window.localStorage.removeItem(acceptedConsentKey(userId));
    }
  } catch {
    // Best-effort: the in-memory acceptance for this session still applies.
  }
}

export function forgetCachedRendererConsent(
  userId: string | null | undefined,
): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(acceptedConsentKey(userId));
  } catch {
    // Best-effort account-deletion cleanup for restricted browser storage.
  }
}
