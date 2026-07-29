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
    ConnectedSystemsResourceService.clearProtected("user-1");
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

  it("publishes cold registry metadata before the network refresh settles", async () => {
    const stored = { registryRevision: 2, systems: [] };
    const refreshed = { registryRevision: 3, systems: [] };
    let resolveNetwork: ((value: typeof refreshed) => void) | null = null;
    vi.mocked(DeviceResourceCacheService.read).mockResolvedValueOnce(stored);
    vi.mocked(ConnectedSystemsService.getRegistry).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNetwork = resolve;
      }),
    );

    const pending = ConnectedSystemsResourceService.loadRegistry({
      userId: "user-1",
      authToken: "auth-token",
    });
    await vi.waitFor(() => {
      expect(
        CacheService.getInstance().peek(
          ConnectedSystemsResourceService.registryCacheKey("user-1"),
        )?.data,
      ).toEqual(stored);
    });

    resolveNetwork?.(refreshed);
    await expect(pending).resolves.toEqual(refreshed);
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

  it("keeps a loaded CRM record in protected L1 with refresh metadata", () => {
    const record = { systemId: "crm-1", records: [{ Id: "record-1" }] };
    ConnectedSystemsResourceService.rememberLiveRecord("user-1", "crm-1", record);

    expect(
      ConnectedSystemsResourceService.getLiveRecordSnapshot("user-1", "crm-1"),
    ).toEqual({ record, cachedAt: expect.any(Number) });
    expect(DeviceResourceCacheService.write).not.toHaveBeenCalled();

    ConnectedSystemsResourceService.clearProtected("user-1");
    expect(
      ConnectedSystemsResourceService.getLiveRecordSnapshot("user-1", "crm-1"),
    ).toBeNull();
  });

  it("removes only the recovered CRM record and updates its list status", async () => {
    vi.mocked(ConnectedSystemsService.listRecordBindingStatuses).mockResolvedValue({
      bindings: [
        { systemId: "crm-1", objectType: "Person", status: "active" },
        { systemId: "crm-2", objectType: "Contact", status: "active" },
      ],
    });
    await ConnectedSystemsResourceService.warmBindingStatuses({
      userId: "user-1",
      vaultOwnerToken: "owner-token",
    });
    ConnectedSystemsResourceService.rememberLiveRecord("user-1", "crm-1", {
      systemId: "crm-1",
      target: "CRM 1",
      objectType: "Person",
      resultClass: "succeeded",
      records: [],
    });
    ConnectedSystemsResourceService.rememberLiveRecord("user-1", "crm-2", {
      systemId: "crm-2",
      target: "CRM 2",
      objectType: "Contact",
      resultClass: "succeeded",
      records: [],
    });

    ConnectedSystemsResourceService.forgetLiveRecord("user-1", "crm-1");
    ConnectedSystemsResourceService.rememberBindingStatus("user-1", {
      systemId: "crm-1",
      objectType: "Person",
      status: "unbound",
    });

    expect(
      ConnectedSystemsResourceService.getLiveRecord("user-1", "crm-1"),
    ).toBeNull();
    expect(
      ConnectedSystemsResourceService.getLiveRecord("user-1", "crm-2"),
    ).not.toBeNull();
    expect(
      ConnectedSystemsResourceService.getBindingStatuses("user-1"),
    ).toEqual([
      { systemId: "crm-2", objectType: "Contact", status: "active" },
      { systemId: "crm-1", objectType: "Person", status: "unbound" },
    ]);
  });
});
