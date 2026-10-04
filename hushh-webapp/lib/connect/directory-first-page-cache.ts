import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import type {
  DirectoryAudience,
  DirectoryPage,
} from "@/lib/services/connections-service";

/**
 * The last People/Advisors first page a person was shown, kept in memory for
 * this session only. It does two jobs:
 *
 * - it paints the list at once on a revisit, and
 * - it stands in for a read the server refuses (rate limit, outage), so the
 *   people already known stay on screen instead of being replaced by an error.
 *
 * Only the empty-query (browse) page is saved. A typed search is deliberate and
 * short-lived, and keeping one per keystroke would only be noise.
 */

/** How long a saved list may stand in for a read the server refused. */
export const DIRECTORY_SAVED_LIST_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * A passive trigger (window focus, reconnect, returning to the app) rereads
 * the directory only once its last read is older than this. Mutations, pushes
 * and explicit actions are not passive and always read.
 */
export const DIRECTORY_PASSIVE_REFRESH_AFTER_MS = 2 * 60 * 1000;

export function saveDirectoryFirstPage(
  userId: string,
  audience: DirectoryAudience,
  page: DirectoryPage,
): void {
  CacheService.getInstance().set(
    CACHE_KEYS.CONNECT_DIRECTORY_FIRST_PAGE(userId, audience),
    page,
    DIRECTORY_SAVED_LIST_KEEP_MS,
  );
}

export function readSavedDirectoryFirstPage(
  userId: string | null | undefined,
  audience: DirectoryAudience,
): DirectoryPage | null {
  if (!userId) return null;
  return CacheService.getInstance().get<DirectoryPage>(
    CACHE_KEYS.CONNECT_DIRECTORY_FIRST_PAGE(userId, audience),
  );
}

/**
 * The server said "slow down", as opposed to "something is broken". Read from
 * the status the request error carries rather than its class, so this stays a
 * leaf with no runtime dependency on the service.
 */
export function isDirectoryRateLimited(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 429
  );
}

/**
 * Pause before the next quiet retry of a refused directory read: 30s, then
 * doubling, capped at five minutes. Each attempt is one cheap read, and the
 * person is never asked to press anything.
 */
export function directoryRetryDelayMs(attempt: number): number {
  return Math.min(5 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempt));
}
