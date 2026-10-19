"use client";

import type { User } from "firebase/auth";

import { ApiError, apiJson } from "@/lib/services/api-client";
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
    if (!identity || !identity.user_id) {
      // Never cache an empty/malformed identity (e.g. `{}` from a failed
      // write). Caching it would clobber a good snapshot with a fresh TTL and
      // re-trigger identity guards (phone mandate) + drop name/email/avatar.
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

  static async refreshIdentityForSession(
    userId: string,
    idToken: string,
    options?: { force?: boolean; requireSuccess?: boolean },
  ): Promise<AccountIdentity | null> {
    const response = await ApiService.refreshAccountIdentityShadow(idToken, options);
    const identity = await this.identityFromResponse(response);
    // The caller's owner and a restored global token can diverge during an
    // account switch. Never return or cache another owner's identity.
    if (identity?.user_id !== userId) return null;
    this.cacheIdentity(userId, identity);
    return identity;
  }

  static async refreshCurrentUserIdentity(
    user: User | null | undefined,
    options?: { force?: boolean; requireSuccess?: boolean }
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

      return this.refreshIdentityForSession(uid, idToken, options);
    })();

    if (!force) {
      identityRefreshInflight.set(uid, run);
      const clearInflight = () => {
        if (identityRefreshInflight.get(uid) === run) {
          identityRefreshInflight.delete(uid);
        }
      };
      // Give both branches an explicit handler. `void run.finally(...)`
      // creates a second rejected promise when the request fails, even when
      // the original caller correctly catches `run`.
      void run.then(clearInflight, clearInflight);
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

    const response = await ApiService.claimAccountPhone(phoneIdToken, idToken, user.uid);
    const identity = response.identity ?? null;
    if (identity?.user_id !== user.uid) {
      throw new Error("Phone verification could not be completed for this account.");
    }
    // Write through so guards immediately see the newly verified phone.
    this.cacheIdentity(user.uid, identity);
    return identity;
  }

  /**
   * Upload a user-chosen profile picture (a small square data-URL). Writes the
   * fresh identity through to cache so every avatar surface updates at once.
   */
  static async uploadAvatar(
    user: User | null | undefined,
    imageDataUrl: string
  ): Promise<AccountIdentity | null> {
    if (!user?.uid) {
      return null;
    }
    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken) {
      return null;
    }
    const { identity } = await ApiService.uploadAvatar(imageDataUrl, idToken);
    if (identity) {
      this.cacheIdentity(user.uid, identity);
    } else {
      this.invalidateCachedIdentity(user.uid);
    }
    return identity;
  }

  /** Remove the custom profile picture (revert to the Firebase photo). */
  static async removeAvatar(
    user: User | null | undefined
  ): Promise<AccountIdentity | null> {
    if (!user?.uid) {
      return null;
    }
    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken) {
      return null;
    }
    const { identity } = await ApiService.removeAvatar(idToken);
    if (identity) {
      this.cacheIdentity(user.uid, identity);
    } else {
      this.invalidateCachedIdentity(user.uid);
    }
    return identity;
  }

  /**
   * Change the person's own Hussh display name.
   *
   * PATCH /api/account/identity/display-name with the Firebase bearer. The
   * server validates (2-60 chars, no links or handles), writes the name at
   * Firebase Auth, re-syncs the identity shadow, and returns the refreshed
   * identity. The cache is written through from that RETURNED identity (never
   * the input) and the Firebase user is reloaded so `user.displayName` agrees.
   *
   * Errors propagate as `ApiError` so callers can show the server's message:
   * 422 `DISPLAY_NAME_INVALID` (inline), 503 `IDENTITY_PROVIDER_UNAVAILABLE`.
   */
  static async updateDisplayName(
    user: User | null | undefined,
    displayName: string
  ): Promise<AccountIdentity | null> {
    if (!user?.uid) {
      return null;
    }
    const userId = user.uid;
    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken) {
      throw new ApiError("Sign in again to change your name.", 401);
    }
    const payload = await apiJson<{
      success?: boolean;
      user_id?: string;
      identity?: AccountIdentity | null;
      display_name?: string | null;
      shadow_sync?: "pending" | "synced";
    }>("/api/account/identity/display-name", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ display_name: displayName }),
    });
    // The authenticated write response must confirm its own subject before
    // entering an owner-keyed cache or any native/React presentation replica.
    if (
      payload?.success !== true || payload.user_id !== userId ||
      (payload.identity != null && payload.identity.user_id !== userId)
    ) {
      throw new ApiError("Couldn't verify the name change.", 502);
    }
    let identity = payload?.identity ?? null;
    if (identity) {
      this.cacheIdentity(userId, identity);
    } else {
      // The provider accepted the change but the response carried no shadow;
      // fetch the fresh identity rather than leaving a stale name cached.
      this.invalidateCachedIdentity(userId);
      identity = await this.refreshCurrentUserIdentity(user, {
        force: true, requireSuccess: true,
      }).catch(() => null);
      // The provider already committed this exact returned value. A failed or
      // lagging shadow read must not turn that write into a failed save. This
      // partial presentation result is never written to the identity cache.
      const committedName =
        typeof payload.display_name === "string" ? payload.display_name.trim() : "";
      if (
        payload.shadow_sync === "pending" && committedName &&
        identity?.display_name !== committedName
      ) {
        this.invalidateCachedIdentity(userId);
        identity = { user_id: userId, display_name: committedName };
      }
    }
    // Reload the Firebase user so `user.displayName` reflects the new name on
    // every surface that reads it directly from the auth object.
    await user.reload().catch(() => undefined);
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
      idToken,
      user.uid
    );
    const identity = response.identity ?? null;
    if (identity?.user_id !== user.uid) {
      throw new Error("Phone verification could not be completed for this account.");
    }
    this.cacheIdentity(user.uid, identity);
    return identity;
  }

  static async finalizeNativePhoneVerification(
    user: User | null | undefined,
    requestedPhone: string | null | undefined,
  ): Promise<void> {
    const linkedPhone = String(user?.phoneNumber ?? "").trim();
    const expectedPhone = String(requestedPhone ?? "").trim();
    if (!user?.uid || !expectedPhone || linkedPhone !== expectedPhone) {
      throw new Error("Phone verification completed but the linked phone could not be confirmed.");
    }
    const identity = await this.refreshCurrentUserIdentity(user, {
      force: true,
      requireSuccess: true,
    });
    if (
      identity?.user_id !== user.uid ||
      identity.phone_verified !== true ||
      String(identity.phone_number ?? "").trim() !== expectedPhone
    ) {
      throw new Error("Phone verification could not be saved to your account. Please retry or use a different phone number.");
    }
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
