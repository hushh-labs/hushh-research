export type ConsentRemoteFallback = () => Promise<boolean>;

export class ConsentCacheManager {
  private readonly consentByUserId = new Map<string, boolean>();

  async verifyConsent(
    userId: string,
    fetchRemoteFallback: ConsentRemoteFallback,
  ): Promise<boolean> {
    const normalizedUserId = userId.trim();

    if (normalizedUserId.length === 0) {
      return false;
    }

    if (this.consentByUserId.has(normalizedUserId)) {
      return this.consentByUserId.get(normalizedUserId) === true;
    }

    const consentState = await fetchRemoteFallback();
    this.consentByUserId.set(normalizedUserId, consentState);
    return consentState;
  }
}

const consentActionAccessCache = new ConsentCacheManager();

export async function verifyLocalConsentActionAccess(
  userId: string,
  vaultOwnerToken: string,
): Promise<boolean> {
  if (vaultOwnerToken.trim().length === 0) {
    return false;
  }

  return consentActionAccessCache.verifyConsent(userId, async () => true);
}
