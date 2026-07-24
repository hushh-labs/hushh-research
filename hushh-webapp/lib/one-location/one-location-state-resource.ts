import type { OneLocationState } from "@/lib/one-location/types";
import {
  CACHE_KEYS,
  CACHE_TTL,
  CacheService,
  type CacheSnapshot,
} from "@/lib/services/cache-service";

const inFlightByUser = new Map<
  string,
  { revision: number; request: Promise<OneLocationState> }
>();
const revisionByUser = new Map<string, number>();

function revisionFor(userId: string): number {
  return revisionByUser.get(userId) ?? 0;
}

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
    CacheService.getInstance().set(this.key(userId), state, CACHE_TTL.SHORT);
  },

  replaceSmsContactUserIds(userId: string, userIds: string[]): boolean {
    const snapshot = this.peek(userId);
    if (!snapshot) return false;

    const smsContactUserIds = Array.from(
      new Set(
        userIds.map((value) => String(value || "").trim()).filter(Boolean),
      ),
    );
    // Invalidate first so a slower pre-mutation state request cannot overwrite
    // the authoritative membership returned by the Add/Remove API.
    this.invalidate(userId);
    this.write(userId, {
      ...snapshot.data,
      smsContactUserIds,
    });
    return true;
  },

  load(
    userId: string,
    loader: () => Promise<OneLocationState>,
  ): Promise<OneLocationState> {
    const revision = revisionFor(userId);
    const existing = inFlightByUser.get(userId);
    if (existing?.revision === revision) return existing.request;

    const request = loader()
      .then((state) => {
        if (revisionFor(userId) === revision) this.write(userId, state);
        return state;
      })
      .finally(() => {
        if (inFlightByUser.get(userId)?.request === request) {
          inFlightByUser.delete(userId);
        }
      });
    inFlightByUser.set(userId, { revision, request });
    return request;
  },

  invalidate(userId: string): void {
    revisionByUser.set(userId, revisionFor(userId) + 1);
    inFlightByUser.delete(userId);
    CacheService.getInstance().invalidate(this.key(userId));
  },
};
