// Browser layout fixture replaces cache side-effect ports, not UI/crypto.
import { CacheService, CACHE_KEYS } from "../../lib/services/cache-service";

export const CacheSyncService = {
  onDirectMessagesMutated(userId: string) {
    CacheService.getInstance().invalidateMany([
      CACHE_KEYS.DIRECT_MESSAGE_THREADS(userId), CACHE_KEYS.DIRECT_MESSAGE_SESSION(userId),
    ]);
  },
  onFeedChanged() {},
  onFeedHistoryMutated() {},
  onFeedExternalReadChanged() {},
  onOneLocationStateMutated() {},
};
