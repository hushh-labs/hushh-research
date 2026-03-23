"use client";

/**
 * CacheProvider - React context for sharing cached data across components
 *
 * Provides in-memory caching for frequently accessed data:
 * - PKM metadata
 * - Portfolio data
 * - Vault status
 * - Active consents
 *
 * Data is cached on first fetch and shared across page navigations.
 * Invalidation happens on explicit user actions (logout, data clear).
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
  useMemo,
} from "react";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import type { PersonalKnowledgeModelMetadata } from "@/lib/services/personal-knowledge-model-service";

// ==================== Types ====================

export interface VaultStatus {
  totalActive: number;
  total: number;
  domains: Record<string, { fieldCount: number }>;
}

export interface ActiveConsent {
  id: string;
  scope: string;
  developer: string;
  issued_at: number;
  expires_at: number;
  time_remaining_ms: number;
}

export interface PortfolioData {
  account_info?: {
    account_number?: string;
    brokerage_name?: string;
    statement_period?: string;
    account_holder?: string;
  };
  account_summary?: {
    beginning_value?: number;
    ending_value: number;
    change_in_value?: number;
    cash_balance?: number;
    equities_value?: number;
  };
  holdings?: Array<{
    symbol: string;
    name: string;
    quantity: number;
    price: number;
    market_value: number;
    weight_pct?: number;
    cost_basis?: number;
    unrealized_gain_loss?: number;
    unrealized_gain_loss_pct?: number;
    position_side?: "long" | "short" | "liability";
    is_short_position?: boolean;
    is_liability_position?: boolean;
    source_type?: string;
    item_id?: string;
    account_id?: string;
    institution_name?: string;
    last_synced_at?: string;
    is_editable?: boolean;
    sync_status?: string;
  }>;
  source_metadata?: {
    source_type?: string;
    source_label?: string;
    is_editable?: boolean;
    sync_status?: string;
    last_synced_at?: string | null;
    institution_names?: string[];
    item_count?: number;
    account_count?: number;
    requires_explicit_source_selection_for_analysis?: boolean;
  };
   
  [key: string]: any;
}

interface CacheContextType {
  // PKM
  pkmMetadata: PersonalKnowledgeModelMetadata | null;
  setPersonalKnowledgeModelMetadata: (userId: string, data: PersonalKnowledgeModelMetadata) => void;
  getPersonalKnowledgeModelMetadata: (userId: string) => PersonalKnowledgeModelMetadata | null;

  // Portfolio
  portfolioData: PortfolioData | null;
  setPortfolioData: (userId: string, data: PortfolioData) => void;
  getPortfolioData: (userId: string) => PortfolioData | null;

  // Vault Status
  vaultStatus: VaultStatus | null;
  setVaultStatus: (userId: string, data: VaultStatus) => void;
  getVaultStatus: (userId: string) => VaultStatus | null;

  // Active Consents
  activeConsents: ActiveConsent[];
  setActiveConsents: (userId: string, data: ActiveConsent[]) => void;
  getActiveConsents: (userId: string) => ActiveConsent[] | null;

  // Invalidation
  invalidateAll: () => void;
  invalidateUser: (userId: string) => void;
  invalidateDomain: (userId: string, domain: string) => void;

  // Prefetch status
  isPrefetching: boolean;
  setPrefetching: (status: boolean) => void;
}

// ==================== Context ====================

const CacheContext = createContext<CacheContextType | null>(null);

// ==================== Provider ====================

interface CacheProviderProps {
  children: ReactNode;
}

export function CacheProvider({ children }: CacheProviderProps) {
  // Local state for React reactivity (mirrors CacheService for UI updates)
  const [pkmMetadata, setPersonalKnowledgeModelMetadataState] =
    useState<PersonalKnowledgeModelMetadata | null>(null);
  const [portfolioData, setPortfolioDataState] = useState<PortfolioData | null>(
    null
  );
  const [vaultStatus, setVaultStatusState] = useState<VaultStatus | null>(null);
  const [activeConsents, setActiveConsentsState] = useState<ActiveConsent[]>(
    []
  );
  const [isPrefetching, setPrefetching] = useState(false);

  const cache = CacheService.getInstance();

  useEffect(() => {
    const unsubscribe = cache.subscribe((event) => {
      if (event.type === "clear") {
        setPersonalKnowledgeModelMetadataState(null);
        setPortfolioDataState(null);
        setVaultStatusState(null);
        setActiveConsentsState([]);
        return;
      }

      const keys =
        event.type === "invalidate" || event.type === "invalidate_user"
          ? event.keys
          : [];

      if (keys.length === 0) return;

      if (keys.some((key) => key.startsWith("pkm_metadata_"))) {
        setPersonalKnowledgeModelMetadataState(null);
      }

      if (
        keys.some(
          (key) =>
            key.startsWith("portfolio_data_") ||
            (key.startsWith("domain_data_") && key.endsWith("_financial"))
        )
      ) {
        setPortfolioDataState(null);
      }

      if (keys.some((key) => key.startsWith("vault_status_"))) {
        setVaultStatusState(null);
      }

      if (
        keys.some(
          (key) =>
            key.startsWith("active_consents_") ||
            key.startsWith("pending_consents_") ||
            key.startsWith("consent_audit_log_")
        )
      ) {
        setActiveConsentsState([]);
      }
    });

    return unsubscribe;
  }, [cache]);

  // PKM Metadata
  const setPersonalKnowledgeModelMetadata = useCallback(
    (userId: string, data: PersonalKnowledgeModelMetadata) => {
      cache.set(CACHE_KEYS.PKM_METADATA(userId), data, CACHE_TTL.MEDIUM);
      setPersonalKnowledgeModelMetadataState(data);
    },
    [cache]
  );

  const getPersonalKnowledgeModelMetadata = useCallback(
    (userId: string): PersonalKnowledgeModelMetadata | null => {
      const cached = cache.get<PersonalKnowledgeModelMetadata>(
        CACHE_KEYS.PKM_METADATA(userId)
      );
      if (cached && !pkmMetadata) {
        setPersonalKnowledgeModelMetadataState(cached);
      }
      return cached;
    },
    [cache, pkmMetadata]
  );

  // Portfolio Data
  const setPortfolioData = useCallback(
    (userId: string, data: PortfolioData) => {
      // Portfolio data should remain stable for the active session unless explicitly changed.
      cache.set(CACHE_KEYS.PORTFOLIO_DATA(userId), data, CACHE_TTL.SESSION);
      cache.set(CACHE_KEYS.DOMAIN_DATA(userId, "financial"), data, CACHE_TTL.SESSION);
      setPortfolioDataState(data);
    },
    [cache]
  );

  const getPortfolioData = useCallback(
    (userId: string): PortfolioData | null => {
      // Check CacheService (synchronous, always up-to-date)
      const cached =
        cache.get<PortfolioData>(CACHE_KEYS.PORTFOLIO_DATA(userId)) ??
        cache.get<PortfolioData>(CACHE_KEYS.DOMAIN_DATA(userId, "financial"));

      // Update React state if we found data (for reactivity in consuming components)
      if (cached) {
        // Keep canonical portfolio key fresh when data came from domain mirror.
        cache.set(CACHE_KEYS.PORTFOLIO_DATA(userId), cached, CACHE_TTL.SESSION);
        setPortfolioDataState(cached);
      }
      return cached;
    },
    [cache]
  );

  // Vault Status
  const setVaultStatus = useCallback(
    (userId: string, data: VaultStatus) => {
      cache.set(CACHE_KEYS.VAULT_STATUS(userId), data, CACHE_TTL.SHORT);
      setVaultStatusState(data);
    },
    [cache]
  );

  const getVaultStatus = useCallback(
    (userId: string): VaultStatus | null => {
      const cached = cache.get<VaultStatus>(CACHE_KEYS.VAULT_STATUS(userId));
      if (cached && !vaultStatus) {
        setVaultStatusState(cached);
      }
      return cached;
    },
    [cache, vaultStatus]
  );

  // Active Consents
  const setActiveConsents = useCallback(
    (userId: string, data: ActiveConsent[]) => {
      cache.set(CACHE_KEYS.ACTIVE_CONSENTS(userId), data, CACHE_TTL.SHORT);
      setActiveConsentsState(data);
    },
    [cache]
  );

  const getActiveConsents = useCallback(
    (userId: string): ActiveConsent[] | null => {
      const cached = cache.get<ActiveConsent[]>(
        CACHE_KEYS.ACTIVE_CONSENTS(userId)
      );
      if (cached && activeConsents.length === 0) {
        setActiveConsentsState(cached);
      }
      return cached;
    },
    [cache, activeConsents.length]
  );

  // Invalidation
  const invalidateAll = useCallback(() => {
    cache.clear();
    setPersonalKnowledgeModelMetadataState(null);
    setPortfolioDataState(null);
    setVaultStatusState(null);
    setActiveConsentsState([]);
  }, [cache]);

  const invalidateUser = useCallback(
    (userId: string) => {
      cache.invalidateUser(userId);
      setPersonalKnowledgeModelMetadataState(null);
      setPortfolioDataState(null);
      setVaultStatusState(null);
      setActiveConsentsState([]);
    },
    [cache]
  );

  const invalidateDomain = useCallback(
    (userId: string, domain: string) => {
      cache.invalidate(CACHE_KEYS.DOMAIN_DATA(userId, domain));
      // Also invalidate metadata since domain counts may have changed
      cache.invalidate(CACHE_KEYS.PKM_METADATA(userId));
      setPersonalKnowledgeModelMetadataState(null);
      if (domain === "financial") {
        cache.invalidate(CACHE_KEYS.PORTFOLIO_DATA(userId));
        setPortfolioDataState(null);
      }
    },
    [cache]
  );

  const value = useMemo(
    () => ({
      pkmMetadata,
      setPersonalKnowledgeModelMetadata,
      getPersonalKnowledgeModelMetadata,
      portfolioData,
      setPortfolioData,
      getPortfolioData,
      vaultStatus,
      setVaultStatus,
      getVaultStatus,
      activeConsents,
      setActiveConsents,
      getActiveConsents,
      invalidateAll,
      invalidateUser,
      invalidateDomain,
      isPrefetching,
      setPrefetching,
    }),
    [
      pkmMetadata,
      setPersonalKnowledgeModelMetadata,
      getPersonalKnowledgeModelMetadata,
      portfolioData,
      setPortfolioData,
      getPortfolioData,
      vaultStatus,
      setVaultStatus,
      getVaultStatus,
      activeConsents,
      setActiveConsents,
      getActiveConsents,
      invalidateAll,
      invalidateUser,
      invalidateDomain,
      isPrefetching,
    ]
  );

  return (
    <CacheContext.Provider value={value}>{children}</CacheContext.Provider>
  );
}

// ==================== Hook ====================

export function useCache(): CacheContextType {
  const context = useContext(CacheContext);
  if (!context) {
    throw new Error("useCache must be used within CacheProvider");
  }
  return context;
}

// Export for external use
export { CacheContext };
