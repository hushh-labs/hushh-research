import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectedSystemsResourceService } from "@/lib/services/connected-systems-resource-service";
import { ConnectedSystemsService } from "@/lib/services/connected-systems-service";
import { CacheService } from "@/lib/services/cache-service";
import { DeviceResourceCacheService } from "@/lib/services/device-resource-cache-service";

vi.mock("@/lib/services/connected-systems-service", () => ({
  ConnectedSystemsService: {
    getRegistry: vi.fn(),
    getSchema: vi.fn(),
    listRecordBindingStatuses: vi.fn(),
  },
}));

vi.mock("@/lib/services/device-resource-cache-service", () => ({
  DeviceResourceCacheService: {
    read: vi.fn(),
    write: vi.fn(),
    invalidateResourcePrefix: vi.fn(),
  },
}));

describe("ConnectedSystemsResourceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CacheService.getInstance().clear();
    vi.mocked(DeviceResourceCacheService.read).mockResolvedValue(null);
    vi.mocked(DeviceResourceCacheService.write).mockResolvedValue(undefined);
    vi.mocked(DeviceResourceCacheService.invalidateResourcePrefix).mockResolvedValue(undefined);
  });

  it("hydrates safe registry metadata from L2 before background network data replaces it", async () => {
    const stored = { registryRevision: 2, systems: [] };
    vi.mocked(DeviceResourceCacheService.read).mockResolvedValueOnce(stored);

    expect(await ConnectedSystemsResourceService.hydrateRegistry("user-1")).toEqual(stored);
    expect(
      CacheService.getInstance().get(
        ConnectedSystemsResourceService.registryCacheKey("user-1")
      )
    ).toEqual(stored);
  });

  it("persists only ready normalized schemas", async () => {
    vi.mocked(ConnectedSystemsService.getSchema)
      .mockResolvedValueOnce({
        systemId: "crm-1",
        target: "CRM",
        objectType: "Person",
        supportedFields: [],
        schemaMappingStatus: "unavailable",
      })
      .mockResolvedValueOnce({
        systemId: "crm-1",
        target: "CRM",
        objectType: "Person",
        supportedFields: ["Email"],
        schemaMappingStatus: "ready",
      });

    const input = {
      userId: "user-1",
      vaultOwnerToken: "owner-token",
      systemId: "crm-1",
      objectType: "Person",
      configurationRevision: 4,
    };
    await ConnectedSystemsResourceService.loadSchema(input);
    expect(DeviceResourceCacheService.write).not.toHaveBeenCalled();

    await ConnectedSystemsResourceService.loadSchema({ ...input, forceRefresh: true });
    expect(DeviceResourceCacheService.write).toHaveBeenCalledOnce();
  });

  it("keeps binding status memory-only and clears it on vault lock", async () => {
    vi.mocked(ConnectedSystemsService.listRecordBindingStatuses).mockResolvedValue({
      bindings: [{ systemId: "crm-1", objectType: "Person", status: "active" }],
    });
    await ConnectedSystemsResourceService.warmBindingStatuses({
      userId: "user-1",
      vaultOwnerToken: "owner-token",
    });
    expect(ConnectedSystemsResourceService.getBindingStatuses("user-1")).toHaveLength(1);
    expect(DeviceResourceCacheService.write).not.toHaveBeenCalled();

    ConnectedSystemsResourceService.clearProtected("user-1");
    expect(ConnectedSystemsResourceService.getBindingStatuses("user-1")).toEqual([]);
  });
});
