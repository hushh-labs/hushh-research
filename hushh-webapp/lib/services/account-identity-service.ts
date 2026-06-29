"use client";

import type { User } from "firebase/auth";

import {
  ApiService,
  type AccountIdentity,
  type AccountPhoneTestStartResponse,
} from "@/lib/services/api-service";
import {
  CACHE_KEYS,
  CACHE_TTL,
  CacheService,
  type CacheSnapshot,
} from "@/lib/services/cache-service";

// Stale-while-revalidate dedup for in-flight background identity refreshes,
// keyed by uid, so concurrent guard mounts coalesce onto one network call.
const identityRefreshInflight = new Map<string, Promise<AccountIdentity | null>>();

export class AccountIdentityService {
  static hasVerifiedPhone(identity: AccountIdentity | null | undefined): boolean {
    return identity?.phone_verified === true;
  }

  /**
   * Read the cached identity snapshot without triggering a network call or
   * evicting a stale entry. Lets guards paint the last-known phone status
   * instantly (even if stale) before revalidating in the background.
   */
  static peekCachedIdentity(
    userId: string | null | undefined
  ): CacheSnapshot<AccountIdentity> | null {
    if (!userId) {
      return null;
    }
    return CacheService.getInstance().peek<AccountIdentity>(
      CACHE_KEYS.ACCOUNT_IDENTITY(userId)
    );
  }

  /** Drop the cached identity so the next read fetches fresh. */
  static invalidateCachedIdentity(userId: string | null | undefined): void {
    if (!userId) {
      return;
    }
    CacheService.getInstance().invalidate(CACHE_KEYS.ACCOUNT_IDENTITY(userId));
  }

  /**
   * Seed only the verified-phone hint into a COLD identity cache from an
   * out-of-band source (the combined vault bootstrap call). This lets guards
   * resolve the phone mandate from a single bootstrap request instead of also
   * issuing identity/refresh on cold start.
   *
   * It deliberately never overwrites an existing snapshot, so a richer identity
   * (display name, email, etc.) already in cache is preserved, and a stale-but
   * -present value keeps revalidating through the normal SWR path. A null hint
   * (unknown) is ignored.
   */
  static primeVerifiedPhoneHint(
    userId: string | null | undefined,
    phoneVerified: boolean | null
  ): void {
    if (!userId || phoneVerified === null) {
      return;
    }
    if (this.peekCachedIdentity(userId)) {
      return;
    }
    this.cacheIdentity(userId, {
      user_id: userId,
      phone_verified: phoneVerified,
      source: "vault_bootstrap_hint",
    });
  }

  private static cacheIdentity(
    userId: string,
    identity: AccountIdentity | null
  ): void {
    if (!identity) {
      return;
    }
    CacheService.getInstance().set(
      CACHE_KEYS.ACCOUNT_IDENTITY(userId),
      identity,
      CACHE_TTL.SESSION
    );
  }

  /**
   * Stale-while-revalidate identity read.
   *
   * Returns the cached identity immediately (even when stale) and, when the
   * cache is stale or missing, kicks off a background refresh that updates the
   * cache (CacheService subscribers re-render). The returned promise resolves
   * with the freshest value available without blocking on the network when a
   * cached value exists.
   */
  static async getIdentitySwr(
    user: User | null | undefined
  ): Promise<{ identity: AccountIdentity | null; isStale: boolean }> {
    if (!user?.uid) {
      return { identity: null, isStale: false };
    }

    const snapshot = this.peekCachedIdentity(user.uid);
    if (snapshot) {
      if (snapshot.isStale) {
        // Revalidate in the background; do not await.
        void this.refreshCurrentUserIdentity(user, { force: false });
      }
      return { identity: snapshot.data, isStale: snapshot.isStale };
    }

    // Cold cache: fetch once (read path, non-forced token).
    const identity = await this.refreshCurrentUserIdentity(user, { force: false });
    return { identity, isStale: false };
  }

  private static async identityFromResponse(
    response: Response
  ): Promise<AccountIdentity | null> {
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json().catch(() => null)) as {
      identity?: AccountIdentity | null;
    } | null;
    return payload?.identity ?? null;
  }

  static async refreshCurrentUserIdentity(
    user: User | null | undefined,
    options?: { force?: boolean }
  ): Promise<AccountIdentity | null> {
    if (!user?.uid) {
      return null;
    }

    const force = options?.force === true;
    const uid = user.uid;

    // Coalesce concurrent non-forced reads onto a single network round-trip.
    if (!force) {
      const existing = identityRefreshInflight.get(uid);
      if (existing) {
        return existing;
      }
    }

    const run = (async (): Promise<AccountIdentity | null> => {
      // Only force a Firebase token refresh on the write/force path; the
      // read path reuses the cached token to avoid an extra round-trip.
      const idToken = await user.getIdToken(force).catch(() => undefined);
      if (!idToken) {
        return null;
      }

      const response = await ApiService.refreshAccountIdentityShadow(idToken, options);
      const identity = await this.identityFromResponse(response);
      this.cacheIdentity(uid, identity);
      return identity;
    })();

    if (!force) {
      identityRefreshInflight.set(uid, run);
      void run.finally(() => {
        if (identityRefreshInflight.get(uid) === run) {
          identityRefreshInflight.delete(uid);
        }
      });
    }

    return run;
  }

  static async claimCurrentUserPhone(
    user: User | null | undefined,
    phoneIdToken: string
  ): Promise<AccountIdentity | null> {
    if (!user) {
      return null;
    }

    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken) {
      return null;
    }

    const response = await ApiService.claimAccountPhone(phoneIdToken, idToken);
    const identity = response.identity ?? null;
    // Write through so guards immediately see the newly verified phone.
    this.cacheIdentity(user.uid, identity);
    return identity;
  }

  static async startUatTestPhoneVerification(
    user: User | null | undefined,
    phoneNumber: string
  ): Promise<AccountPhoneTestStartResponse | null> {
    if (!user) {
      return null;
    }

    const idToken = await user.getIdToken().catch(() => undefined);
    if (!idToken) {
      return null;
    }

    return ApiService.startUatPhoneTestVerification(phoneNumber, idToken).catch(
      () => null
    );
  }

  static async confirmUatTestPhoneVerification(
    user: User | null | undefined,
    params: {
      phoneNumber: string;
      verificationCode: string;
      verificationId: string;
    }
  ): Promise<AccountIdentity | null> {
    if (!user) {
      return null;
    }

    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken) {
      return null;
    }

    const response = await ApiService.confirmUatPhoneTestVerification(
      params.phoneNumber,
      params.verificationCode,
      params.verificationId,
      idToken
    );
    const identity = response.identity ?? null;
    this.cacheIdentity(user.uid, identity);
    return identity;
  }

  static async syncCurrentUser(
    user: User | null | undefined
  ): Promise<AccountIdentity | null> {
    if (!user) {
      return null;
    }

    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken) {
      return null;
    }

    const [, identityResult] = await Promise.allSettled([
      ApiService.createSession({
        userId: user.uid,
        email: user.email || "",
        idToken,
        displayName: user.displayName || undefined,
        photoUrl: user.photoURL || undefined,
        emailVerified: user.emailVerified,
        phoneNumber: user.phoneNumber || undefined,
      }),
      ApiService.refreshAccountIdentityShadow(idToken),
    ]);

    if (identityResult.status === "fulfilled") {
      const identity = await this.identityFromResponse(identityResult.value);
      this.cacheIdentity(user.uid, identity);
      return identity;
    }

    return null;
  }
}
