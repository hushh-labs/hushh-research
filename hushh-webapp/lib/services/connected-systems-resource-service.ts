"use client";

import { DeviceResourceCacheService } from "@/lib/services/device-resource-cache-service";
import {
  ConnectedSystemsService,
  type ConnectedSystemMcpResponse,
  type ConnectedSystemSchemaResponse,
  type ConnectedSystemsRegistryResponse,
} from "@/lib/services/connected-systems-service";
import {
  CacheService,
  CACHE_KEYS,
  CACHE_TTL,
} from "@/lib/services/cache-service";

const SAFE_METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const UNAVAILABLE_MAPPING_TTL_MS = 60 * 1000;
const DEVICE_REGISTRY_KEY = "connected_systems:registry:v1";

function deviceSchemaKey(params: {
  systemId: string;
  objectType: string;
  configurationRevision: number;
}): string {
  return `connected_systems:schema:${params.systemId}:${params.objectType}:${params.configurationRevision}`;
}

export class ConnectedSystemsResourceService {
  private static registryInFlight = new Map<
    string,
    Promise<ConnectedSystemsRegistryResponse>
  >();
  private static schemaInFlight = new Map<string, Promise<ConnectedSystemSchemaResponse>>();
  private static bindingStatusInFlight = new Map<
    string,
    Promise<Array<{ systemId: string; objectType: string; status: string }>>
  >();
  private static bindingStatusByUser = new Map<
    string,
    Array<{ systemId: string; objectType: string; status: string }>
  >();
  private static protectedEpochByUser = new Map<string, number>();
  private static liveRecordByUserSystem = new Map<
    string,
    { record: ConnectedSystemMcpResponse; cachedAt: number }
  >();

  static registryCacheKey(userId: string): string {
    return CACHE_KEYS.CONNECTED_SYSTEMS_REGISTRY(userId);
  }

  static schemaCacheKey(params: {
    userId: string;
    systemId: string;
    objectType: string;
    configurationRevision: number;
  }): string {
    return CACHE_KEYS.CONNECTED_SYSTEM_SCHEMA(
      params.userId,
      params.systemId,
      `${params.objectType}_${params.configurationRevision}`
    );
  }

  static async hydrateRegistry(userId: string): Promise<ConnectedSystemsRegistryResponse | null> {
    if (!userId) return null;
    const cache = CacheService.getInstance();
    const memory = cache.get<ConnectedSystemsRegistryResponse>(this.registryCacheKey(userId));
    if (memory) return memory;
    const device = await DeviceResourceCacheService.read<ConnectedSystemsRegistryResponse>({
      userId,
      resourceKey: DEVICE_REGISTRY_KEY,
    });
    if (device) {
      cache.set(this.registryCacheKey(userId), device, CACHE_TTL.MEDIUM);
    }
    return device;
  }

  static async loadRegistry(params: {
    userId: string;
    authToken: string;
  }): Promise<ConnectedSystemsRegistryResponse> {
    const existing = this.registryInFlight.get(params.userId);
    if (existing) return existing;
    const request = (async () => {
      await this.hydrateRegistry(params.userId);
      const previous = CacheService.getInstance().get<ConnectedSystemsRegistryResponse>(
        this.registryCacheKey(params.userId)
      );
      const registry = await ConnectedSystemsService.getRegistry(params.authToken);
      const activeIds = new Set(registry.systems.map((system) => system.systemId));
      for (const removed of previous?.systems ?? []) {
        if (activeIds.has(removed.systemId)) continue;
        CacheService.getInstance().invalidatePattern(
          `connected_systems_${params.userId}_schema_${removed.systemId}_`
        );
        await DeviceResourceCacheService.invalidateResourcePrefix(
          params.userId,
          `connected_systems:schema:${removed.systemId}:`
        );
      }
      for (const system of registry.systems) {
        const oldRevision = previous?.systems.find(
          (candidate) => candidate.systemId === system.systemId
        )?.configurationRevision;
        if (
          oldRevision != null &&
          oldRevision !== system.configurationRevision
        ) {
          CacheService.getInstance().invalidatePattern(
            `connected_systems_${params.userId}_schema_${system.systemId}_`
          );
          await DeviceResourceCacheService.invalidateResourcePrefix(
            params.userId,
            `connected_systems:schema:${system.systemId}:`
          );
        }
      }
      CacheService.getInstance().set(
        this.registryCacheKey(params.userId),
        registry,
        CACHE_TTL.MEDIUM
      );
      await DeviceResourceCacheService.write({
        userId: params.userId,
        resourceKey: DEVICE_REGISTRY_KEY,
        value: registry,
        ttlMs: SAFE_METADATA_TTL_MS,
      });
      return registry;
    })();
    this.registryInFlight.set(params.userId, request);
    try {
      return await request;
    } finally {
      this.registryInFlight.delete(params.userId);
    }
  }

  static async hydrateSchema(params: {
    userId: string;
    systemId: string;
    objectType: string;
    configurationRevision: number;
  }): Promise<ConnectedSystemSchemaResponse | null> {
    const cacheKey = this.schemaCacheKey(params);
    const cache = CacheService.getInstance();
    const memory = cache.get<ConnectedSystemSchemaResponse>(cacheKey);
    if (memory) return memory;
    const device = await DeviceResourceCacheService.read<ConnectedSystemSchemaResponse>({
      userId: params.userId,
      resourceKey: deviceSchemaKey(params),
    });
    if (device) cache.set(cacheKey, device, SAFE_METADATA_TTL_MS);
    return device;
  }

  static async loadSchema(params: {
    userId: string;
    vaultOwnerToken: string;
    systemId: string;
    objectType: string;
    configurationRevision: number;
    forceRefresh?: boolean;
  }): Promise<ConnectedSystemSchemaResponse> {
    const cacheKey = this.schemaCacheKey(params);
    const existing = this.schemaInFlight.get(cacheKey);
    if (existing) return existing;
    const request = (async () => {
      if (!params.forceRefresh) await this.hydrateSchema(params);
      const schema = await ConnectedSystemsService.getSchema({
        vaultOwnerToken: params.vaultOwnerToken,
        systemId: params.systemId,
        objectType: params.objectType,
        forceRefresh: params.forceRefresh,
      });
      const ready =
        schema.schemaMappingStatus === "ready" &&
        schema.freshness !== "stale_display_only";
      CacheService.getInstance().set(
        cacheKey,
        schema,
        ready ? SAFE_METADATA_TTL_MS : UNAVAILABLE_MAPPING_TTL_MS
      );
      if (ready) {
        await DeviceResourceCacheService.write({
          userId: params.userId,
          resourceKey: deviceSchemaKey(params),
          value: schema,
          ttlMs: SAFE_METADATA_TTL_MS,
        });
      }
      return schema;
    })();
    this.schemaInFlight.set(cacheKey, request);
    try {
      return await request;
    } finally {
      this.schemaInFlight.delete(cacheKey);
    }
  }

  static async warmBindingStatuses(params: {
    userId: string;
    vaultOwnerToken: string;
  }): Promise<Array<{ systemId: string; objectType: string; status: string }>> {
    const existing = this.bindingStatusInFlight.get(params.userId);
    if (existing) return existing;
    const epoch = this.protectedEpochByUser.get(params.userId) ?? 0;
    const request = ConnectedSystemsService.listRecordBindingStatuses(
      params.vaultOwnerToken
    ).then((result) => {
      if ((this.protectedEpochByUser.get(params.userId) ?? 0) === epoch) {
        this.bindingStatusByUser.set(params.userId, result.bindings);
      }
      return result.bindings;
    });
    this.bindingStatusInFlight.set(params.userId, request);
    try {
      return await request;
    } finally {
      this.bindingStatusInFlight.delete(params.userId);
    }
  }

  static getBindingStatuses(
    userId: string
  ): Array<{ systemId: string; objectType: string; status: string }> {
    return this.bindingStatusByUser.get(userId) ?? [];
  }

  static rememberLiveRecord(
    userId: string,
    systemId: string,
    record: ConnectedSystemMcpResponse
  ): void {
    this.liveRecordByUserSystem.set(`${userId}:${systemId}`, {
      record,
      cachedAt: Date.now(),
    });
  }

  static getLiveRecord(
    userId: string,
    systemId: string
  ): ConnectedSystemMcpResponse | null {
    return this.getLiveRecordSnapshot(userId, systemId)?.record ?? null;
  }

  static getLiveRecordSnapshot(
    userId: string,
    systemId: string
  ): { record: ConnectedSystemMcpResponse; cachedAt: number } | null {
    return this.liveRecordByUserSystem.get(`${userId}:${systemId}`) ?? null;
  }

  static clearProtected(userId: string): void {
    this.protectedEpochByUser.set(
      userId,
      (this.protectedEpochByUser.get(userId) ?? 0) + 1
    );
    this.bindingStatusByUser.delete(userId);
    for (const key of this.liveRecordByUserSystem.keys()) {
      if (key.startsWith(`${userId}:`)) this.liveRecordByUserSystem.delete(key);
    }
  }

  static async purgeUser(userId: string): Promise<void> {
    this.clearProtected(userId);
    CacheService.getInstance().invalidatePattern(`connected_systems_${userId}_`);
    await DeviceResourceCacheService.invalidateResourcePrefix(userId, "connected_systems:");
  }
}
