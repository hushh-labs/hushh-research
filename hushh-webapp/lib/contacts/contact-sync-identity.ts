export const CONTACT_SYNC_SESSION_CHANGED_MESSAGE =
  "Your signed-in account changed. Start contact sync again.";

/**
 * Returns the latest verified account phone only while the sync still belongs
 * to the account that opened the contact/Google picker. This prevents a slow
 * picker from sending one person's contact digests with another person's auth.
 */
export function resolveContactSyncAccountPhone({
  initiatingUserId,
  currentUserId,
  accountPhoneNumber,
}: {
  initiatingUserId?: string | null;
  currentUserId?: string | null;
  accountPhoneNumber?: string | null;
}): string | null {
  if ((currentUserId ?? null) !== (initiatingUserId ?? null)) {
    throw new Error(CONTACT_SYNC_SESSION_CHANGED_MESSAGE);
  }
  const phone = String(accountPhoneNumber ?? "").trim();
  return phone || null;
}

/**
 * Resolves an optional normalization hint, never a second phone verification.
 * A missing phone is hydrated once, then account ownership is checked again.
 * Missing/failed hydration is not evidence that signup verification is missing;
 * the backend remains responsible for authorizing contact discovery. Callers
 * must avoid guessing a national number's region when this returns null.
 */
export function createContactSyncAccountPhoneResolver({
  initiatingUserId,
  getCurrentIdentity,
  hydrateAccountPhoneNumber,
}: {
  initiatingUserId?: string | null;
  getCurrentIdentity: () => {
    userId?: string | null;
    accountPhoneNumber?: string | null;
  };
  hydrateAccountPhoneNumber?: () => Promise<string | null | undefined>;
}): () => Promise<string | null> {
  let hydrationPromise: Promise<string | null> | null = null;

  return async () => {
    const current = getCurrentIdentity();
    const currentPhone = resolveContactSyncAccountPhone({
      initiatingUserId,
      currentUserId: current.userId,
      accountPhoneNumber: current.accountPhoneNumber,
    });
    if (currentPhone) return currentPhone;
    if (!hydrateAccountPhoneNumber) return null;

    hydrationPromise ??= (async () => {
      try {
        const phone = await hydrateAccountPhoneNumber();
        const normalized = String(phone ?? "").trim();
        return normalized || null;
      } catch {
        return null;
      }
    })();
    const hydratedPhone = await hydrationPromise;
    const latest = getCurrentIdentity();
    const latestPhone = resolveContactSyncAccountPhone({
      initiatingUserId,
      currentUserId: latest.userId,
      accountPhoneNumber: latest.accountPhoneNumber,
    });
    return latestPhone ?? hydratedPhone;
  };
}
