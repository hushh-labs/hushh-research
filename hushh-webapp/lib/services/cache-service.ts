/**
 * CacheService - Global in-memory cache with TTL support
 *
 * Singleton pattern for caching API responses and computed data.
 * Reduces redundant API calls across page navigations.
 *
 * Usage:
 *   const cache = CacheService.getInstance();
 *   cache.set("key", data, 5 * 60 * 1000); // 5 min TTL
 *   const data = cache.get<MyType>("key");
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export interface CacheSnapshot<T> {
  data: T;
  timestamp: number;
  ttl: number;
  ageMs: number;
  expiresAt: number;
  isFresh: boolean;
  isStale: boolean;
}

type CacheEvent =
  | { type: "set"; key: string }
  | { type: "invalidate"; keys: string[] }
  | { type: "clear" }
  | { type: "invalidate_user"; userId: string; keys: string[] };

type CacheListener = (event: CacheEvent) => void;

// Default TTL: 5 minutes
const DEFAULT_TTL = 5 * 60 * 1000;

class CacheService {
  private cache = new Map<string, CacheEntry<unknown>>();
  private listeners = new Set<CacheListener>();
  private static instance: CacheService | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): CacheService {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();
    }
    return CacheService.instance;
  }

  /**
   * Get cached data if not expired
   */
  get<T>(key: string): T | null {
    const snapshot = this.peek<T>(key);
    if (!snapshot) {
      return null;
    }
    if (snapshot.isStale) {
      this.cache.delete(key);
      return null;
    }
    return snapshot.data;
  }

  /**
   * Inspect a cache entry without invalidating it.
   */
  peek<T>(key: string): CacheSnapshot<T> | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      return null;
    }

    const ageMs = Math.max(0, Date.now() - entry.timestamp);
    const expiresAt = entry.timestamp + entry.ttl;
    const isFresh = ageMs <= entry.ttl;

    return {
      data: entry.data,
      timestamp: entry.timestamp,
      ttl: entry.ttl,
      ageMs,
      expiresAt,
      isFresh,
      isStale: !isFresh,
    };
  }

  /**
   * Set cached data with optional TTL
   */
  set<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttlMs,
    });
    this.emit({ type: "set", key });
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Invalidate a specific key
   */
  invalidate(key: string): void {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.emit({ type: "invalidate", keys: [key] });
    }
  }

  /**
   * Invalidate all keys matching a pattern (prefix match)
   */
  invalidatePattern(pattern: string): void {
    const keysToDelete: string[] = [];

    this.cache.forEach((_, key) => {
      if (key.startsWith(pattern)) {
        keysToDelete.push(key);
      }
    });

    if (keysToDelete.length === 0) return;
    keysToDelete.forEach((key) => this.cache.delete(key));
    this.emit({ type: "invalidate", keys: keysToDelete });
  }

  /**
   * Invalidate a list of keys in one operation.
   */
  invalidateMany(keys: string[]): void {
    if (!keys.length) return;
    const deletedKeys: string[] = [];
    for (const key of keys) {
      if (this.cache.delete(key)) {
        deletedKeys.push(key);
      }
    }
    if (deletedKeys.length > 0) {
      this.emit({ type: "invalidate", keys: deletedKeys });
    }
  }

  /**
   * Invalidate all cache entries scoped to a user.
   * This includes fixed keys + dynamic domain/stock prefixes.
   */
  invalidateUser(userId: string): void {
    const keysToDelete = new Set<string>([
      CACHE_KEYS.PKM_METADATA(userId),
      CACHE_KEYS.PKM_BLOB(userId),
      CACHE_KEYS.PKM_DECRYPTED_BLOB(userId),
      CACHE_KEYS.VAULT_STATUS(userId),
      CACHE_KEYS.VAULT_CHECK(userId),
      CACHE_KEYS.PRE_VAULT_BOOTSTRAP(userId),
      CACHE_KEYS.ACTIVE_CONSENTS(userId),
      CACHE_KEYS.PENDING_CONSENTS(userId),
      CACHE_KEYS.CONSENT_AUDIT_LOG(userId),
      CACHE_KEYS.CONSENT_CENTER(userId, "all"),
      CACHE_KEYS.CONSENT_CENTER_SUMMARY(userId, "investor"),
      CACHE_KEYS.CONSENT_CENTER_SUMMARY(userId, "ria"),
      CACHE_KEYS.PORTFOLIO_DATA(userId),
      CACHE_KEYS.KAI_FINANCIAL_RESOURCE(userId),
      CACHE_KEYS.DEVELOPER_ACCESS(userId),
      CACHE_KEYS.PKM_UPGRADE_STATUS(userId),
      CACHE_KEYS.KAI_PROFILE(userId),
      CACHE_KEYS.ANALYSIS_HISTORY(userId),
      CACHE_KEYS.PERSONA_STATE(userId),
      CACHE_KEYS.RIA_ONBOARDING_STATUS(userId),
      CACHE_KEYS.RIA_ROSTER_SUMMARY(userId),
      CACHE_KEYS.RIA_HOME(userId),
      CACHE_KEYS.RIA_PICKS(userId),
    ]);

    for (const key of this.cache.keys()) {
      if (
        key.startsWith(`pkm_domain_resource_${userId}_`) ||
        key.startsWith(`domain_data_${userId}_`) ||
        key.startsWith(`domain_blob_${userId}_`) ||
        key.startsWith(`stock_context_${userId}_`) ||
        key.startsWith(`kai_market_home_${userId}_`) ||
        key.startsWith(`consent_center_${userId}_`) ||
        key.startsWith(`consent_center_summary_${userId}_`) ||
        key.startsWith(`consent_center_preview_${userId}_`) ||
        key.startsWith(`consent_center_list_${userId}_`) ||
        key.startsWith(`ria_clients_${userId}_`) ||
        key.startsWith(`ria_client_detail_${userId}_`) ||
        key.startsWith(`ria_workspace_${userId}_`) ||
        key.startsWith(`marketplace_rias_`) ||
        key.startsWith(`marketplace_investors_`)
      ) {
        keysToDelete.add(key);
      }
    }

    const deletedKeys: string[] = [];
    for (const key of keysToDelete) {
      if (this.cache.delete(key)) {
        deletedKeys.push(key);
      }
    }

    if (deletedKeys.length > 0) {
      this.emit({ type: "invalidate_user", userId, keys: deletedKeys });
    }
  }

  /**
   * Clear all cached data
   */
  clear(): void {
    if (this.cache.size === 0) return;
    this.cache.clear();
    this.emit({ type: "clear" });
  }

  /**
   * Get cache statistics (for debugging)
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Subscribe to cache lifecycle events.
   * Returns an unsubscribe callback.
   */
  subscribe(listener: CacheListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: CacheEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn("[CacheService] listener error:", error);
      }
    }
  }
}

// Cache key constants for consistency
export const CACHE_KEYS = {
  PKM_METADATA: (userId: string) => `pkm_metadata_${userId}`,
  PKM_BLOB: (userId: string) => `pkm_blob_${userId}`,
  PKM_DECRYPTED_BLOB: (userId: string) => `pkm_decrypted_blob_${userId}`,
  VAULT_STATUS: (userId: string) => `vault_status_${userId}`,
  VAULT_CHECK: (userId: string) => `vault_check_${userId}`,
  PRE_VAULT_BOOTSTRAP: (userId: string) => `pre_vault_bootstrap_${userId}`,
  DEVELOPER_ACCESS: (userId: string) => `developer_access_${userId}`,
  ACTIVE_CONSENTS: (userId: string) => `active_consents_${userId}`,
  PORTFOLIO_DATA: (userId: string) => `portfolio_data_${userId}`,
  KAI_FINANCIAL_RESOURCE: (userId: string) => `kai_financial_resource_${userId}`,
  PKM_DOMAIN_RESOURCE: (userId: string, domain: string, segmentSignature: string) =>
    `pkm_domain_resource_${userId}_${domain}_${segmentSignature}`,
  DOMAIN_DATA: (userId: string, domain: string) => `domain_data_${userId}_${domain}`,
  ENCRYPTED_DOMAIN_BLOB: (userId: string, domain: string) => `domain_blob_${userId}_${domain}`,
  PENDING_CONSENTS: (userId: string) => `pending_consents_${userId}`,
  CONSENT_AUDIT_LOG: (userId: string) => `consent_audit_log_${userId}`,
  CONSENT_CENTER: (userId: string, scopeKey: string) => `consent_center_${userId}_${scopeKey}`,
  CONSENT_CENTER_SUMMARY: (userId: string, actor: string) =>
    `consent_center_summary_${userId}_${actor}`,
  CONSENT_CENTER_PREVIEW: (userId: string, actor: string, surface: string, top: number) =>
    `consent_center_preview_${userId}_${actor}_${surface}_${top}`,
  CONSENT_CENTER_LIST: (
    userId: string,
    actor: string,
    surface: string,
    query: string,
    page: number,
    limit: number
  ) => `consent_center_list_${userId}_${actor}_${surface}_${query}_${page}_${limit}`,
  PERSONA_STATE: (userId: string) => `persona_state_${userId}`,
  RIA_ONBOARDING_STATUS: (userId: string) => `ria_onboarding_status_${userId}`,
  RIA_ROSTER_SUMMARY: (userId: string) => `ria_roster_summary_${userId}`,
  RIA_HOME: (userId: string) => `ria_home_${userId}`,
  RIA_CLIENTS: (userId: string, query: string, status: string, page: number, limit: number) =>
    `ria_clients_${userId}_${query}_${status}_${page}_${limit}`,
  RIA_CLIENT_DETAIL: (userId: string, investorUserId: string) =>
    `ria_client_detail_${userId}_${investorUserId}`,
  RIA_WORKSPACE: (userId: string, investorUserId: string) =>
    `ria_workspace_${userId}_${investorUserId}`,
  RIA_PICKS: (userId: string) => `ria_picks_${userId}`,
  KAI_PROFILE: (userId: string) => `kai_profile_${userId}`,
  ANALYSIS_HISTORY: (userId: string) => `analysis_history_${userId}`,
  PKM_UPGRADE_STATUS: (userId: string) => `pkm_upgrade_status_${userId}`,
  STOCK_CONTEXT: (userId: string, ticker: string) => `stock_context_${userId}_${ticker}`,
  KAI_MARKET_HOME: (
    userId: string,
    symbolsKey: string,
    daysBack: number,
    pickSource: string = "default"
  ) => `kai_market_home_${userId}_${symbolsKey}_${daysBack}_${pickSource}`,
  KAI_DASHBOARD_PROFILE_PICKS: (userId: string, symbolsKey: string, limit: number) =>
    `kai_dashboard_profile_picks_${userId}_${symbolsKey}_${limit}`,
  MARKETPLACE_RIAS_SEARCH: (queryKey: string) => `marketplace_rias_${queryKey}`,
  MARKETPLACE_INVESTORS_SEARCH: (queryKey: string) => `marketplace_investors_${queryKey}`,
} as const;

// TTL constants
export const CACHE_TTL = {
  SHORT: 1 * 60 * 1000, // 1 minute
  MEDIUM: 5 * 60 * 1000, // 5 minutes
  LONG: 15 * 60 * 1000, // 15 minutes
  SESSION: 30 * 60 * 1000, // 30 minutes
} as const;

export { CacheService };
