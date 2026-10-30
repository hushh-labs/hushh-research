"use client";

import { claimPhoneForOwner, transferPhoneForOwner } from "./account-phone-claim";
import type { User } from "firebase/auth";
import { getAuthSessionGeneration, snapshotValidatedAuthSessionOwner, snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

import { ApiError, apiJson } from "@/lib/services/api-client";
import { readAccountIdentityResponse } from "@/lib/services/account-identity-response";
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
// keyed by uid and auth generation, so a relogin never joins old work.
const identityRefreshInflight = new Map<string, Promise<AccountIdentity | null>>();
type IdentityWork = { userId: string; generation: number | null; sequence: number };
let identityWorkSequence = 0;
// Publication ordering only; identity records remain in CacheService.
const identityPublications = new Map<string, IdentityWork>();

function beginIdentityWork(userId: string): IdentityWork {
  return { userId, generation: getAuthSessionGeneration(), sequence: ++identityWorkSequence };
}

function ownerForFirebaseUser(user: User | null | undefined): string | null {
  const principal = snapshotValidatedAuthSessionPrincipal();
  return user && principal?.firebaseUid === user.uid ? principal.ownerId : null;
}

function beginUserIdentityWork(user: User | null | undefined): IdentityWork | null {
  const owner = ownerForFirebaseUser(user);
  return owner ? beginIdentityWork(owner) : null;
}

function identityWorkIsCurrent(work: IdentityWork): boolean {
  const published = identityPublications.get(work.userId);
  return identitySessionIsCurrent(work.userId, work.generation) &&
    (!published || published.generation !== work.generation || published.sequence <= work.sequence);
}

function identitySessionIsCurrent(userId: string, generation: number | null): boolean {
  const owner = snapshotValidatedAuthSessionOwner();
  return generation !== null && generation === getAuthSessionGeneration() &&
    (!owner || owner.userId === userId);
}

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
    identity: AccountIdentity | null,
    work?: IdentityWork,
  ): void {
    if (!identity || identity.user_id !== userId || (work && !identityWorkIsCurrent(work))) {
      // Never cache an empty/malformed identity (e.g. `{}` from a failed
      // write). Caching it would clobber a good snapshot with a fresh TTL and
      // re-trigger identity guards (phone mandate) + drop name/email/avatar.
      return;
    }
    if (work) identityPublications.set(userId, work);
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
    const ownerId = ownerForFirebaseUser(user);
    if (!user || !ownerId) {
      return { identity: null, isStale: false };
    }

    const snapshot = this.peekCachedIdentity(ownerId);
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

  static async refreshIdentityForSession(
    userId: string,
    idToken: string,
    options?: { force?: boolean; requireSuccess?: boolean },
  ): Promise<AccountIdentity | null> {
    return this.refreshIdentityWithWork(beginIdentityWork(userId), idToken, options);
  }

  private static async refreshIdentityWithWork(
    work: IdentityWork,
    idToken: string,
    options?: { force?: boolean; requireSuccess?: boolean },
  ): Promise<AccountIdentity | null> {
    if (!identityWorkIsCurrent(work)) return null;
    const response = await ApiService.refreshAccountIdentityShadow(idToken, options);
    const identity = await readAccountIdentityResponse<AccountIdentity>(response, options?.requireSuccess);
    // The caller's owner and a restored global token can diverge during an
    // account switch. Never return or cache another owner's identity.
    if (identity?.user_id !== work.userId || !identityWorkIsCurrent(work)) return null;
    this.cacheIdentity(work.userId, identity, work);
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
    const uid = ownerForFirebaseUser(user);
    if (!uid) return null;
    const requestKey = JSON.stringify([uid, getAuthSessionGeneration()]);

    // Coalesce concurrent non-forced reads onto a single network round-trip.
    if (!force) {
      const existing = identityRefreshInflight.get(requestKey);
      if (existing) {
        return existing;
      }
    }

    const work = beginIdentityWork(uid);
    const run = (async (): Promise<AccountIdentity | null> => {
      // Only force a Firebase token refresh on the write/force path; the
      // read path reuses the cached token to avoid an extra round-trip.
      const idToken = await user.getIdToken(force).catch(() => undefined);
      if (!idToken || !identityWorkIsCurrent(work)) {
        return null;
      }

      return this.refreshIdentityWithWork(work, idToken, options);
    })();

    if (!force) {
      identityRefreshInflight.set(requestKey, run);
      const clearInflight = () => {
        if (identityRefreshInflight.get(requestKey) === run) {
          identityRefreshInflight.delete(requestKey);
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
    const work = beginUserIdentityWork(user);
    if (!work) return null;
    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken || !identitySessionIsCurrent(work.userId, work.generation)) {
      return null;
    }

    const identity = await claimPhoneForOwner(idToken, phoneIdToken, work.userId, () => identitySessionIsCurrent(work.userId, work.generation));
    if (!identity) return null;
    // Write through so guards immediately see the newly verified phone.
    // A committed phone save outranks every read started before it completed,
    // including reads whose caller already timed out.
    work.sequence = ++identityWorkSequence;
    this.cacheIdentity(work.userId, identity, work);
    return identity;
  }

  static async transferCurrentUserPhone(user: User, proof: { token: string; transferId?: string; submitted?: boolean }, isCurrent: () => boolean): Promise<AccountIdentity> {
    const work = beginUserIdentityWork(user);
    const idToken = await user.getIdToken(true);
    const assertCurrent = () => {
      if (!work || !identitySessionIsCurrent(work.userId, work.generation) || !isCurrent())
        throw new Error("Your account changed. Start phone verification again.");
    };
    assertCurrent();
    const result = await transferPhoneForOwner(idToken, proof, work!.userId, assertCurrent);
    work!.sequence = ++identityWorkSequence;
    this.cacheIdentity(work!.userId, result, work!);
    return result;
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
    const work = beginUserIdentityWork(user);
    if (!work) return null;
    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken || !identitySessionIsCurrent(work.userId, work.generation)) {
      return null;
    }
    const { identity } = await ApiService.uploadAvatar(imageDataUrl, idToken);
    if (!identitySessionIsCurrent(work.userId, work.generation) || (identity && identity.user_id !== work.userId)) return null;
    if (!identityWorkIsCurrent(work)) return this.refreshCurrentUserIdentity(user, { force: true });
    if (identity) {
      this.cacheIdentity(work.userId, identity, work);
    } else {
      this.invalidateCachedIdentity(work.userId);
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
    const work = beginUserIdentityWork(user);
    if (!work) return null;
    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken || !identitySessionIsCurrent(work.userId, work.generation)) {
      return null;
    }
    const { identity } = await ApiService.removeAvatar(idToken);
    if (!identitySessionIsCurrent(work.userId, work.generation) || (identity && identity.user_id !== work.userId)) return null;
    if (!identityWorkIsCurrent(work)) return this.refreshCurrentUserIdentity(user, { force: true });
    if (identity) {
      this.cacheIdentity(work.userId, identity, work);
    } else {
      this.invalidateCachedIdentity(work.userId);
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
    const work = beginUserIdentityWork(user);
    if (!work) return null;
    const userId = work.userId;
    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken) {
      throw new ApiError("Sign in again to change your name.", 401);
    }
    if (!identitySessionIsCurrent(work.userId, work.generation)) return null;
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
    if (!identitySessionIsCurrent(userId, work.generation)) return null;
    // The authenticated write response must confirm its own subject before
    // entering an owner-keyed cache or any native/React presentation replica.
    if (
      payload?.success !== true || payload.user_id !== userId ||
      (payload.identity != null && payload.identity.user_id !== userId)
    ) {
      throw new ApiError("Couldn't verify the name change.", 502);
    }
    let identity = payload?.identity ?? null;
    if (!identityWorkIsCurrent(work)) {
      // The mutation still ran. Its delayed full-identity snapshot must not
      // replace a newer phone claim; reconcile with the committed account.
      identity = await this.refreshCurrentUserIdentity(user, { force: true, requireSuccess: true }).catch(() => null);
    } else if (identity) {
      this.cacheIdentity(userId, identity, work);
    } else {
      // The provider accepted the change but the response carried no shadow;
      // fetch the fresh identity rather than leaving a stale name cached.
      this.invalidateCachedIdentity(userId);
      identity = await this.refreshCurrentUserIdentity(user, {
        force: true, requireSuccess: true,
      }).catch(() => null);
    }
    if (!identitySessionIsCurrent(userId, work.generation)) return null;
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
    // Reload the Firebase user so `user.displayName` reflects the new name on
    // every surface that reads it directly from the auth object.
    await user.reload().catch(() => undefined);
    return identitySessionIsCurrent(work.userId, work.generation) ? identity : null;
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

    return ApiService.startUatPhoneTestVerification(phoneNumber, idToken);
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
    const work = beginUserIdentityWork(user);
    if (!work) return null;
    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken || !identitySessionIsCurrent(work.userId, work.generation)) {
      return null;
    }

    const response = await ApiService.confirmUatPhoneTestVerification(
      params.phoneNumber,
      params.verificationCode,
      params.verificationId,
      idToken,
      work.userId
    );
    if (!identitySessionIsCurrent(work.userId, work.generation)) return null;
    const identity = response.identity ?? null;
    if (identity?.user_id !== work.userId) {
      throw new Error("Phone verification could not be completed for this account.");
    }
    work.sequence = ++identityWorkSequence;
    this.cacheIdentity(work.userId, identity, work);
    return identity;
  }

  /** Shared provider-linked finalization. Keep the native-named entrypoint for
   * existing callers; web replacement uses the same exact-phone proof. */
  static async finalizeNativePhoneVerification(
    user: User | null | undefined,
    requestedPhone: string | null | undefined,
  ): Promise<void> {
    const linkedPhone = String(user?.phoneNumber ?? "").trim();
    const expectedPhone = String(requestedPhone ?? "").trim();
    if (!user?.uid || !expectedPhone || linkedPhone !== expectedPhone) {
      throw new Error("Phone verification completed but the linked phone could not be confirmed.");
    }
    const work = beginUserIdentityWork(user);
    if (!work) throw new Error("Verify your account before saving this phone.");
    const token = await user.getIdToken(true);
    if (!identitySessionIsCurrent(work.userId, work.generation)) {
      throw new Error("Your account changed. Please retry phone verification.");
    }
    const response = await ApiService.refreshAccountIdentityShadow(token, {
      force: true,
      requireSuccess: true,
      verifiedPhoneNumber: expectedPhone,
    });
    const identity = await readAccountIdentityResponse<AccountIdentity>(response, true);
    if (
      !identitySessionIsCurrent(work.userId, work.generation) ||
      identity?.user_id !== work.userId ||
      identity.phone_verified !== true ||
      String(identity.phone_number ?? "").trim() !== expectedPhone
    ) {
      throw new Error("Phone verification could not be saved to your account. Please retry or use a different phone number.");
    }
    work.sequence = ++identityWorkSequence;
    this.cacheIdentity(work.userId, identity, work);
  }

  static async syncCurrentUser(
    user: User | null | undefined
  ): Promise<AccountIdentity | null> {
    if (!user) {
      return null;
    }
    const work = beginUserIdentityWork(user);
    if (!work) return null;
    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken || !identityWorkIsCurrent(work)) {
      return null;
    }

    const [, identityResult] = await Promise.allSettled([
      ApiService.createSession({
        userId: work.userId,
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
      const identity = await readAccountIdentityResponse<AccountIdentity>(identityResult.value);
      if (identity?.user_id !== work.userId || !identityWorkIsCurrent(work)) return null;
      this.cacheIdentity(work.userId, identity, work);
      return identity;
    }

    return null;
  }
}
