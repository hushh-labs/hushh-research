"use client";

import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { logRequestAudit } from "@/lib/cache/request-audit-log";
import {
  type DomainSnapshotV1,
  type EncryptedDomainBlob,
  PersonalKnowledgeModelService,
} from "@/lib/services/personal-knowledge-model-service";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";

const DEVICE_TTL_MS = 24 * 60 * 60 * 1000;
const inflightRefreshes = new Map<string, Promise<PkmDomainResourceSnapshot | null>>();
const domainRevisions = new Map<string, number>();

function domainRevisionKey(userId: string, domain: string): string {
  return `${userId}:${domain}`;
}

function domainRevision(userId: string, domain: string): number {
  return domainRevisions.get(domainRevisionKey(userId, domain)) ?? 0;
}

type DomainResourceCacheTier = "memory" | "device" | "network";
type DomainResourceSource = "cache" | "secure_cache" | "network";

export interface PkmDomainResourceKey {
  userId: string;
  domain: string;
  segmentIds: string[];
  contentRevision: number | null;
}

export interface PkmDomainResourceSnapshot<T = Record<string, unknown>> {
  key: PkmDomainResourceKey;
  data: T;
  manifestRevision: number | null;
  updatedAt: string | null;
  audit: {
    cacheTier: DomainResourceCacheTier;
    source: DomainResourceSource;
    refreshedAt: string;
  };
}

export interface PkmDomainResourceBatchResult {
  snapshots: Record<string, PkmDomainResourceSnapshot>;
  failedDomains: string[];
}

export type PkmDomainResourceBatchProgress = {
  domain: string;
  snapshot: PkmDomainResourceSnapshot | null;
  failed: boolean;
};

interface PkmDomainResourceParams {
  userId: string;
  domain: string;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
  segmentIds?: string[];
}

interface PreparedDomainWriteContext {
  baseFullBlob: Record<string, unknown>;
  domainData: Record<string, unknown> | null;
  expectedDataVersion: number | undefined;
  manifest: DomainManifest | null;
  encryptedDomain: EncryptedDomainBlob | null;
  snapshot: DomainSnapshotV1 | null;
  etag: string | null;
}

function hasUserConsent(params: { vaultOwnerToken?: string | null }): boolean {
  return Boolean(String(params.vaultOwnerToken || "").trim());
}

function normalizeSegmentIds(segmentIds?: string[]): string[] {
  return [...new Set((segmentIds || []).map((segmentId) => String(segmentId || "").trim().toLowerCase()).filter(Boolean))];
}

function segmentSignature(segmentIds?: string[]): string {
  const normalized = normalizeSegmentIds(segmentIds);
  return normalized.length > 0 ? normalized.join(",") : "all";
}

function toCacheKey(params: { userId: string; domain: string; segmentIds?: string[] }): string {
  return CACHE_KEYS.PKM_DOMAIN_RESOURCE(
    params.userId,
    params.domain,
    segmentSignature(params.segmentIds)
  );
}

function toDeviceResourceKey(params: { domain: string; segmentIds?: string[] }): string {
  return `pkm_domain:${params.domain}:${segmentSignature(params.segmentIds)}`;
}

function logRequest(stage: string, detail: Record<string, unknown>): void {
  logRequestAudit("pkm_domain_resource", stage, detail);
}

function buildSnapshot(params: {
  userId: string;
  domain: string;
  segmentIds?: string[];
  data: Record<string, unknown>;
  blob: EncryptedDomainBlob | null;
  cacheTier: DomainResourceCacheTier;
  source: DomainResourceSource;
}): PkmDomainResourceSnapshot {
  return {
    key: {
      userId: params.userId,
      domain: params.domain,
      segmentIds: normalizeSegmentIds(params.segmentIds),
      contentRevision:
        typeof params.blob?.dataVersion === "number" ? params.blob.dataVersion : null,
    },
    data: params.data,
    manifestRevision:
      typeof params.blob?.manifestRevision === "number" ? params.blob.manifestRevision : null,
    updatedAt: params.blob?.updatedAt ?? null,
    audit: {
      cacheTier: params.cacheTier,
      source: params.source,
      refreshedAt: new Date().toISOString(),
    },
  };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function peekCachedBlobRevision(params: {
  userId: string;
  domain: string;
  segmentIds?: string[];
}): number | null {
  if (normalizeSegmentIds(params.segmentIds).length > 0) {
    return null;
  }
  const cachedBlob = PersonalKnowledgeModelService.peekCachedDomainBlob(params.userId, params.domain);
  return typeof cachedBlob?.dataVersion === "number" ? cachedBlob.dataVersion : null;
}

function hydrateMemory(params: {
  userId: string;
  domain: string;
  segmentIds?: string[];
  snapshot: PkmDomainResourceSnapshot;
  canWriteCache?: boolean;
}): PkmDomainResourceSnapshot {
  if (params.canWriteCache === false) {
    return params.snapshot;
  }
  const cache = CacheService.getInstance();
  const cacheKey = toCacheKey(params);
  cache.set(cacheKey, params.snapshot, CACHE_TTL.SESSION);
  if (normalizeSegmentIds(params.segmentIds).length === 0) {
    cache.set(
      CACHE_KEYS.DOMAIN_DATA(params.userId, params.domain),
      params.snapshot.data,
      CACHE_TTL.SESSION
    );
  }
  return params.snapshot;
}

export class PkmDomainResourceService {
  static peek(params: { userId: string; domain: string; segmentIds?: string[] }) {
    return CacheService.getInstance().peek<PkmDomainResourceSnapshot>(toCacheKey(params));
  }

  static async hydrateFromSecureCache(
    params: PkmDomainResourceParams
  ): Promise<PkmDomainResourceSnapshot | null> {
    if (!params.vaultKey) {
      return null;
    }
    const resourceKey = toDeviceResourceKey(params);
    const revision = domainRevision(params.userId, params.domain);
    const snapshot = await SecureResourceCacheService.read<PkmDomainResourceSnapshot>({
      userId: params.userId,
      resourceKey,
      vaultKey: params.vaultKey,
    });
    if (domainRevision(params.userId, params.domain) !== revision) {
      await SecureResourceCacheService.invalidateResourcePrefix(
        params.userId,
        `pkm_domain:${params.domain}:`,
      ).catch(() => undefined);
      return null;
    }
    if (!snapshot) {
      logRequest("cache_miss", {
        tier: "device",
        userId: params.userId,
        domain: params.domain,
        segmentSignature: segmentSignature(params.segmentIds),
      });
      return null;
    }
    const hydrated = hydrateMemory({
      userId: params.userId,
      domain: params.domain,
      segmentIds: params.segmentIds,
      canWriteCache: hasUserConsent(params),
      snapshot: {
        ...snapshot,
        audit: {
          cacheTier: "device",
          source: "secure_cache",
          refreshedAt: new Date().toISOString(),
        },
      },
    });
    logRequest("device_hit", {
      userId: params.userId,
      domain: params.domain,
      segmentSignature: segmentSignature(params.segmentIds),
    });
    return hydrated;
  }

  static async getStaleFirst(
    params: PkmDomainResourceParams & {
      forceRefresh?: boolean;
      backgroundRefresh?: boolean;
    }
  ): Promise<PkmDomainResourceSnapshot | null> {
    const cacheKey = toCacheKey(params);
    const cached = CacheService.getInstance().peek<PkmDomainResourceSnapshot>(cacheKey);
    const cachedBlobRevision = peekCachedBlobRevision(params);

    if (!params.forceRefresh && cached?.data) {
      if (cachedBlobRevision !== null) {
        if (cached.data.key.contentRevision !== cachedBlobRevision) {
          logRequest("revision_miss", {
            userId: params.userId,
            domain: params.domain,
            segmentSignature: segmentSignature(params.segmentIds),
            cachedRevision: cached.data.key.contentRevision,
            liveRevision: cachedBlobRevision,
            tier: "memory",
          });
          return await this.refresh(params);
        }
        logRequest("revision_match_hit", {
          userId: params.userId,
          domain: params.domain,
          segmentSignature: segmentSignature(params.segmentIds),
          tier: "memory",
        });
        return cached.data;
      }

      if (cached.isFresh) {
        logRequest("cache_hit", {
          tier: "memory",
          userId: params.userId,
          domain: params.domain,
          segmentSignature: segmentSignature(params.segmentIds),
        });
        return cached.data;
      }

      logRequest("stale_hit", {
        tier: "memory",
        userId: params.userId,
        domain: params.domain,
        segmentSignature: segmentSignature(params.segmentIds),
      });
      if (params.backgroundRefresh !== false) {
        void this.refresh(params);
      }
      return cached.data;
    }

    if (!params.forceRefresh) {
      const secure = await this.hydrateFromSecureCache(params);
      if (secure) {
        if (cachedBlobRevision !== null) {
          if (secure.key.contentRevision !== cachedBlobRevision) {
            logRequest("revision_miss", {
              userId: params.userId,
              domain: params.domain,
              segmentSignature: segmentSignature(params.segmentIds),
              cachedRevision: secure.key.contentRevision,
              liveRevision: cachedBlobRevision,
            });
            return await this.refresh(params);
          }
          logRequest("revision_match_hit", {
            userId: params.userId,
            domain: params.domain,
            segmentSignature: segmentSignature(params.segmentIds),
            tier: "device",
          });
          return secure;
        }
        if (params.backgroundRefresh !== false) {
          void this.refresh(params);
        }
        return secure;
      }
    }

    logRequest("cache_miss", {
      tier: "memory",
      userId: params.userId,
      domain: params.domain,
      segmentSignature: segmentSignature(params.segmentIds),
    });
    return await this.refresh(params);
  }

  /**
   * Loads independent PKM domains without allowing one unavailable domain to
   * make an owner-facing Memory view or private-agent inventory look empty.
   * Each domain still follows the usual memory -> encrypted device -> network
   * resolution path; no decrypted result is persisted by this helper.
   */
  static async getManyStaleFirst(
    params: Omit<PkmDomainResourceParams, "domain" | "segmentIds"> & {
      domains: readonly string[];
      forceRefresh?: boolean;
      backgroundRefresh?: boolean;
      concurrency?: number;
      onProgress?: (progress: PkmDomainResourceBatchProgress) => void;
    }
  ): Promise<PkmDomainResourceBatchResult> {
    const domains = [...new Set(params.domains.map((domain) => domain.trim()).filter(Boolean))];
    const snapshots: Record<string, PkmDomainResourceSnapshot> = {};
    const failedDomains: string[] = [];
    const concurrency = Math.min(Math.max(1, params.concurrency ?? 4), domains.length || 1);
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < domains.length) {
        const domain = domains[nextIndex];
        nextIndex += 1;
        if (!domain) return;
        try {
          const snapshot = await this.getStaleFirst({
            userId: params.userId,
            domain,
            vaultKey: params.vaultKey,
            vaultOwnerToken: params.vaultOwnerToken,
            forceRefresh: params.forceRefresh,
            backgroundRefresh: params.backgroundRefresh,
          });
          if (snapshot?.data) snapshots[domain] = snapshot;
          params.onProgress?.({ domain, snapshot, failed: false });
        } catch {
          failedDomains.push(domain);
          params.onProgress?.({ domain, snapshot: null, failed: true });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    return { snapshots, failedDomains: failedDomains.sort() };
  }

  static async prepareDomainWriteContext(
    params: PkmDomainResourceParams
  ): Promise<PreparedDomainWriteContext> {
    if (!params.vaultKey || !params.vaultOwnerToken) {
      return {
        baseFullBlob: {},
        domainData: null,
        expectedDataVersion: undefined,
        manifest: null,
        encryptedDomain: null,
        snapshot: null,
        etag: null,
      };
    }
    const loaded = await PersonalKnowledgeModelService.loadDomainSnapshot({
      userId: params.userId,
      domain: params.domain,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      segmentIds: params.segmentIds,
      force: true,
    });
    const domainData = toRecord(loaded.data);
    const expectedDataVersion = loaded.snapshot?.contentRevision;

    return {
      baseFullBlob: domainData ? { [params.domain]: domainData } : {},
      domainData,
      expectedDataVersion,
      manifest: loaded.snapshot?.manifest ?? null,
      encryptedDomain: loaded.snapshot?.encryptedBlob ?? null,
      snapshot: loaded.snapshot,
      etag: loaded.snapshot?.etag ?? null,
    };
  }

  static async refresh(
    params: PkmDomainResourceParams
  ): Promise<PkmDomainResourceSnapshot | null> {
    if (!params.userId || !params.domain || !params.vaultKey) {
      return null;
    }

    const inflightKey = `${params.userId}:${params.domain}:${segmentSignature(params.segmentIds)}`;
    const existing = inflightRefreshes.get(inflightKey);
    if (existing) {
      logRequest("inflight_dedupe_hit", {
        userId: params.userId,
        domain: params.domain,
        segmentSignature: segmentSignature(params.segmentIds),
      });
      return await existing;
    }

    logRequest("network_fetch", {
      userId: params.userId,
      domain: params.domain,
      segmentSignature: segmentSignature(params.segmentIds),
    });
    const startRevision = domainRevision(params.userId, params.domain);
    const request = PersonalKnowledgeModelService.loadDomainDataWithBlob({
      userId: params.userId,
      domain: params.domain,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken || undefined,
      segmentIds: params.segmentIds,
    })
      .then(async ({ data, blob }) => {
        if (domainRevision(params.userId, params.domain) !== startRevision) {
          // This read began before a same-tab, cross-tab, or cross-device
          // mutation doorbell. Let every waiter converge on one post-event
          // read instead of allowing the old response to repopulate caches.
          if (inflightRefreshes.get(inflightKey) === request) {
            inflightRefreshes.delete(inflightKey);
          }
          return await this.refresh(params);
        }
        if (!data) {
          CacheService.getInstance().invalidate(toCacheKey(params));
          return null;
        }
        const snapshot = buildSnapshot({
          userId: params.userId,
          domain: params.domain,
          segmentIds: params.segmentIds,
          data,
          blob,
          cacheTier: "network",
          source: "network",
        });
        hydrateMemory({
          userId: params.userId,
          domain: params.domain,
          segmentIds: params.segmentIds,
          canWriteCache: hasUserConsent(params),
          snapshot,
        });
        if (hasUserConsent(params)) {
          await SecureResourceCacheService.write({
            userId: params.userId,
            resourceKey: toDeviceResourceKey(params),
            value: snapshot,
            ttlMs: DEVICE_TTL_MS,
            vaultKey: params.vaultKey!,
          });
          if (domainRevision(params.userId, params.domain) !== startRevision) {
            // A mutation landed while the stale snapshot was being persisted.
            // Remove that just-written device fallback before joining a fresh
            // authoritative read; otherwise deletion can resurrect it later.
            await SecureResourceCacheService.invalidateResourcePrefix(
              params.userId,
              `pkm_domain:${params.domain}:`,
            ).catch(() => undefined);
            if (inflightRefreshes.get(inflightKey) === request) {
              inflightRefreshes.delete(inflightKey);
            }
            return await this.refresh(params);
          }
        }
        return snapshot;
      })
      .catch((error) => {
        logRequest("refresh_error", {
          userId: params.userId,
          domain: params.domain,
          segmentSignature: segmentSignature(params.segmentIds),
          message: error instanceof Error ? error.message : "unknown",
        });
        throw error;
      })
      .finally(() => {
        if (inflightRefreshes.get(inflightKey) === request) {
          inflightRefreshes.delete(inflightKey);
        }
      });

    inflightRefreshes.set(inflightKey, request);
    return await request;
  }

  static invalidateDomain(
    userId: string,
    domain: string,
    options?: { includeDevice?: boolean; includeBackingCaches?: boolean }
  ): void {
    const cache = CacheService.getInstance();
    const revisionKey = domainRevisionKey(userId, domain);
    domainRevisions.set(revisionKey, domainRevision(userId, domain) + 1);
    cache.invalidatePattern(`pkm_domain_resource_${userId}_${domain}_`);
    if (options?.includeBackingCaches) {
      cache.invalidate(CACHE_KEYS.DOMAIN_MANIFEST(userId, domain));
      cache.invalidate(CACHE_KEYS.DOMAIN_DATA(userId, domain));
      cache.invalidate(CACHE_KEYS.ENCRYPTED_DOMAIN_BLOB(userId, domain));
      cache.invalidate(CACHE_KEYS.PKM_BLOB(userId));
      cache.invalidate(CACHE_KEYS.PKM_DECRYPTED_BLOB(userId));
    }
    if (options?.includeDevice) {
      void SecureResourceCacheService.invalidateResourcePrefix(userId, `pkm_domain:${domain}:`);
    }
  }
}

export function usePkmDomainResource(
  params: PkmDomainResourceParams & {
    enabled?: boolean;
    backgroundRefresh?: boolean;
  }
) {
  const cacheKey =
    !params.userId || !params.domain ? "pkm_domain_resource_disabled" : toCacheKey(params);
  const refreshKey = [
    params.userId || "no-user",
    params.domain || "no-domain",
    params.segmentIds?.join(",") || "all",
    params.vaultKey ? "vault-key" : "no-vault-key",
    params.vaultOwnerToken ? "vault-owner-token" : "no-vault-owner-token",
    params.backgroundRefresh === false ? "no-background-refresh" : "background-refresh",
  ].join(":");

  return useStaleResource<PkmDomainResourceSnapshot | null>({
    cacheKey,
    enabled: Boolean(params.enabled ?? true) && Boolean(params.userId && params.domain),
    resourceLabel: `pkm_domain:${params.domain}`,
    refreshKey,
    load: async () =>
      await PkmDomainResourceService.getStaleFirst({
        ...params,
        backgroundRefresh: params.backgroundRefresh,
      }),
  });
}
