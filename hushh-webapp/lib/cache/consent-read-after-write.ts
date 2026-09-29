// Per-user time of the person's own last consent change (approve, deny,
// revoke). CacheSyncService.onConsentMutated records it; the Consent Center
// reads it so a read issued shortly after that change asks the web proxy to
// revalidate (`Cache-Control: no-cache`) instead of accepting its hot entry.
//
// Why a window: the /api/consent/center/{list,summary} proxies keep a 30s hot
// entry per caller, and a load already in flight when the change landed can
// still write the old list, up to its 20s upstream timeout later. Measured on
// localhost 2026-09-28: after Stop sharing, the refetch came back in 17ms from
// that entry and the Active tab kept showing the stopped access on return.
// Outside the window, polls use the proxy cache as before.
//
// Dependency-free on purpose, like pkm-invalidation-epoch.ts. Process memory
// only; it holds no consent content.

export const CONSENT_READ_AFTER_WRITE_WINDOW_MS = 60_000;

const lastConsentMutationAt = new Map<string, number>();

export function noteConsentMutated(
  userId: string,
  nowMs: number = Date.now(),
): void {
  const normalized = String(userId || "").trim();
  if (!normalized) return;
  lastConsentMutationAt.set(normalized, nowMs);
}

export function consentReadNeedsRevalidation(
  userId?: string | null,
  nowMs: number = Date.now(),
): boolean {
  const normalized = String(userId || "").trim();
  if (!normalized) return false;
  const at = lastConsentMutationAt.get(normalized);
  return at !== undefined && nowMs - at < CONSENT_READ_AFTER_WRITE_WINDOW_MS;
}
