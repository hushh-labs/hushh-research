"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { CacheService } from "@/lib/services/cache-service";

/**
 * The avatar URL to render for the CURRENT user on every surface.
 *
 * Prefers the app-owned effective photo from the account identity (a custom
 * uploaded avatar, or the Firebase mirror when none is set) and falls back to
 * the live Firebase `photoURL`. Subscribes to identity-cache changes so an
 * upload/remove refreshes every avatar surface at once (top bar, profile, …).
 */
export function useEffectiveAvatarUrl(): string | null {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const firebasePhoto = user?.photoURL ?? null;
  const [effective, setEffective] = useState<string | null>(null);

  useEffect(() => {
    if (!uid) {
      setEffective(null);
      return;
    }
    let active = true;
    const read = () => {
      if (!active) return;
      const snap = AccountIdentityService.peekCachedIdentity(uid);
      setEffective(snap?.data?.photo_url ?? null);
    };
    read();
    // Cold/stale cache → SWR fetch, then re-read the populated snapshot.
    void AccountIdentityService.getIdentitySwr(user).then(() => read());
    // Re-read on any identity-cache mutation (peek is O(1); setState bails on an
    // unchanged value). Covers upload/remove write-through updates everywhere.
    const unsubscribe = CacheService.getInstance().subscribe(() => read());
    return () => {
      active = false;
      unsubscribe();
    };
    // Depend on uid only — the Firebase `user` object changes on every token
    // refresh; the fallback is read from `firebasePhoto` at render time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  return effective ?? firebasePhoto;
}
