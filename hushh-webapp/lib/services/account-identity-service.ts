"use client";

import type { User } from "firebase/auth";

import { ApiService, type AccountIdentity } from "@/lib/services/api-service";

export class AccountIdentityService {
  static hasVerifiedPhone(identity: AccountIdentity | null | undefined): boolean {
    return identity?.phone_verified === true;
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
    user: User | null | undefined
  ): Promise<AccountIdentity | null> {
    if (!user) {
      return null;
    }

    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken) {
      return null;
    }

    const response = await ApiService.refreshAccountIdentityShadow(idToken);
    return this.identityFromResponse(response);
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
    return response.identity ?? null;
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
      return this.identityFromResponse(identityResult.value);
    }

    return null;
  }
}
