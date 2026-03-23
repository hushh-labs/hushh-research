// hushh-webapp/lib/services/personal-knowledge-model-service.ts
/**
 * Personal Knowledge Model service for PKM operations.
 *
 * Provides platform-aware methods for:
 * - Fetching PKM metadata
 * - Storing encrypted domain data blobs (BYOK)
 * - Scope validation
 *
 * Tri-Flow compliant: uses HushhPersonalKnowledgeModel on native and ApiService.apiFetch() on web.
 *
 * IMPORTANT: This service MUST NOT use direct fetch("/api/...") calls.
 * All web requests go through ApiService.apiFetch() for consistent auth handling.
 *
 * Caching: uses CacheService for in-memory caching with TTL to reduce API calls.
 */

import { Capacitor } from "@capacitor/core";
import { HushhPersonalKnowledgeModel } from "@/lib/capacitor";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import type { PortfolioData as CachedPortfolioData } from "@/lib/cache/cache-context";
import { ApiService } from "./api-service";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "./cache-service";
import {
  buildPersonalKnowledgeModelStructureArtifacts,
  type DomainManifest,
} from "@/lib/personal-knowledge-model/manifest";

// ==================== Types ====================

export interface DomainSummary {
  key: string;
  displayName: string;
  icon: string;
  color: string;
  attributeCount: number;
  summary: Record<string, string | number>;
  availableScopes: string[];
  lastUpdated: string | null;
}

export interface PersonalKnowledgeModelMetadata {
  userId: string;
  domains: DomainSummary[];
  totalAttributes: number;
  modelCompleteness: number;
  suggestedDomains: string[];
  lastUpdated: string | null;
}

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  tag: string;
  algorithm?: string;
  segments?: Record<string, EncryptedValue>;
}

export interface EncryptedUserBlob extends EncryptedValue {
  dataVersion?: number;
  updatedAt?: string;
}

export interface EncryptedDomainBlob extends EncryptedValue {
  storageMode?: "domain" | "legacy_full_blob";
  dataVersion?: number;
  updatedAt?: string;
  manifestRevision?: number;
  segmentIds?: string[];
}

export interface StoreDomainDataResult {
  success: boolean;
  conflict?: boolean;
  message?: string;
  dataVersion?: number;
  updatedAt?: string;
}

type DecryptedFullBlobCacheEntry = {
  marker: string;
  blob: Record<string, unknown>;
};

export interface ScopeDiscovery {
  userId: string;
  availableDomains: {
    domain: string;
    displayName: string;
    scopes: string[];
  }[];
  allScopes: string[];
  wildcardScopes: string[];
}

export interface PkmMergeDecision {
  merge_mode?: string;
  target_domain?: string;
  target_entity_id?: string;
  target_entity_path?: string;
  match_confidence?: number;
  match_reason?: string;
}

// ==================== Service ====================

export class PersonalKnowledgeModelService {
  private static readonly PKM_API_PREFIX = "/api/pkm";
  private static metadataInflight = new Map<string, Promise<PersonalKnowledgeModelMetadata>>();
  private static encryptedDataInflight = new Map<string, Promise<EncryptedUserBlob | null>>();
  private static domainDataInflight = new Map<string, Promise<EncryptedDomainBlob | null>>();
  private static domainManifestInflight = new Map<string, Promise<DomainManifest | null>>();
  private static tickerSyncInflight = new Map<string, Promise<void>>();
  private static tickerSyncSignatureByUser = new Map<string, string>();
  private static tickerSyncLastAt = new Map<string, number>();
  private static migrationInflight = new Map<string, Promise<void>>();
  private static readonly TICKER_SYNC_THROTTLE_MS = 5 * 60 * 1000;

  private static inflightKey(
    keyParts: Array<string | number | boolean | undefined | null>
  ): string {
    return keyParts.map((part) => (part ?? "null").toString()).join(":");
  }

  private static cloneRecord<T extends Record<string, unknown>>(value: T): T {
    if (typeof globalThis.structuredClone === "function") {
      try {
        return globalThis.structuredClone(value) as T;
      } catch {
        // Fall through to JSON clone.
      }
    }
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private static isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  private static deepMergeRecords(
    base: Record<string, unknown>,
    incoming: Record<string, unknown>
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      const current = merged[key];
      if (this.isPlainObject(current) && this.isPlainObject(value)) {
        merged[key] = this.deepMergeRecords(current, value);
      } else {
        merged[key] = value;
      }
    }
    return merged;
  }

  private static normalizePathSegments(path: string | undefined | null): string[] {
    return String(path || "")
      .split(".")
      .map((part) =>
        String(part)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "_")
          .replace(/^_+|_+$/g, "")
      )
      .filter(Boolean);
  }

  private static getValueAtPath(
    root: Record<string, unknown>,
    path: string | undefined | null
  ): unknown {
    const segments = this.normalizePathSegments(path);
    let cursor: unknown = root;
    for (const segment of segments) {
      if (!this.isPlainObject(cursor)) return undefined;
      cursor = cursor[segment];
    }
    return cursor;
  }

  private static ensureObjectAtPath(
    root: Record<string, unknown>,
    path: string | undefined | null
  ): Record<string, unknown> {
    const segments = this.normalizePathSegments(path);
    let cursor: Record<string, unknown> = root;
    for (const segment of segments) {
      if (!this.isPlainObject(cursor[segment])) {
        cursor[segment] = {};
      }
      cursor = cursor[segment] as Record<string, unknown>;
    }
    return cursor;
  }

  private static extractEntityPayload(
    domainData: Record<string, unknown>,
    mergeDecision?: PkmMergeDecision
  ): { scopePath: string; entityId: string; entity: Record<string, unknown> } | null {
    const explicitEntityPath = String(mergeDecision?.target_entity_path || "").trim();
    const explicitSegments = this.normalizePathSegments(explicitEntityPath);
    const entityIndex = explicitSegments.indexOf("entities");
    if (entityIndex >= 0 && explicitSegments[entityIndex + 1]) {
      const scopePath = explicitSegments.slice(0, entityIndex).join(".");
      const entityId = explicitSegments[entityIndex + 1] || "";
      const entityValue = this.getValueAtPath(domainData, explicitEntityPath);
      if (this.isPlainObject(entityValue)) {
        return {
          scopePath,
          entityId,
          entity: this.cloneRecord(entityValue),
        };
      }
    }

    for (const [scopeKey, scopeValue] of Object.entries(domainData || {})) {
      if (!this.isPlainObject(scopeValue)) continue;
      const entities = scopeValue.entities;
      if (!this.isPlainObject(entities)) continue;
      const [entityId, entityValue] = Object.entries(entities)[0] || [];
      if (!entityId || !this.isPlainObject(entityValue)) continue;
      return {
        scopePath: scopeKey,
        entityId,
        entity: this.cloneRecord(entityValue),
      };
    }
    return null;
  }

  private static applyMergeDecisionToDomain(params: {
    existingDomainData: Record<string, unknown>;
    candidateDomainData: Record<string, unknown>;
    mergeDecision?: PkmMergeDecision;
  }): Record<string, unknown> {
    const mergeMode = String(params.mergeDecision?.merge_mode || "create_entity").trim().toLowerCase();
    if (mergeMode === "no_op") {
      return this.cloneRecord(params.existingDomainData);
    }

    const existing = this.cloneRecord(params.existingDomainData);
    const candidate = this.cloneRecord(params.candidateDomainData);
    const incoming = this.extractEntityPayload(candidate, params.mergeDecision);
    if (!incoming) {
      return this.deepMergeRecords(existing, candidate);
    }

    const targetScope = incoming.scopePath || "notes";
    const scopeObject = this.ensureObjectAtPath(existing, targetScope);
    if (!this.isPlainObject(scopeObject.entities)) {
      scopeObject.entities = {};
    }
    const entities = scopeObject.entities as Record<string, unknown>;
    const nowIso = new Date().toISOString();
    const incomingEntity = this.cloneRecord(incoming.entity);
    if (!incomingEntity.entity_id) {
      incomingEntity.entity_id = incoming.entityId;
    }
    if (!incomingEntity.created_at) {
      incomingEntity.created_at = nowIso;
    }
    incomingEntity.updated_at = nowIso;

    const existingEntity = this.isPlainObject(entities[incoming.entityId])
      ? (this.cloneRecord(entities[incoming.entityId] as Record<string, unknown>) as Record<string, unknown>)
      : null;

    if (mergeMode === "create_entity" || !existingEntity) {
      entities[incoming.entityId] = incomingEntity;
      return existing;
    }

    if (mergeMode === "extend_entity") {
      const observations = Array.isArray(existingEntity.observations)
        ? [...existingEntity.observations]
        : [];
      const incomingObservations = Array.isArray(incomingEntity.observations)
        ? incomingEntity.observations
        : [];
      for (const observation of incomingObservations) {
        if (!observations.includes(observation)) {
          observations.push(observation);
        }
      }
      entities[incoming.entityId] = {
        ...existingEntity,
        ...incomingEntity,
        observations,
        status: "active",
        updated_at: nowIso,
      };
      return existing;
    }

    if (mergeMode === "delete_entity") {
      entities[incoming.entityId] = {
        ...existingEntity,
        status: "deleted",
        updated_at: nowIso,
      };
      return existing;
    }

    if (mergeMode === "correct_entity") {
      entities[incoming.entityId] = {
        ...existingEntity,
        status: "corrected",
        updated_at: nowIso,
      };
      const candidateReplacementId =
        String(incomingEntity.entity_id || "").trim() || `${incoming.entityId}_v2`;
      const replacementId =
        candidateReplacementId === incoming.entityId
          ? `${incoming.entityId}_corr`
          : candidateReplacementId;
      entities[replacementId] = {
        ...incomingEntity,
        entity_id: replacementId,
        supersedes_entity_id: incoming.entityId,
        status: "active",
        created_at: nowIso,
        updated_at: nowIso,
      };
      return existing;
    }

    return this.deepMergeRecords(existing, candidate);
  }

  private static buildEncryptedBlobMarker(blob: EncryptedUserBlob | EncryptedValue): string {
    const updatedAt =
      "updatedAt" in blob && typeof blob.updatedAt === "string" ? blob.updatedAt : "na";
    const dataVersion =
      "dataVersion" in blob && typeof blob.dataVersion === "number" ? blob.dataVersion : "na";
    const ciphertext = blob.ciphertext || "";
    const ciphertextSignature = `${ciphertext.length}:${ciphertext.slice(0, 24)}:${ciphertext.slice(-24)}`;
    return [
      blob.algorithm || "aes-256-gcm",
      dataVersion,
      updatedAt,
      blob.iv,
      blob.tag,
      ciphertextSignature,
    ].join("|");
  }

  private static cacheDecryptedBlob(params: {
    userId: string;
    marker: string;
    fullBlob: Record<string, unknown>;
  }): void {
    const cache = CacheService.getInstance();
    const cacheKey = CACHE_KEYS.PKM_DECRYPTED_BLOB(params.userId);
    const entry: DecryptedFullBlobCacheEntry = {
      marker: params.marker,
      blob: this.cloneRecord(params.fullBlob),
    };
    cache.set(cacheKey, entry, CACHE_TTL.SESSION);
  }

  private static buildCompositeBlobMarker(blobs: Array<EncryptedDomainBlob | EncryptedUserBlob>): string {
    const parts = blobs
      .map((blob) => this.buildEncryptedBlobMarker(blob))
      .sort();
    return `composed:${parts.join("||")}`;
  }

  private static canonicalSegmentId(segmentId: string): string {
    const normalized = String(segmentId || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized || "root";
  }

  private static normalizeSegmentIds(segmentIds?: string[] | null): string[] {
    return [...new Set((segmentIds || []).map((segmentId) => this.canonicalSegmentId(segmentId)))];
  }

  static resolveSegmentIdsForPaths(params: {
    manifest: DomainManifest | null | undefined;
    paths?: string[] | null;
  }): string[] {
    const manifest = params.manifest;
    if (!manifest) {
      return [];
    }
    const requestedPaths = [...new Set((params.paths || []).map((path) => this.normalizePathSegments(path).join(".")))].filter(Boolean);
    if (requestedPaths.length === 0) {
      return this.normalizeSegmentIds(manifest.segment_ids);
    }

    const matchedSegmentIds = new Set<string>();
    for (const descriptor of manifest.paths || []) {
      const jsonPath = this.normalizePathSegments(descriptor?.json_path).join(".");
      if (!jsonPath) continue;
      const matches = requestedPaths.some(
        (path) => jsonPath === path || jsonPath.startsWith(`${path}.`) || path.startsWith(`${jsonPath}.`)
      );
      if (!matches) continue;
      matchedSegmentIds.add(this.canonicalSegmentId(descriptor.segment_id || "root"));
    }

    if (matchedSegmentIds.size === 0) {
      return this.normalizeSegmentIds(manifest.segment_ids);
    }
    return [...matchedSegmentIds];
  }

  private static partitionDomainDataIntoSegments(domainData: Record<string, unknown>): Record<string, unknown> {
    const segmented: Record<string, unknown> = {};
    const rootPayload: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(domainData || {})) {
      const segmentId = this.canonicalSegmentId(key);
      const isSegmentCandidate =
        value !== null &&
        value !== undefined &&
        (Array.isArray(value) || typeof value === "object");
      if (!isSegmentCandidate || segmentId === "root") {
        rootPayload[key] = value;
        continue;
      }
      segmented[segmentId] = value;
    }

    if (Object.keys(rootPayload).length > 0 || Object.keys(segmented).length === 0) {
      segmented.root = rootPayload;
    }

    return segmented;
  }

  private static async encryptDomainForStorage(params: {
    vaultKey: string;
    domainData: Record<string, unknown>;
  }): Promise<EncryptedValue> {
    const { HushhVault } = await import("@/lib/capacitor");
    const fullEncrypted = await HushhVault.encryptData({
      plaintext: JSON.stringify(params.domainData),
      keyHex: params.vaultKey,
    });

    const segmentedPayloads = this.partitionDomainDataIntoSegments(params.domainData);
    const segments: Record<string, EncryptedValue> = {};
    await Promise.all(
      Object.entries(segmentedPayloads).map(async ([segmentId, segmentValue]) => {
        const encrypted = await HushhVault.encryptData({
          plaintext: JSON.stringify(segmentValue),
          keyHex: params.vaultKey,
        });
        segments[segmentId] = {
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          tag: encrypted.tag,
          algorithm: "aes-256-gcm",
        };
      })
    );

    return {
      ciphertext: fullEncrypted.ciphertext,
      iv: fullEncrypted.iv,
      tag: fullEncrypted.tag,
      algorithm: "aes-256-gcm",
      segments,
    };
  }

  private static async decryptDomainBlob(params: {
    vaultKey: string;
    domain: string;
    blob: EncryptedDomainBlob;
    segmentIds?: string[];
  }): Promise<Record<string, unknown>> {
    const { decryptData } = await import("@/lib/vault/encrypt");
    const segments = params.blob.segments || {};
    if (Object.keys(segments).length === 0) {
      const decrypted = await decryptData(
        {
          ciphertext: params.blob.ciphertext,
          iv: params.blob.iv,
          tag: params.blob.tag,
          encoding: "base64",
          algorithm: (params.blob.algorithm || "aes-256-gcm") as "aes-256-gcm",
        },
        params.vaultKey
      );
      return JSON.parse(decrypted) as Record<string, unknown>;
    }

    const domainData: Record<string, unknown> = {};
    const requestedSegmentIds = this.normalizeSegmentIds(params.segmentIds);
    const segmentEntries = Object.entries(segments).filter(([segmentId]) =>
      requestedSegmentIds.length === 0
        ? true
        : requestedSegmentIds.includes(this.canonicalSegmentId(segmentId))
    );
    for (const [segmentId, encryptedSegment] of segmentEntries) {
      const decrypted = await decryptData(
        {
          ciphertext: encryptedSegment.ciphertext,
          iv: encryptedSegment.iv,
          tag: encryptedSegment.tag,
          encoding: "base64",
          algorithm: (encryptedSegment.algorithm || "aes-256-gcm") as "aes-256-gcm",
        },
        params.vaultKey
      );
      const parsed = JSON.parse(decrypted);
      if (segmentId === "root" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(domainData, parsed as Record<string, unknown>);
        continue;
      }
      domainData[segmentId] = parsed;
    }
    return domainData;
  }

  static peekCachedEncryptedBlob(userId: string): EncryptedUserBlob | null {
    const cache = CacheService.getInstance();
    const cacheKey = CACHE_KEYS.PKM_BLOB(userId);
    const cached = cache.get<EncryptedUserBlob>(cacheKey);
    if (!cached) return null;
    return { ...cached };
  }

  static peekCachedFullBlob(userId: string): {
    blob: Record<string, unknown>;
    dataVersion?: number;
    updatedAt?: string;
  } | null {
    const cache = CacheService.getInstance();
    const decryptedCacheKey = CACHE_KEYS.PKM_DECRYPTED_BLOB(userId);
    const cachedDecrypted = cache.get<DecryptedFullBlobCacheEntry>(decryptedCacheKey);
    if (!cachedDecrypted?.blob) {
      return null;
    }

    const cachedEncrypted = this.peekCachedEncryptedBlob(userId);
    if (cachedEncrypted) {
      const marker = this.buildEncryptedBlobMarker(cachedEncrypted);
      if (
        cachedDecrypted.marker !== marker &&
        !cachedDecrypted.marker.startsWith("composed:")
      ) {
        return null;
      }
    }

    return {
      blob: this.cloneRecord(cachedDecrypted.blob),
      dataVersion: cachedEncrypted?.dataVersion,
      updatedAt: cachedEncrypted?.updatedAt,
    };
  }

  private static isLikelyPortfolioData(value: unknown): value is CachedPortfolioData {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    const portfolio = record.portfolio;
    if (portfolio && typeof portfolio === "object" && !Array.isArray(portfolio)) {
      const portfolioRecord = portfolio as Record<string, unknown>;
      return Array.isArray(portfolioRecord.holdings);
    }
    return false;
  }

  private static resolvePortfolioDataForDomain(params: {
    domain: string;
    domainData: Record<string, unknown>;
  }): CachedPortfolioData | undefined {
    if (params.domain !== "financial" || !this.isLikelyPortfolioData(params.domainData)) {
      return undefined;
    }

    const domainRecord = params.domainData as Record<string, unknown>;
    if (Array.isArray(domainRecord.holdings)) {
      return params.domainData as CachedPortfolioData;
    }
    if (
      domainRecord.portfolio &&
      typeof domainRecord.portfolio === "object" &&
      !Array.isArray(domainRecord.portfolio)
    ) {
      return domainRecord.portfolio as CachedPortfolioData;
    }
    return undefined;
  }

  private static normalizeHoldingSymbolCandidate(value: unknown): string {
    const raw = String(value ?? "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9.\-]/g, "");
    if (!raw) return "";
    if (["CASH", "MMF", "SWEEP", "QACDS"].includes(raw)) return "CASH";
    if (!/^[A-Z][A-Z0-9.\-]{0,5}$/.test(raw)) return "";
    return raw;
  }

  private static extractHoldingsForTickerSync(fullBlob: Record<string, unknown>): Array<Record<string, unknown>> {
    const financial =
      fullBlob.financial && typeof fullBlob.financial === "object" && !Array.isArray(fullBlob.financial)
        ? (fullBlob.financial as Record<string, unknown>)
        : null;
    if (!financial) return [];

    const canonicalPortfolio =
      financial.portfolio &&
      typeof financial.portfolio === "object" &&
      !Array.isArray(financial.portfolio)
        ? (financial.portfolio as Record<string, unknown>)
        : null;

    const holdingsSource = Array.isArray(canonicalPortfolio?.holdings)
      ? canonicalPortfolio?.holdings
      : Array.isArray(financial.holdings)
        ? financial.holdings
        : [];

    if (!Array.isArray(holdingsSource)) return [];

    const out: Array<Record<string, unknown>> = [];
    for (const row of holdingsSource) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        continue;
      }
      const holding = row as Record<string, unknown>;
      const symbol = this.normalizeHoldingSymbolCandidate(
        holding.symbol ??
          holding.ticker ??
          holding.ticker_symbol ??
          holding.display_ticker ??
          holding.security_symbol
      );
      if (!symbol) continue;
      out.push({
        symbol,
        ticker: symbol,
        name: holding.name ?? holding.description ?? holding.title ?? holding.company_name ?? symbol,
        sector: holding.sector ?? holding.sector_primary ?? holding.asset_category ?? holding.asset_type,
        industry: holding.industry ?? holding.industry_primary,
        asset_type: holding.asset_type ?? holding.asset_class ?? holding.instrument_kind,
        security_listing_status: holding.security_listing_status,
        instrument_kind: holding.instrument_kind,
        is_cash_equivalent: holding.is_cash_equivalent,
        is_investable: holding.is_investable,
      });
      if (out.length >= 250) {
        break;
      }
    }
    return out;
  }

  private static async maybeSyncTickersFromFinancialBlob(params: {
    userId: string;
    fullBlob: Record<string, unknown>;
    vaultOwnerToken?: string;
  }): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      return;
    }
    if (!params.vaultOwnerToken) {
      return;
    }

    const holdings = this.extractHoldingsForTickerSync(params.fullBlob);
    if (!holdings.length) {
      return;
    }

    const signature = holdings
      .map((row) => String(row.symbol || ""))
      .filter(Boolean)
      .sort()
      .join(",");
    if (!signature) {
      return;
    }

    const now = Date.now();
    const priorSignature = this.tickerSyncSignatureByUser.get(params.userId);
    const priorAt = this.tickerSyncLastAt.get(params.userId) || 0;
    if (
      priorSignature === signature &&
      now - priorAt < PersonalKnowledgeModelService.TICKER_SYNC_THROTTLE_MS
    ) {
      return;
    }

    const dedupeKey = this.inflightKey(["ticker_sync", params.userId, signature]);
    if (this.tickerSyncInflight.has(dedupeKey)) {
      return;
    }

    const request = (async () => {
      try {
        const response = await ApiService.apiFetch(
          `/api/tickers/sync-holdings/${encodeURIComponent(params.userId)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...this.getAuthHeaders(params.vaultOwnerToken),
            },
            body: JSON.stringify({
              holdings,
              max_symbols: 250,
              enrich_missing: true,
              refresh_cache: true,
            }),
          }
        );
        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          console.warn(
            `[PersonalKnowledgeModelService] ticker sync failed (${response.status}) for ${params.userId}: ${errorText}`
          );
          return;
        }

        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const changeCount =
          Number(payload.seeded_rows || 0) +
          Number(payload.seed_updates || 0) +
          Number(payload.enrichment_updated || 0);
        if (changeCount > 0) {
          const { preloadTickerUniverse } = await import("@/lib/kai/ticker-universe-cache");
          await preloadTickerUniverse({ forceRefresh: true }).catch(() => undefined);
        }

        this.tickerSyncSignatureByUser.set(params.userId, signature);
        this.tickerSyncLastAt.set(params.userId, Date.now());
      } catch (error) {
        console.warn("[PersonalKnowledgeModelService] ticker sync request failed:", error);
      }
    })();

    this.tickerSyncInflight.set(dedupeKey, request);
    try {
      await request;
    } finally {
      if (this.tickerSyncInflight.get(dedupeKey) === request) {
        this.tickerSyncInflight.delete(dedupeKey);
      }
    }
  }

  /**
   * Get auth headers for API requests.
   * 
   * SECURITY: Token must be passed explicitly from useVault() hook.
   * Never reads from sessionStorage (XSS protection).
   */
  private static getAuthHeaders(vaultOwnerToken?: string): HeadersInit {
    return vaultOwnerToken ? { Authorization: `Bearer ${vaultOwnerToken}` } : {};
  }

  private static getVaultOwnerToken(vaultOwnerToken?: string): string | undefined {
    // SECURITY: Only use explicitly passed token, no sessionStorage fallback
    return vaultOwnerToken;
  }

  /**
   * Get user PKM metadata for UI display.
   * This is the primary method for fetching profile data.
   *
   * Uses in-memory caching with 5-minute TTL to reduce API calls.
   *
   * @param userId - User's ID
   * @param forceRefresh - If true, bypasses cache and fetches fresh data
   */
  static async getMetadata(
    userId: string,
    forceRefresh = false,
    vaultOwnerToken?: string
  ): Promise<PersonalKnowledgeModelMetadata> {
    const cache = CacheService.getInstance();
    const cacheKey = CACHE_KEYS.PKM_METADATA(userId);

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = cache.get<PersonalKnowledgeModelMetadata>(cacheKey);
      if (cached) {
        console.log("[PersonalKnowledgeModelService] Using cached metadata");
        return cached;
      }
    }

    const dedupeKey = this.inflightKey([
      "metadata",
      userId,
      Capacitor.isNativePlatform() ? "native" : "web",
      vaultOwnerToken ? "vault_owner" : "anonymous",
      forceRefresh ? "refresh" : "cached",
    ]);
    const existingRequest = this.metadataInflight.get(dedupeKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = (async (): Promise<PersonalKnowledgeModelMetadata> => {
      let result: PersonalKnowledgeModelMetadata;
      let cacheTtlMs = CACHE_TTL.MEDIUM;

      if (Capacitor.isNativePlatform()) {
        // Use Capacitor plugin for native platforms
        // Native plugins return snake_case from backend - transform to camelCase
        const nativeResult = await HushhPersonalKnowledgeModel.getMetadata({
          userId,
          vaultOwnerToken: this.getVaultOwnerToken(vaultOwnerToken),
        });
         
        const raw = nativeResult as any;
        result = {
          userId: raw.user_id || raw.userId || userId,
          domains: (raw.domains || []).map((d: Record<string, unknown>) => ({
            key: (d.domain_key || d.key) as string,
            displayName: (d.display_name || d.displayName) as string,
            icon: (d.icon_name || d.icon) as string,
            color: (d.color_hex || d.color) as string,
            attributeCount: (d.attribute_count || d.attributeCount || 0) as number,
            summary: (d.summary || {}) as Record<string, string | number>,
            availableScopes: (d.available_scopes || d.availableScopes || []) as string[],
            lastUpdated: (d.last_updated || d.lastUpdated || null) as string | null,
          })),
          totalAttributes: raw.total_attributes || raw.totalAttributes || 0,
          modelCompleteness: raw.model_completeness || raw.modelCompleteness || 0,
          suggestedDomains: raw.suggested_domains || raw.suggestedDomains || [],
          lastUpdated: raw.last_updated || raw.lastUpdated || null,
        };
      } else {
        // Without a VAULT_OWNER token, metadata endpoint is expected to reject with 401.
        // Return empty metadata so first-time / locked-vault screens can render gracefully.
        if (!vaultOwnerToken) {
          result = {
            userId,
            domains: [],
            totalAttributes: 0,
            modelCompleteness: 0,
            suggestedDomains: [],
            lastUpdated: null,
          };
          return result;
        }

        // Web: Use ApiService.apiFetch() for tri-flow compliance
        const response = await ApiService.apiFetch(`${this.PKM_API_PREFIX}/metadata/${userId}`, {
          headers: this.getAuthHeaders(vaultOwnerToken),
        });

        // Handle 404 as valid "no data" response for new users
        if (response.status === 404) {
          result = {
            userId,
            domains: [],
            totalAttributes: 0,
            modelCompleteness: 0,
            suggestedDomains: [],
            lastUpdated: null,
          };
        } else if (response.status === 401 || response.status === 403) {
          // Token may be missing/expired/revoked during startup transitions.
          // Return empty metadata instead of throwing noisy runtime errors.
          console.warn(
            `[PersonalKnowledgeModelService] Metadata unauthorized for ${userId}; returning empty state (${response.status})`
          );
          cacheTtlMs = CACHE_TTL.SHORT;
          result = {
            userId,
            domains: [],
            totalAttributes: 0,
            modelCompleteness: 0,
            suggestedDomains: [],
            lastUpdated: null,
          };
        } else if (response.status === 408 || response.status === 429 || response.status >= 500) {
          // Upstream timeout / temporary backend issue.
          // Return an empty shape so callers can apply local fallbacks (cache/blob) without hard crash.
          console.warn(
            `[PersonalKnowledgeModelService] Metadata temporarily unavailable for ${userId}; returning empty state (${response.status})`
          );
          cacheTtlMs = CACHE_TTL.SHORT;
          result = {
            userId,
            domains: [],
            totalAttributes: 0,
            modelCompleteness: 0,
            suggestedDomains: [],
            lastUpdated: null,
          };
        } else if (!response.ok) {
          // Any remaining non-OK status should fail open for dashboard bootstrap.
          // Callers already apply local cache/blob fallbacks.
          console.warn(
            `[PersonalKnowledgeModelService] Metadata request failed for ${userId}; returning empty state (${response.status})`
          );
          cacheTtlMs = CACHE_TTL.SHORT;
          result = {
            userId,
            domains: [],
            totalAttributes: 0,
            modelCompleteness: 0,
            suggestedDomains: [],
            lastUpdated: null,
          };
        } else {
          const data = await response.json();

          // Transform snake_case to camelCase
          result = {
            userId: data.user_id,
            domains: (data.domains || []).map((d: Record<string, unknown>) => ({
              key: (d.domain_key || d.key) as string,
              displayName: (d.display_name || d.displayName) as string,
              icon: (d.icon_name || d.icon) as string,
              color: (d.color_hex || d.color) as string,
              attributeCount: (d.attribute_count || d.attributeCount) as number,
              summary: (d.summary || {}) as Record<string, string | number>,
              availableScopes: (d.available_scopes || []) as string[],
              lastUpdated: (d.last_updated || null) as string | null,
            })),
            totalAttributes: data.total_attributes || 0,
            modelCompleteness: data.model_completeness || 0,
            suggestedDomains: data.suggested_domains || [],
            lastUpdated: data.last_updated,
          };
        }
      }

      // Cache the result
      cache.set(cacheKey, result, cacheTtlMs);
      console.log("[PersonalKnowledgeModelService] Cached metadata for", userId);

      return result;
    })();

    this.metadataInflight.set(dedupeKey, request);
    try {
      return await request;
    } finally {
      if (this.metadataInflight.get(dedupeKey) === request) {
        this.metadataInflight.delete(dedupeKey);
      }
    }
  }

  /**
   * Store domain data (NEW blob-based architecture).
   *
   * This is the NEW method for storing user data following BYOK principles.
   * Client encrypts entire domain object and backend stores only ciphertext.
   *
   * @param params.userId - User's ID
   * @param params.domain - Domain key (e.g., "financial", "food")
   * @param params.encryptedBlob - Pre-encrypted data from client
   * @param params.summary - Non-sensitive metadata for pkm_index
   */
  static async storeDomainData(params: {
    userId: string;
    domain: string;
    encryptedBlob: EncryptedValue;
    summary: Record<string, unknown>;
    structureDecision?: Record<string, unknown>;
    manifest?: DomainManifest;
    portfolioData?: CachedPortfolioData;
    expectedDataVersion?: number;
    vaultOwnerToken?: string;
  }): Promise<StoreDomainDataResult> {
    if (Capacitor.isNativePlatform()) {
      const result = await HushhPersonalKnowledgeModel.storeDomainData({
        userId: params.userId,
        domain: params.domain,
        encryptedBlob: {
          ciphertext: params.encryptedBlob.ciphertext,
          iv: params.encryptedBlob.iv,
          tag: params.encryptedBlob.tag,
          algorithm: params.encryptedBlob.algorithm || "aes-256-gcm",
          segments: params.encryptedBlob.segments,
        },
        summary: params.summary,
        structureDecision: params.structureDecision,
        manifest: params.manifest,
        vaultOwnerToken: this.getVaultOwnerToken(params.vaultOwnerToken),
      });

      // Invalidate caches after successful native store
      if (result.success) {
        CacheSyncService.onPkmDomainStored(params.userId, params.domain, {
          portfolioData: params.portfolioData,
          encryptedBlob: params.encryptedBlob,
          domainSummary: params.summary,
          metadataTimestamp: new Date().toISOString(),
        });
      }

      return {
        success: result.success,
      };
    }

    const payload: Record<string, unknown> = {
      user_id: params.userId,
      domain: params.domain,
      encrypted_blob: {
        ciphertext: params.encryptedBlob.ciphertext,
        iv: params.encryptedBlob.iv,
        tag: params.encryptedBlob.tag,
        algorithm: params.encryptedBlob.algorithm || "aes-256-gcm",
        segments: params.encryptedBlob.segments,
      },
      summary: params.summary,
      structure_decision: params.structureDecision,
      manifest: params.manifest,
    };
    if (Number.isFinite(params.expectedDataVersion)) {
      payload.expected_data_version = Math.max(0, Number(params.expectedDataVersion));
    }

    // Web: Use ApiService.apiFetch() for tri-flow compliance
    const response = await ApiService.apiFetch(`${this.PKM_API_PREFIX}/store-domain`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.getAuthHeaders(params.vaultOwnerToken),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      if (response.status === 409) {
        let conflictPayload: unknown = null;
        try {
          conflictPayload = await response.json();
        } catch {
          // Ignore JSON parse errors and use a default conflict payload.
        }
        const detail =
          conflictPayload &&
          typeof conflictPayload === "object" &&
          "detail" in conflictPayload
            ? (conflictPayload as { detail?: unknown }).detail
            : conflictPayload;
        const detailRecord =
          detail && typeof detail === "object" ? (detail as Record<string, unknown>) : null;
        return {
          success: false,
          conflict: true,
          message:
            (detailRecord && typeof detailRecord.message === "string"
              ? detailRecord.message
              : null) ?? "PKM version conflict.",
          dataVersion:
            detailRecord && typeof detailRecord.current_data_version === "number"
              ? detailRecord.current_data_version
              : undefined,
          updatedAt:
            detailRecord && typeof detailRecord.updated_at === "string"
              ? detailRecord.updated_at
              : undefined,
        };
      }
      const errorText = await response.text();
      throw new Error(`Failed to store domain data: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const resolvedDataVersion =
      typeof data.data_version === "number" ? data.data_version : undefined;
    const resolvedUpdatedAt = typeof data.updated_at === "string" ? data.updated_at : undefined;
    const resolvedMessage = typeof data.message === "string" ? data.message : undefined;
    const enrichedEncryptedBlob: EncryptedUserBlob = {
      ...params.encryptedBlob,
      dataVersion: resolvedDataVersion,
      updatedAt: resolvedUpdatedAt,
    };

    // Invalidate caches after successful store
    CacheSyncService.onPkmDomainStored(params.userId, params.domain, {
      portfolioData: params.portfolioData,
      encryptedBlob: enrichedEncryptedBlob,
      domainSummary: params.summary,
      metadataTimestamp: new Date().toISOString(),
    });

    return {
      success: data.success !== false,
      conflict: data.conflict === true,
      message: resolvedMessage,
      dataVersion: resolvedDataVersion,
      updatedAt: resolvedUpdatedAt,
    };
  }

  /**
   * Get available scopes for a user (MCP discovery).
   */
  static async getAvailableScopes(
    userId: string,
    vaultOwnerToken?: string
  ): Promise<ScopeDiscovery> {
    if (Capacitor.isNativePlatform()) {
      const nativeResult = await HushhPersonalKnowledgeModel.getAvailableScopes({
        userId,
        vaultOwnerToken: this.getVaultOwnerToken(vaultOwnerToken),
      });
       
      const raw = nativeResult as any;
      return {
        userId: raw.user_id || raw.userId || userId,
        availableDomains: (raw.available_domains || raw.availableDomains || []).map(
          (d: Record<string, unknown>) => ({
            domain: d.domain as string,
            displayName: (d.display_name || d.displayName) as string,
            scopes: (d.scopes || []) as string[],
          })
        ),
        allScopes: raw.all_scopes || raw.allScopes || [],
        wildcardScopes: raw.wildcard_scopes || raw.wildcardScopes || [],
      };
    }

    // Web: Use ApiService.apiFetch() for tri-flow compliance
    const response = await ApiService.apiFetch(`${this.PKM_API_PREFIX}/scopes/${userId}`, {
      headers: this.getAuthHeaders(vaultOwnerToken),
    });

    if (!response.ok) {
      throw new Error(`Failed to get scopes: ${response.status}`);
    }

    const data = await response.json();
    const rawScopes: string[] = Array.isArray(data.scopes)
      ? data.scopes
      : Array.isArray(data.all_scopes)
        ? data.all_scopes
        : [];
    const groupedDomains = new Map<string, string[]>();
    for (const scope of rawScopes) {
      const match = /^attr\.([a-zA-Z0-9_]+)/.exec(scope);
      if (!match) continue;
      const domain = match[1] ?? "";
      if (!domain) continue;
      const existing = groupedDomains.get(domain) || [];
      existing.push(scope);
      groupedDomains.set(domain, existing);
    }

    return {
      userId: data.user_id,
      availableDomains:
        data.available_domains ||
        [...groupedDomains.entries()].map(([domain, scopes]) => ({
          domain,
          displayName: domain.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
          scopes,
        })),
      allScopes: rawScopes,
      wildcardScopes:
        data.wildcard_scopes ||
        rawScopes.filter(
          (scope) => scope === "pkm.read" || scope.endsWith(".*")
        ),
    };
  }

  static async getDomainManifest(
    userId: string,
    domain: string,
    vaultOwnerToken?: string
  ): Promise<DomainManifest | null> {
    const dedupeKey = this.inflightKey([
      "domain_manifest",
      userId,
      domain,
      vaultOwnerToken ? "vault_owner" : "anonymous",
    ]);
    const existingRequest = this.domainManifestInflight.get(dedupeKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = (async (): Promise<DomainManifest | null> => {
      const response = await ApiService.apiFetch(
        `${this.PKM_API_PREFIX}/manifest/${userId}/${domain}`,
        {
          headers: this.getAuthHeaders(vaultOwnerToken),
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Failed to get domain manifest: ${response.status}`);
      }

      return (await response.json()) as DomainManifest;
    })();

    this.domainManifestInflight.set(dedupeKey, request);
    try {
      return await request;
    } finally {
      if (this.domainManifestInflight.get(dedupeKey) === request) {
        this.domainManifestInflight.delete(dedupeKey);
      }
    }
  }

  /**
   * Get the full encrypted PKM blob for a user.
   */
  static async getEncryptedData(
    userId: string,
    vaultOwnerToken?: string
  ): Promise<EncryptedUserBlob | null> {
    const cache = CacheService.getInstance();
    const cacheKey = CACHE_KEYS.PKM_BLOB(userId);
    const cached = cache.get<EncryptedUserBlob>(cacheKey);
    if (cached) {
      return cached;
    }

    const dedupeKey = this.inflightKey([
      "encrypted_blob",
      userId,
      Capacitor.isNativePlatform() ? "native" : "web",
      vaultOwnerToken ? "vault_owner" : "anonymous",
    ]);
    const existingRequest = this.encryptedDataInflight.get(dedupeKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = (async (): Promise<EncryptedUserBlob | null> => {
      let result: EncryptedUserBlob | null = null;

      if (Capacitor.isNativePlatform()) {
        const nativeResult = await HushhPersonalKnowledgeModel.getEncryptedData({
          userId,
          vaultOwnerToken: this.getVaultOwnerToken(vaultOwnerToken),
        });
        if (nativeResult?.ciphertext && nativeResult?.iv && nativeResult?.tag) {
           
          const raw = nativeResult as any;
          result = {
            ciphertext: raw.ciphertext,
            iv: raw.iv,
            tag: raw.tag,
            algorithm: raw.algorithm || "aes-256-gcm",
            dataVersion:
              typeof raw.data_version === "number"
                ? raw.data_version
                : typeof raw.dataVersion === "number"
                  ? raw.dataVersion
                  : undefined,
            updatedAt:
              typeof raw.updated_at === "string"
                ? raw.updated_at
                : typeof raw.updatedAt === "string"
                  ? raw.updatedAt
                  : undefined,
          };
        }
      } else {
        const response = await ApiService.apiFetch(`${this.PKM_API_PREFIX}/data/${userId}`, {
          headers: this.getAuthHeaders(vaultOwnerToken),
        });

        if (!response.ok) {
          if (response.status === 404) {
            return null;
          }
          throw new Error(`Failed to get encrypted data: ${response.status}`);
        }

        const data = await response.json();
        if (data?.ciphertext && data?.iv && data?.tag) {
          result = {
            ciphertext: data.ciphertext,
            iv: data.iv,
            tag: data.tag,
            algorithm: data.algorithm || "aes-256-gcm",
            dataVersion: typeof data.data_version === "number" ? data.data_version : undefined,
            updatedAt: typeof data.updated_at === "string" ? data.updated_at : undefined,
          };
        }
      }

      if (result) {
        cache.set(cacheKey, result, CACHE_TTL.SESSION);
      } else {
        cache.invalidate(cacheKey);
      }
      return result;
    })();

    this.encryptedDataInflight.set(dedupeKey, request);
    try {
      return await request;
    } finally {
      if (this.encryptedDataInflight.get(dedupeKey) === request) {
        this.encryptedDataInflight.delete(dedupeKey);
      }
    }
  }

  /**
   * Decrypt and return the full PKM blob.
   * Returns empty object when user has no encrypted data.
   */
  static async loadFullBlob(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken?: string;
  }): Promise<Record<string, unknown>> {
    const cache = CacheService.getInstance();
    let metadata: PersonalKnowledgeModelMetadata | null = null;
    try {
      metadata = await this.getMetadata(params.userId, false, params.vaultOwnerToken);
    } catch {
      metadata = null;
    }
    const availableDomains = metadata?.domains.map((domain) => domain.key).filter(Boolean) || [];

    const legacyEncrypted = await this.getEncryptedData(params.userId, params.vaultOwnerToken);
    const domainBlobs = await Promise.all(
      availableDomains.map((domain) => this.getDomainData(params.userId, domain, params.vaultOwnerToken))
    );
    const materializedDomainBlobs = domainBlobs.filter(
      (blob): blob is EncryptedDomainBlob => Boolean(blob)
    );

    if (!legacyEncrypted && materializedDomainBlobs.length === 0) {
      cache.invalidate(CACHE_KEYS.PKM_DECRYPTED_BLOB(params.userId));
      return {};
    }

    const marker = this.buildCompositeBlobMarker([
      ...(legacyEncrypted ? [legacyEncrypted] : []),
      ...materializedDomainBlobs,
    ]);
    const decryptedCacheKey = CACHE_KEYS.PKM_DECRYPTED_BLOB(params.userId);
    const cachedDecrypted = cache.get<DecryptedFullBlobCacheEntry>(decryptedCacheKey);
    if (cachedDecrypted?.marker === marker && cachedDecrypted.blob) {
      return this.cloneRecord(cachedDecrypted.blob);
    }

    let parsedBlob: Record<string, unknown> = {};

    const legacyBlobCandidate =
      materializedDomainBlobs.find((blob) => blob.storageMode === "legacy_full_blob") || legacyEncrypted;
    if (legacyBlobCandidate) {
      const { decryptData } = await import("@/lib/vault/encrypt");
      const decrypted = await decryptData(
        {
          ciphertext: legacyBlobCandidate.ciphertext,
          iv: legacyBlobCandidate.iv,
          tag: legacyBlobCandidate.tag,
          encoding: "base64",
          algorithm: (legacyBlobCandidate.algorithm || "aes-256-gcm") as "aes-256-gcm",
        },
        params.vaultKey
      );
      const parsed = JSON.parse(decrypted);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedBlob = parsed as Record<string, unknown>;
      }
    }

    await Promise.all(
      availableDomains.map(async (domain, index) => {
        const blob = domainBlobs[index];
        if (!blob || blob.storageMode === "legacy_full_blob") {
          return;
        }
        parsedBlob[domain] = await this.decryptDomainBlob({
          vaultKey: params.vaultKey,
          domain,
          blob,
        });
      })
    );

    this.cacheDecryptedBlob({
      userId: params.userId,
      marker,
      fullBlob: parsedBlob,
    });
    void this.maybeMigrateLegacyBlobToPkm({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      legacyEncrypted,
      fullBlob: parsedBlob,
      metadata,
      fetchedDomains: availableDomains.map((domain, index) => ({
        domain,
        blob: domainBlobs[index] || null,
      })),
    });
    void this.maybeSyncTickersFromFinancialBlob({
      userId: params.userId,
      fullBlob: parsedBlob,
      vaultOwnerToken: params.vaultOwnerToken,
    });
    return this.cloneRecord(parsedBlob);
  }

  private static async maybeMigrateLegacyBlobToPkm(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken?: string;
    legacyEncrypted: EncryptedUserBlob | null;
    fullBlob: Record<string, unknown>;
    metadata: PersonalKnowledgeModelMetadata | null;
    fetchedDomains: Array<{ domain: string; blob: EncryptedDomainBlob | null }>;
  }): Promise<void> {
    if (!params.legacyEncrypted) {
      return;
    }

    const candidateDomains = Object.keys(params.fullBlob).filter((domain) => {
      const value = params.fullBlob[domain];
      return Boolean(value && typeof value === "object" && !Array.isArray(value));
    });
    if (candidateDomains.length === 0) {
      return;
    }

    const hasDomainBlob = new Set(
      params.fetchedDomains
        .filter(({ blob }) => Boolean(blob && blob.storageMode === "domain"))
        .map(({ domain }) => domain)
    );
    const domainsToMigrate = candidateDomains.filter((domain) => !hasDomainBlob.has(domain));
    if (domainsToMigrate.length === 0) {
      return;
    }

    const dedupeKey = this.inflightKey([
      "pkm_migration",
      params.userId,
      params.legacyEncrypted.updatedAt || "na",
      params.legacyEncrypted.dataVersion || "na",
    ]);
    const existing = this.migrationInflight.get(dedupeKey);
    if (existing) {
      return existing;
    }

    const request = (async () => {
      for (const domain of domainsToMigrate) {
        const domainValue = params.fullBlob[domain];
        if (!domainValue || typeof domainValue !== "object" || Array.isArray(domainValue)) {
          continue;
        }
        const domainData = this.cloneRecord(domainValue as Record<string, unknown>);
        const previousManifest = await this.getDomainManifest(
          params.userId,
          domain,
          params.vaultOwnerToken
        ).catch(() => null);
        const structureArtifacts = buildPersonalKnowledgeModelStructureArtifacts({
          domain,
          domainData,
          previousManifest,
        });
        const summary =
          params.metadata?.domains.find((entry) => entry.key === domain)?.summary || {};
        const portfolioData = this.resolvePortfolioDataForDomain({
          domain,
          domainData,
        });
        const encryptedBlob = await this.encryptDomainForStorage({
          vaultKey: params.vaultKey,
          domainData,
        });
        await this.storeDomainData({
          userId: params.userId,
          domain,
          encryptedBlob,
          summary: {
            ...summary,
            ...structureArtifacts.manifest.summary_projection,
          },
          structureDecision: structureArtifacts.structureDecision,
          manifest: structureArtifacts.manifest,
          portfolioData,
          vaultOwnerToken: params.vaultOwnerToken,
        });
      }
    })();

    this.migrationInflight.set(dedupeKey, request);
    try {
      await request;
    } finally {
      if (this.migrationInflight.get(dedupeKey) === request) {
        this.migrationInflight.delete(dedupeKey);
      }
    }
  }

  /**
   * Merge one domain into the full PKM blob, encrypt, and persist.
   */
  static async mergeAndEncryptFullBlob(params: {
    userId: string;
    vaultKey: string;
    domain: string;
    domainData: Record<string, unknown>;
    vaultOwnerToken?: string;
  }): Promise<{
    encryptedBlob: EncryptedValue;
    fullBlob: Record<string, unknown>;
  }> {
    const baseFullBlob = await this.loadFullBlob({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch(() => ({} as Record<string, unknown>));

    return this.mergeAndEncryptPreparedBlob({
      baseFullBlob,
      vaultKey: params.vaultKey,
      domain: params.domain,
      domainData: params.domainData,
    });
  }

  private static async mergeAndEncryptPreparedBlob(params: {
    baseFullBlob: Record<string, unknown>;
    vaultKey: string;
    domain: string;
    domainData: Record<string, unknown>;
    mergeDecision?: PkmMergeDecision;
  }): Promise<{
    encryptedBlob: EncryptedValue;
    fullBlob: Record<string, unknown>;
    domainData: Record<string, unknown>;
  }> {
    const existingDomainData = this.isPlainObject(params.baseFullBlob[params.domain])
      ? this.cloneRecord(params.baseFullBlob[params.domain] as Record<string, unknown>)
      : {};
    const mergedDomainData = this.applyMergeDecisionToDomain({
      existingDomainData,
      candidateDomainData: params.domainData,
      mergeDecision: params.mergeDecision,
    });
    const fullBlob = {
      ...params.baseFullBlob,
      [params.domain]: mergedDomainData,
    };
    const encrypted = await this.encryptDomainForStorage({
      vaultKey: params.vaultKey,
      domainData: mergedDomainData,
    });

    return {
      encryptedBlob: encrypted,
      fullBlob,
      domainData: mergedDomainData,
    };
  }

  private static async loadTargetDomainBaseBlob(params: {
    userId: string;
    vaultKey: string;
    domain: string;
    vaultOwnerToken?: string;
    segmentIds?: string[];
  }): Promise<Record<string, unknown>> {
    const domainData = await this.loadDomainData({
      userId: params.userId,
      domain: params.domain,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      segmentIds: params.segmentIds,
    }).catch(() => null);

    if (!this.isPlainObject(domainData)) {
      return {};
    }

    return {
      [params.domain]: this.cloneRecord(domainData),
    };
  }

  /**
   * Merge one domain into full blob and persist via storeDomainData.
   */
  static async storeMergedDomain(params: {
    userId: string;
    vaultKey: string;
    domain: string;
    domainData: Record<string, unknown>;
    summary: Record<string, unknown>;
    expectedDataVersion?: number;
    vaultOwnerToken?: string;
  }): Promise<{
    success: boolean;
    conflict?: boolean;
    message?: string;
    dataVersion?: number;
    updatedAt?: string;
    fullBlob: Record<string, unknown>;
  }> {
    const baseFullBlob = await this.loadTargetDomainBaseBlob({
      userId: params.userId,
      vaultKey: params.vaultKey,
      domain: params.domain,
      vaultOwnerToken: params.vaultOwnerToken,
    });

    return this.storeMergedDomainWithPreparedBlob({
      ...params,
      baseFullBlob,
      cacheFullBlob: false,
    });
  }

  /**
   * Merge one domain into a caller-provided decrypted blob and persist.
   * Use this to avoid an extra load/decrypt cycle when the caller already has the full blob.
   */
  static async storeMergedDomainWithPreparedBlob(params: {
    userId: string;
    vaultKey: string;
    domain: string;
    domainData: Record<string, unknown>;
    summary: Record<string, unknown>;
    baseFullBlob: Record<string, unknown>;
    expectedDataVersion?: number;
    vaultOwnerToken?: string;
    cacheFullBlob?: boolean;
  }): Promise<{
    success: boolean;
    conflict?: boolean;
    message?: string;
    dataVersion?: number;
    updatedAt?: string;
    fullBlob: Record<string, unknown>;
  }> {
    const previousManifest = await this.getDomainManifest(
      params.userId,
      params.domain,
      params.vaultOwnerToken
    ).catch(() => null);
    const merged = await this.mergeAndEncryptPreparedBlob({
      baseFullBlob: params.baseFullBlob,
      vaultKey: params.vaultKey,
      domain: params.domain,
      domainData: params.domainData,
    });
    const structureArtifacts = buildPersonalKnowledgeModelStructureArtifacts({
      domain: params.domain,
      domainData: params.domainData,
      previousManifest,
    });

    const summaryWithIntent = {
      domain_intent: params.domain,
      ...params.summary,
      ...structureArtifacts.manifest.summary_projection,
    };
    const portfolioData = this.resolvePortfolioDataForDomain({
      domain: params.domain,
      domainData: params.domainData,
    });

    const result = await this.storeDomainData({
      userId: params.userId,
      domain: params.domain,
      encryptedBlob: merged.encryptedBlob,
      summary: summaryWithIntent,
      structureDecision: structureArtifacts.structureDecision,
      manifest: structureArtifacts.manifest,
      portfolioData,
      expectedDataVersion: params.expectedDataVersion,
      vaultOwnerToken: params.vaultOwnerToken,
    });

    if (result.success && params.domain === "financial") {
      void this.maybeSyncTickersFromFinancialBlob({
        userId: params.userId,
        fullBlob: merged.fullBlob,
        vaultOwnerToken: params.vaultOwnerToken,
      });
    }
    if (result.success && params.cacheFullBlob !== false) {
      const encryptedBlobForCache: EncryptedUserBlob = {
        ...merged.encryptedBlob,
        dataVersion: result.dataVersion,
        updatedAt: result.updatedAt,
      };
      this.cacheDecryptedBlob({
        userId: params.userId,
        marker: this.buildCompositeBlobMarker([encryptedBlobForCache]),
        fullBlob: merged.fullBlob,
      });
    }

    return {
      success: result.success,
      conflict: result.conflict,
      message: result.message,
      dataVersion: result.dataVersion,
      updatedAt: result.updatedAt,
      fullBlob: merged.fullBlob,
    };
  }

  /**
   * Persist a prepared PKM domain using caller-provided structure artifacts.
   * This is used by tools like PKM Agent Lab so the saved backend shape matches
   * the previewed domain, manifest, and scope plan exactly.
   */
  static async storePreparedDomain(params: {
    userId: string;
    vaultKey: string;
    domain: string;
    domainData: Record<string, unknown>;
    summary: Record<string, unknown>;
    mergeDecision?: PkmMergeDecision;
    structureDecision?: Record<string, unknown>;
    manifest?: DomainManifest | null;
    expectedDataVersion?: number;
    vaultOwnerToken?: string;
  }): Promise<{
    success: boolean;
    conflict?: boolean;
    message?: string;
    dataVersion?: number;
    updatedAt?: string;
    fullBlob: Record<string, unknown>;
  }> {
    const baseFullBlob = await this.loadTargetDomainBaseBlob({
      userId: params.userId,
      vaultKey: params.vaultKey,
      domain: params.domain,
      vaultOwnerToken: params.vaultOwnerToken,
    });

    return this.storePreparedDomainWithPreparedBlob({
      ...params,
      baseFullBlob,
      cacheFullBlob: false,
    });
  }

  static async storePreparedDomainWithPreparedBlob(params: {
    userId: string;
    vaultKey: string;
    domain: string;
    domainData: Record<string, unknown>;
    summary: Record<string, unknown>;
    baseFullBlob: Record<string, unknown>;
    mergeDecision?: PkmMergeDecision;
    structureDecision?: Record<string, unknown>;
    manifest?: DomainManifest | null;
    expectedDataVersion?: number;
    vaultOwnerToken?: string;
    cacheFullBlob?: boolean;
  }): Promise<{
    success: boolean;
    conflict?: boolean;
    message?: string;
    dataVersion?: number;
    updatedAt?: string;
    fullBlob: Record<string, unknown>;
  }> {
    const previousManifest = await this.getDomainManifest(
      params.userId,
      params.domain,
      params.vaultOwnerToken
    ).catch(() => null);
    const merged = await this.mergeAndEncryptPreparedBlob({
      baseFullBlob: params.baseFullBlob,
      vaultKey: params.vaultKey,
      domain: params.domain,
      domainData: params.domainData,
      mergeDecision: params.mergeDecision,
    });
    const fallbackArtifacts = buildPersonalKnowledgeModelStructureArtifacts({
      domain: params.domain,
      domainData: merged.domainData,
      previousManifest,
    });
    const useCallerArtifacts = !params.mergeDecision;
    const manifest =
      useCallerArtifacts && params.manifest ? params.manifest : fallbackArtifacts.manifest;
    const structureDecision =
      useCallerArtifacts && params.structureDecision
        ? params.structureDecision
        : fallbackArtifacts.structureDecision;

    const summaryWithIntent = {
      domain_intent: params.domain,
      ...params.summary,
      ...(manifest?.summary_projection || {}),
    };
    const portfolioData = this.resolvePortfolioDataForDomain({
      domain: params.domain,
      domainData: merged.domainData,
    });

    const result = await this.storeDomainData({
      userId: params.userId,
      domain: params.domain,
      encryptedBlob: merged.encryptedBlob,
      summary: summaryWithIntent,
      structureDecision,
      manifest,
      portfolioData,
      expectedDataVersion: params.expectedDataVersion,
      vaultOwnerToken: params.vaultOwnerToken,
    });

    if (result.success && params.domain === "financial") {
      void this.maybeSyncTickersFromFinancialBlob({
        userId: params.userId,
        fullBlob: merged.fullBlob,
        vaultOwnerToken: params.vaultOwnerToken,
      });
    }

    if (result.success && params.cacheFullBlob !== false) {
      const encryptedBlobForCache: EncryptedUserBlob = {
        ...merged.encryptedBlob,
        dataVersion: result.dataVersion,
        updatedAt: result.updatedAt,
      };
      this.cacheDecryptedBlob({
        userId: params.userId,
        marker: this.buildCompositeBlobMarker([encryptedBlobForCache]),
        fullBlob: merged.fullBlob,
      });
    }

    return {
      success: result.success,
      conflict: result.conflict,
      message: result.message,
      dataVersion: result.dataVersion,
      updatedAt: result.updatedAt,
      fullBlob: merged.fullBlob,
    };
  }

  /**
   * Get encrypted domain data blob for decryption on client.
   * This retrieves the encrypted blob stored via storeDomainData().
   * 
   * @param userId - User's ID
   * @param domain - Domain key (e.g., "financial")
   * @returns Encrypted blob with ciphertext, iv, tag, algorithm or null if not found
   */
  static async getDomainData(
    userId: string,
    domain: string,
    vaultOwnerToken?: string,
    segmentIds?: string[]
  ): Promise<EncryptedDomainBlob | null> {
    const cache = CacheService.getInstance();
    const normalizedSegmentIds = this.normalizeSegmentIds(segmentIds);
    const canUseCache = normalizedSegmentIds.length === 0;
    const cacheKey = CACHE_KEYS.ENCRYPTED_DOMAIN_BLOB(userId, domain);
    if (canUseCache) {
      const cached = cache.get<EncryptedDomainBlob>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const dedupeKey = this.inflightKey([
      "domain_blob",
      userId,
      domain,
      normalizedSegmentIds.join(",") || "all_segments",
      Capacitor.isNativePlatform() ? "native" : "web",
      vaultOwnerToken ? "vault_owner" : "anonymous",
    ]);
    const existingRequest = this.domainDataInflight.get(dedupeKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = (async (): Promise<EncryptedDomainBlob | null> => {
      let encryptedBlob: EncryptedDomainBlob | null = null;

      if (Capacitor.isNativePlatform()) {
        const result = await HushhPersonalKnowledgeModel.getDomainData({
          userId,
          domain,
          segmentIds: normalizedSegmentIds.length > 0 ? normalizedSegmentIds : undefined,
          vaultOwnerToken: this.getVaultOwnerToken(vaultOwnerToken),
        });
        if (result.encrypted_blob) {
          const nativeSegments =
            result.encrypted_blob.segments && typeof result.encrypted_blob.segments === "object"
              ? Object.fromEntries(
                  Object.entries(result.encrypted_blob.segments).map(([segmentId, segmentBlob]) => [
                    segmentId,
                    {
                      ciphertext: (segmentBlob as Record<string, unknown>).ciphertext as string,
                      iv: (segmentBlob as Record<string, unknown>).iv as string,
                      tag: (segmentBlob as Record<string, unknown>).tag as string,
                      algorithm:
                        ((segmentBlob as Record<string, unknown>).algorithm as string) ||
                        "aes-256-gcm",
                    },
                  ])
                )
              : undefined;
          encryptedBlob = {
            ciphertext: result.encrypted_blob.ciphertext,
            iv: result.encrypted_blob.iv,
            tag: result.encrypted_blob.tag,
            algorithm: result.encrypted_blob.algorithm || "aes-256-gcm",
            segments: nativeSegments,
            storageMode:
              (result.storage_mode as "domain" | "legacy_full_blob" | undefined) || "domain",
            dataVersion:
              typeof result.data_version === "number" ? result.data_version : undefined,
            updatedAt:
              typeof result.updated_at === "string" ? result.updated_at : undefined,
            manifestRevision:
              typeof result.manifest_revision === "number" ? result.manifest_revision : undefined,
            segmentIds: Array.isArray(result.segment_ids)
              ? (result.segment_ids as string[])
              : undefined,
          };
        }
      } else {
        // Web: Use ApiService.apiFetch() for tri-flow compliance
        const response = await ApiService.apiFetch(
          `${this.PKM_API_PREFIX}/domain-data/${userId}/${domain}${
            normalizedSegmentIds.length > 0
              ? `?${normalizedSegmentIds
                  .map((segmentId) => `segment_ids=${encodeURIComponent(segmentId)}`)
                  .join("&")}`
              : ""
          }`,
          {
            headers: this.getAuthHeaders(vaultOwnerToken),
          }
        );

        if (!response.ok) {
          if (response.status === 404) {
            return null;
          }
          throw new Error(`Failed to get domain data: ${response.status}`);
        }

        const data = await response.json();
        if (data.encrypted_blob) {
          const segments =
            data.encrypted_blob.segments && typeof data.encrypted_blob.segments === "object"
              ? Object.fromEntries(
                  Object.entries(data.encrypted_blob.segments as Record<string, unknown>).map(
                    ([segmentId, segmentBlob]) => [
                      segmentId,
                      {
                        ciphertext: (segmentBlob as Record<string, unknown>).ciphertext as string,
                        iv: (segmentBlob as Record<string, unknown>).iv as string,
                        tag: (segmentBlob as Record<string, unknown>).tag as string,
                        algorithm:
                          ((segmentBlob as Record<string, unknown>).algorithm as string) ||
                          "aes-256-gcm",
                      },
                    ]
                  )
                )
              : undefined;
          encryptedBlob = {
            ciphertext: data.encrypted_blob.ciphertext,
            iv: data.encrypted_blob.iv,
            tag: data.encrypted_blob.tag,
            algorithm: data.encrypted_blob.algorithm || "aes-256-gcm",
            segments,
            storageMode:
              (data.storage_mode as "domain" | "legacy_full_blob" | undefined) || "domain",
            dataVersion: typeof data.data_version === "number" ? data.data_version : undefined,
            updatedAt: typeof data.updated_at === "string" ? data.updated_at : undefined,
            manifestRevision:
              typeof data.manifest_revision === "number" ? data.manifest_revision : undefined,
            segmentIds: Array.isArray(data.segment_ids)
              ? (data.segment_ids as string[])
              : undefined,
          };
        }
      }

      if (encryptedBlob && canUseCache) {
        cache.set(cacheKey, encryptedBlob, CACHE_TTL.SESSION);
      } else if (!encryptedBlob && canUseCache) {
        cache.invalidate(cacheKey);
      }

      return encryptedBlob;
    })();

    this.domainDataInflight.set(dedupeKey, request);
    try {
      return await request;
    } finally {
      if (this.domainDataInflight.get(dedupeKey) === request) {
        this.domainDataInflight.delete(dedupeKey);
      }
    }
  }

  static async loadDomainData(params: {
    userId: string;
    domain: string;
    vaultKey: string;
    vaultOwnerToken?: string;
    segmentIds?: string[];
  }): Promise<Record<string, unknown> | null> {
    const blob = await this.getDomainData(
      params.userId,
      params.domain,
      params.vaultOwnerToken,
      params.segmentIds
    );
    if (!blob) {
      return null;
    }

    if (blob.storageMode === "legacy_full_blob") {
      const fullBlob = await this.loadFullBlob({
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
      });
      const domainData = fullBlob[params.domain];
      if (!domainData || typeof domainData !== "object" || Array.isArray(domainData)) {
        return {};
      }
      return domainData as Record<string, unknown>;
    }

    return this.decryptDomainBlob({
      vaultKey: params.vaultKey,
      domain: params.domain,
      blob,
      segmentIds: params.segmentIds,
    });
  }

  /**
   * Clear all data for a specific domain.
   * This removes the encrypted blob and updates the PKM index.
   *
   * @param userId - User's ID
   * @param domain - Domain key (e.g., "financial")
   * @returns Success status
   */
  static async clearDomain(
    userId: string,
    domain: string,
    vaultOwnerToken?: string
  ): Promise<boolean> {
    const invalidateDomainCaches = () => {
      CacheSyncService.onPkmDomainCleared(userId, domain);
    };

    if (Capacitor.isNativePlatform()) {
      const result = await HushhPersonalKnowledgeModel.clearDomain({
        userId,
        domain,
        vaultOwnerToken: this.getVaultOwnerToken(vaultOwnerToken),
      });
      if (result.success) {
        invalidateDomainCaches();
      }
      return result.success;
    }

    // Web: Use ApiService.apiFetch() for tri-flow compliance
    const response = await ApiService.apiFetch(
      `${this.PKM_API_PREFIX}/domain-data/${userId}/${domain}`,
      {
        method: "DELETE",
        headers: this.getAuthHeaders(vaultOwnerToken),
      }
    );

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to clear domain: ${response.status}`);
    }

    invalidateDomainCaches();
    return true;
  }
}

export default PersonalKnowledgeModelService;
