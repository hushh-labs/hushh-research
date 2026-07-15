"use client";

import {
  getLocalItem,
  removeLocalItem,
  setLocalItem,
} from "@/lib/utils/session-storage";

const STORAGE_PREFIX = "hushh.one_setup_complete.v1.";

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

/**
 * User-scoped, positive-only setup admission hint.
 *
 * This contains no journey details or vault material. It only avoids blocking
 * a returning user on a setup check that has already resolved durably. An
 * authoritative incomplete response clears it, and sign-out/account deletion
 * remove it through UserLocalStateService.
 */
export class OneSetupCompletionHintService {
  static isResolved(userId: string): boolean {
    if (!userId) return false;
    return getLocalItem(storageKey(userId)) === "1";
  }

  static markResolved(userId: string): void {
    if (!userId) return;
    setLocalItem(storageKey(userId), "1");
  }

  static clear(userId: string): void {
    if (!userId) return;
    removeLocalItem(storageKey(userId));
  }
}
