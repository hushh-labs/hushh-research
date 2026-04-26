"use client";

import type { User } from "firebase/auth";

import { ApiService } from "@/lib/services/api-service";

export class AccountIdentityService {
  static async syncCurrentUser(user: User | null | undefined): Promise<void> {
    if (!user) {
      return;
    }

    const idToken = await user.getIdToken(true).catch(() => undefined);
    if (!idToken) {
      return;
    }

    await Promise.allSettled([
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
  }
}
