"use client";

import { useCallback, useSyncExternalStore } from "react";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";

/** Presentation only. Execution and placement still require live server authority. */
export function useSharedExperienceRecovery(ownerId: string | null | undefined) {
  const subscribe = useCallback((notify: () => void) => {
    if (!ownerId) return () => undefined;
    const key = CACHE_KEYS.PRE_VAULT_BOOTSTRAP(ownerId);
    return CacheService.getInstance().subscribe((event) => {
      if (event.type === "clear" ||
          ("key" in event && event.key === key) ||
          (event.type === "invalidate" && event.keys.includes(key)) ||
          (event.type === "invalidate_user" && event.userId === ownerId)) notify();
    });
  }, [ownerId]);
  const snapshot = useCallback(() => Boolean(ownerId &&
    PreVaultUserStateService.getCachedBootstrapState(ownerId)?.sharedExperienceRecoveryEnabled === true), [ownerId]);
  const enabled = useSyncExternalStore(subscribe, snapshot, () => false);
  return enabled;
}
