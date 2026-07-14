import type { OneLocationState } from "@/lib/one-location/types";
import {
  CACHE_KEYS,
  CACHE_TTL,
  CacheService,
  type CacheSnapshot,
} from "@/lib/services/cache-service";

/**
 * A memory-only presentation snapshot for the Location workspace.
 *
 * This is deliberately not a durable cache: it never holds a vault owner
 * token, decrypted points, device coordinates, or other local secrets. It
 * gives a same-session route re-entry a usable server-state snapshot while the
 * workspace refreshes its authorization-sensitive state in the background.
 */
export const OneLocationStateResource = {
  key(userId: string): string {
    return CACHE_KEYS.ONE_LOCATION_STATE(userId);
  },

  peek(userId: string): CacheSnapshot<OneLocationState> | null {
    return CacheService.getInstance().peek<OneLocationState>(this.key(userId));
  },

  write(userId: string, state: OneLocationState): void {
    CacheService.getInstance().set(
      this.key(userId),
      state,
      CACHE_TTL.SHORT,
    );
  },

  invalidate(userId: string): void {
    CacheService.getInstance().invalidate(this.key(userId));
  },
};
