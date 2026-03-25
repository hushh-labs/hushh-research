import type { PortfolioData } from "@/lib/cache/cache-context";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import type { PersonalKnowledgeModelMetadata } from "@/lib/services/personal-knowledge-model-service";
import { removeSessionItemsByPrefix } from "@/lib/utils/session-storage";

type DomainSummaryPatch = Record<string, unknown>;

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function deriveAttributeCount(
  domainSummary: DomainSummaryPatch | undefined,
  portfolioData: PortfolioData | undefined
): number {
  const candidates = [
    domainSummary?.attribute_count,
    domainSummary?.holdings_count,
    domainSummary?.item_count,
  ];
  for (const candidate of candidates) {
    const parsed = toNumber(candidate);
    if (parsed !== null && parsed >= 0) {
      return parsed;
    }
  }

  const holdings = (Array.isArray(portfolioData?.holdings) && portfolioData?.holdings) || [];
  return holdings.length;
}

function sanitizeDomainSummary(summary: DomainSummaryPatch): Record<string, unknown> {
  const blocked = new Set([
    "holdings",
    "vault_key",
    "password",
    "risk_profile",
    "risk_bucket",
    "risk_score",
    "recent_decisions",
    "analysis_recent_decisions",
    "analysis_decisions",
    "decisions",
    "portfolio_total_value",
    "total_value",
  ]);
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(summary)) {
    const normalized = key.toLowerCase();
    if (blocked.has(normalized)) continue;
    if (
      [
        "attribute_count",
        "holdings_count",
        "item_count",
        "path_count",
        "externalizable_path_count",
        "manifest_version",
        "top_level_scope_count",
        "domain_contract_version",
        "readable_summary_version",
      ].includes(
        normalized
      )
    ) {
      const parsed = toNumber(value);
      if (parsed !== null) {
        sanitized[normalized] = parsed;
      }
      continue;
    }
    if (
      typeof value === "boolean" &&
      (normalized.startsWith("has_") ||
        normalized.endsWith("_enabled") ||
        normalized.endsWith("_available"))
    ) {
      sanitized[normalized] = value;
      continue;
    }
    if (
      typeof value === "string" &&
      [
        "last_structured_at",
        "last_content_at",
        "storage_mode",
        "upgraded_at",
        "readable_summary",
        "readable_updated_at",
        "readable_source_label",
        "readable_event_summary",
      ].includes(normalized)
    ) {
      sanitized[normalized] = value;
      continue;
    }
    if (normalized === "readable_highlights" && Array.isArray(value)) {
      sanitized[normalized] = value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
        .slice(0, 5);
    }
  }

  return sanitized;
}

function patchMetadataDomain(
  cachedMetadata: PersonalKnowledgeModelMetadata,
  userId: string,
  domain: string,
  options?: {
    domainSummary?: DomainSummaryPatch;
    portfolioData?: PortfolioData;
    metadataTimestamp?: string;
  }
): PersonalKnowledgeModelMetadata {
  const sanitizedSummary = sanitizeDomainSummary(options?.domainSummary ?? {});
  const metadataTimestamp =
    options?.metadataTimestamp ??
    (typeof sanitizedSummary.last_updated === "string"
      ? sanitizedSummary.last_updated
      : new Date().toISOString());

  const existing = cachedMetadata.domains.find((entry) => entry.key === domain);
  const patchedDomain = {
    key: domain,
    displayName:
      (typeof options?.domainSummary?.display_name === "string"
        ? options.domainSummary.display_name
        : typeof options?.domainSummary?.displayName === "string"
          ? options.domainSummary.displayName
          : existing?.displayName) || domain,
    icon:
      (typeof options?.domainSummary?.icon === "string" ? options.domainSummary.icon : existing?.icon) ||
      "database",
    color:
      (typeof options?.domainSummary?.color === "string" ? options.domainSummary.color : existing?.color) ||
      "var(--brand-500)",
    attributeCount: deriveAttributeCount(options?.domainSummary, options?.portfolioData),
    summary: sanitizedSummary,
    availableScopes: existing?.availableScopes ?? [],
    lastUpdated: metadataTimestamp,
    readableSummary:
      (typeof options?.domainSummary?.readable_summary === "string"
        ? options.domainSummary.readable_summary
        : typeof options?.domainSummary?.readableSummary === "string"
          ? options.domainSummary.readableSummary
          : existing?.readableSummary) || null,
    readableHighlights:
      (Array.isArray(options?.domainSummary?.readable_highlights)
        ? options?.domainSummary?.readable_highlights
        : Array.isArray(options?.domainSummary?.readableHighlights)
          ? options?.domainSummary?.readableHighlights
          : existing?.readableHighlights) || [],
    readableUpdatedAt:
      (typeof options?.domainSummary?.readable_updated_at === "string"
        ? options.domainSummary.readable_updated_at
        : typeof options?.domainSummary?.readableUpdatedAt === "string"
          ? options.domainSummary.readableUpdatedAt
          : existing?.readableUpdatedAt) || metadataTimestamp,
    readableSourceLabel:
      (typeof options?.domainSummary?.readable_source_label === "string"
        ? options.domainSummary.readable_source_label
        : typeof options?.domainSummary?.readableSourceLabel === "string"
          ? options.domainSummary.readableSourceLabel
          : existing?.readableSourceLabel) || null,
    domainContractVersion:
      Number(
        options?.domainSummary?.domain_contract_version ??
          options?.domainSummary?.domainContractVersion ??
          existing?.domainContractVersion ??
          1
      ) || 1,
    readableSummaryVersion:
      Number(
        options?.domainSummary?.readable_summary_version ??
          options?.domainSummary?.readableSummaryVersion ??
          existing?.readableSummaryVersion ??
          0
      ) || 0,
    upgradedAt:
      (typeof options?.domainSummary?.upgraded_at === "string"
        ? options.domainSummary.upgraded_at
        : typeof options?.domainSummary?.upgradedAt === "string"
          ? options.domainSummary.upgradedAt
          : existing?.upgradedAt) || metadataTimestamp,
  };

  const domains = [...cachedMetadata.domains];
  const existingIndex = domains.findIndex((entry) => entry.key === domain);
  if (existingIndex >= 0) {
    domains[existingIndex] = patchedDomain;
  } else {
    domains.push(patchedDomain);
  }

  const totalAttributes = domains.reduce((sum, current) => {
    return sum + (Number.isFinite(current.attributeCount) ? current.attributeCount : 0);
  }, 0);

  return {
    ...cachedMetadata,
    userId,
    domains,
    totalAttributes,
    modelVersion: cachedMetadata.modelVersion,
    targetModelVersion: cachedMetadata.targetModelVersion,
    upgradeStatus: cachedMetadata.upgradeStatus,
    upgradableDomains: cachedMetadata.upgradableDomains,
    lastUpgradedAt: cachedMetadata.lastUpgradedAt,
    lastUpdated: metadataTimestamp,
  };
}

/**
 * Deterministic cache mutation coordinator for all DB-backed CRUD paths.
 * Services/components should call this instead of ad-hoc invalidation logic.
 */
export class CacheSyncService {
  private static onKaiMarketContextChanged(userId: string): void {
    const cache = CacheService.getInstance();
    cache.invalidatePattern(`kai_market_home_${userId}_`);
    cache.invalidatePattern(`kai_dashboard_profile_picks_${userId}_`);
    removeSessionItemsByPrefix(`kai_market_home_session_${userId}_`);
    removeSessionItemsByPrefix(`kai_market_home_last_known_${userId}_`);
    void import("@/lib/services/unlock-warm-orchestrator")
      .then(({ UnlockWarmOrchestrator }) => {
        UnlockWarmOrchestrator.invalidateForUser(userId);
      })
      .catch(() => undefined);
  }

  static onPkmDomainStored(
    userId: string,
    domain: string,
    options?: {
      portfolioData?: PortfolioData;
      encryptedBlob?: {
        ciphertext: string;
        iv: string;
        tag: string;
        algorithm?: string;
        dataVersion?: number;
        updatedAt?: string;
      };
      domainSummary?: DomainSummaryPatch;
      metadataTimestamp?: string;
      writeThroughMetadata?: boolean;
    }
  ): void {
    const emitDomainStoredEvent = () => {
      if (typeof window === "undefined") return;
      window.dispatchEvent(
        new CustomEvent("pkm-domain-stored", {
          detail: {
            userId,
            domain,
            dataVersion: options?.encryptedBlob?.dataVersion ?? null,
            updatedAt: options?.encryptedBlob?.updatedAt ?? options?.metadataTimestamp ?? null,
          },
        })
      );
    };
    const cache = CacheService.getInstance();
    const writeThroughMetadata = options?.writeThroughMetadata !== false;
    cache.invalidate(CACHE_KEYS.PKM_DECRYPTED_BLOB(userId));

    if (domain === "financial") {
      if (options?.portfolioData) {
        cache.set(CACHE_KEYS.PORTFOLIO_DATA(userId), options.portfolioData, CACHE_TTL.SESSION);
        cache.set(
          CACHE_KEYS.DOMAIN_DATA(userId, "financial"),
          options.portfolioData,
          CACHE_TTL.SESSION
        );
      }
      // IMPORTANT: Preserve existing financial portfolio cache on profile-only
      // writes (e.g. onboarding/nav-tour sync). Invalidating here causes
      // transient "import portfolio" gating despite a successful save.
    } else {
      cache.invalidate(CACHE_KEYS.DOMAIN_DATA(userId, domain));
    }

    if (options?.encryptedBlob) {
      cache.set(
        CACHE_KEYS.ENCRYPTED_DOMAIN_BLOB(userId, domain),
        options.encryptedBlob,
        CACHE_TTL.SESSION
      );
      cache.invalidate(CACHE_KEYS.PKM_BLOB(userId));
    } else {
      cache.invalidate(CACHE_KEYS.ENCRYPTED_DOMAIN_BLOB(userId, domain));
      cache.invalidate(CACHE_KEYS.PKM_BLOB(userId));
    }

    if (!writeThroughMetadata) {
      emitDomainStoredEvent();
      return;
    }

    const cachedMetadata = cache.get<PersonalKnowledgeModelMetadata>(CACHE_KEYS.PKM_METADATA(userId));
    if (!cachedMetadata || !options?.domainSummary) {
      cache.invalidate(CACHE_KEYS.PKM_METADATA(userId));
      emitDomainStoredEvent();
      return;
    }

    const patched = patchMetadataDomain(cachedMetadata, userId, domain, {
      domainSummary: options.domainSummary,
      portfolioData: options.portfolioData,
      metadataTimestamp: options.metadataTimestamp,
    });
    cache.set(CACHE_KEYS.PKM_METADATA(userId), patched, CACHE_TTL.MEDIUM);
    emitDomainStoredEvent();
  }

  static onPkmDomainCleared(userId: string, domain: string): void {
    const cache = CacheService.getInstance();
    cache.invalidate(CACHE_KEYS.DOMAIN_DATA(userId, domain));
    cache.invalidate(CACHE_KEYS.ENCRYPTED_DOMAIN_BLOB(userId, domain));
    cache.invalidate(CACHE_KEYS.PKM_BLOB(userId));
    cache.invalidate(CACHE_KEYS.PKM_DECRYPTED_BLOB(userId));
    cache.invalidate(CACHE_KEYS.PKM_METADATA(userId));
    if (domain === "financial") {
      cache.invalidate(CACHE_KEYS.PORTFOLIO_DATA(userId));
    }
  }

  static onPortfolioUpserted(
    userId: string,
    portfolioData: PortfolioData,
    options?: {
      invalidateMetadata?: boolean;
    }
  ): void {
    const cache = CacheService.getInstance();
    cache.set(CACHE_KEYS.PORTFOLIO_DATA(userId), portfolioData, CACHE_TTL.SESSION);
    cache.set(CACHE_KEYS.DOMAIN_DATA(userId, "financial"), portfolioData, CACHE_TTL.SESSION);
    this.onKaiMarketContextChanged(userId);
    if (options?.invalidateMetadata !== false) {
      cache.invalidate(CACHE_KEYS.PKM_METADATA(userId));
    }
  }

  static onPlaidSourceProjected(userId: string): void {
    this.onKaiMarketContextChanged(userId);
  }

  static onVaultStateChanged(
    userId: string,
    options?: {
      hasVault?: boolean;
    }
  ): void {
    const cache = CacheService.getInstance();
    if (typeof options?.hasVault === "boolean") {
      cache.set(CACHE_KEYS.VAULT_CHECK(userId), options.hasVault, CACHE_TTL.SESSION);
    } else {
      cache.invalidate(CACHE_KEYS.VAULT_CHECK(userId));
    }
    cache.invalidate(CACHE_KEYS.VAULT_STATUS(userId));
  }

  static onConsentMutated(userId: string): void {
    const cache = CacheService.getInstance();
    cache.invalidate(CACHE_KEYS.ACTIVE_CONSENTS(userId));
    cache.invalidate(CACHE_KEYS.PENDING_CONSENTS(userId));
    cache.invalidate(CACHE_KEYS.CONSENT_AUDIT_LOG(userId));
    cache.invalidate(CACHE_KEYS.CONSENT_CENTER(userId, "all"));
    cache.invalidate(CACHE_KEYS.RIA_ROSTER_SUMMARY(userId));
    cache.invalidate(CACHE_KEYS.VAULT_STATUS(userId));
    this.onKaiMarketContextChanged(userId);
  }

  static onPersonaStateChanged(
    userId: string,
    options?: {
      preservePersonaState?: boolean;
    }
  ): void {
    const cache = CacheService.getInstance();
    if (!options?.preservePersonaState) {
      cache.invalidate(CACHE_KEYS.PERSONA_STATE(userId));
    }
    cache.invalidate(CACHE_KEYS.RIA_ONBOARDING_STATUS(userId));
    cache.invalidate(CACHE_KEYS.CONSENT_CENTER(userId, "all"));
    cache.invalidate(CACHE_KEYS.RIA_ROSTER_SUMMARY(userId));
    this.onKaiMarketContextChanged(userId);
  }

  static onMarketplaceVisibilityChanged(userId: string): void {
    const cache = CacheService.getInstance();
    cache.invalidate(CACHE_KEYS.PERSONA_STATE(userId));
    cache.invalidate(CACHE_KEYS.RIA_ONBOARDING_STATUS(userId));
    cache.invalidatePattern("marketplace_rias_");
    cache.invalidatePattern("marketplace_investors_");
  }

  /**
   * Use this for out-of-band changes (e.g. future cross-device sync events).
   * Local CRUD should prefer onAnalysisHistoryStored() write-through updates.
   */
  static onAnalysisHistoryMutated(
    userId: string,
    ticker?: string,
    options?: { preserveHistoryCache?: boolean }
  ): void {
    const cache = CacheService.getInstance();
    if (!options?.preserveHistoryCache) {
      cache.invalidate(CACHE_KEYS.ANALYSIS_HISTORY(userId));
    }
    cache.invalidate(CACHE_KEYS.PKM_BLOB(userId));
    cache.invalidate(CACHE_KEYS.PKM_DECRYPTED_BLOB(userId));
    cache.invalidate(CACHE_KEYS.ENCRYPTED_DOMAIN_BLOB(userId, "financial"));
    cache.invalidate(CACHE_KEYS.DOMAIN_DATA(userId, "financial"));
    cache.invalidate(CACHE_KEYS.PKM_METADATA(userId));
    if (ticker) {
      cache.invalidate(CACHE_KEYS.STOCK_CONTEXT(userId, ticker.toUpperCase()));
    }
  }

  static getAnalysisHistorySnapshot(
    userId: string
  ): Record<string, unknown[]> | null {
    const cache = CacheService.getInstance();
    return cache.get<Record<string, unknown[]>>(CACHE_KEYS.ANALYSIS_HISTORY(userId)) ?? null;
  }

  static onAnalysisHistoryStored(
    userId: string,
    historyMap: Record<string, unknown[]>,
    ticker?: string
  ): void {
    const cache = CacheService.getInstance();
    cache.set(CACHE_KEYS.ANALYSIS_HISTORY(userId), historyMap, CACHE_TTL.SESSION);
    // Local write-through path:
    // keep history cache warm and avoid broad invalidation/refetch churn.
    if (ticker) {
      cache.invalidate(CACHE_KEYS.STOCK_CONTEXT(userId, ticker.toUpperCase()));
    }
  }

  static onAuthSignedOut(userId?: string | null): void {
    const cache = CacheService.getInstance();
    if (userId) {
      cache.invalidateUser(userId);
      return;
    }
    cache.clear();
  }

  static onAccountDeleted(userId?: string | null): void {
    this.onAuthSignedOut(userId ?? null);
  }
}
