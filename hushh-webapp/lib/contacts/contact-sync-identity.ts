export const CONTACT_SYNC_SESSION_CHANGED_MESSAGE =
  "Your signed-in account changed. Start contact sync again.";
export const CONTACT_SYNC_PHONE_UNAVAILABLE_MESSAGE =
  "Verify your phone number before syncing contacts.";

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
 * Creates one deterministic phone-resolution barrier for a sync transaction.
 * A missing phone is hydrated once, then the account is checked again before
 * the value is used. Repeated calls reuse that result while still rechecking
 * account ownership, including the call made after a contact source returns.
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
    if (!hydrateAccountPhoneNumber) {
      throw new Error(CONTACT_SYNC_PHONE_UNAVAILABLE_MESSAGE);
    }

    hydrationPromise ??= Promise.resolve(hydrateAccountPhoneNumber()).then(
      (phone) => {
        const normalized = String(phone ?? "").trim();
        return normalized || null;
      },
    );
    const hydratedPhone = await hydrationPromise;
    const latest = getCurrentIdentity();
    const latestPhone = resolveContactSyncAccountPhone({
      initiatingUserId,
      currentUserId: latest.userId,
      accountPhoneNumber: latest.accountPhoneNumber,
    });
    const resolvedPhone = latestPhone ?? hydratedPhone;
    if (!resolvedPhone) {
      // National-format numbers cannot be hashed accurately without an
      // authoritative region. A clear retry is safer than another false zero.
      throw new Error(CONTACT_SYNC_PHONE_UNAVAILABLE_MESSAGE);
    }
    return resolvedPhone;
  };
}
