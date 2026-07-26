// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const pkm = vi.hoisted(() => ({
  domainData: {} as Record<string, unknown>,
  lastPlan: null as Record<string, unknown> | null,
  getStaleFirst: vi.fn(),
  saveMergedDomain: vi.fn(),
}));

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    getStaleFirst: pkm.getStaleFirst,
  },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: pkm.saveMergedDomain,
  },
}));

import {
  addSavedLocation,
  defaultLabelForCategory,
  loadSavedLocations,
  LOCATION_PKM_DOMAIN,
  removeSavedLocation,
  sortSavedLocationsForDisplay,
  updateSavedLocationAddress,
} from "@/lib/one-location/saved-locations";

const CONTEXT = {
  userId: "user-123",
  vaultKey: "vault-key",
  vaultOwnerToken: "vault-owner-token",
};

beforeEach(() => {
  pkm.domainData = {};
  pkm.lastPlan = null;
  pkm.getStaleFirst.mockReset();
  pkm.saveMergedDomain.mockReset();
  pkm.getStaleFirst.mockImplementation(async () => ({
    data: pkm.domainData,
    audit: {
      source: "network",
    },
  }));
  pkm.saveMergedDomain.mockImplementation(
    async (rawParams: Record<string, unknown>) => {
      const build = rawParams.build as (context: {
        currentDomainData: Record<string, unknown>;
        currentManifest: null;
      }) => Record<string, unknown>;
      const plan = await build({
        currentDomainData: pkm.domainData,
        currentManifest: null,
      });
      pkm.lastPlan = plan;
      pkm.domainData = plan.domainData as Record<string, unknown>;
      return {
        success: true,
        saveState: "saved",
        fullBlob: { [LOCATION_PKM_DOMAIN]: pkm.domainData },
      };
    },
  );
});

describe("encrypted saved-locations PKM store", () => {
  it("reads an empty encrypted Location domain", async () => {
    expect(await loadSavedLocations(CONTEXT)).toEqual([]);
    expect(pkm.getStaleFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: CONTEXT.userId,
        domain: LOCATION_PKM_DOMAIN,
        vaultKey: CONTEXT.vaultKey,
        vaultOwnerToken: CONTEXT.vaultOwnerToken,
        backgroundRefresh: false,
      }),
    );
  });

  it("saves Home to encrypted PKM without writing raw data to localStorage", async () => {
    const localStorageWrite = vi.spyOn(Storage.prototype, "setItem");

    const locations = await addSavedLocation({
      context: CONTEXT,
      input: {
        category: "home",
        latitude: 28.6139,
        longitude: 77.209,
        address: "New Delhi",
      },
    });

    expect(locations[0]).toMatchObject({
      id: "home",
      category: "home",
      label: "Home",
      latitude: 28.6139,
      longitude: 77.209,
      address: "New Delhi",
    });
    expect(pkm.saveMergedDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: CONTEXT.userId,
        domain: LOCATION_PKM_DOMAIN,
        vaultKey: CONTEXT.vaultKey,
        vaultOwnerToken: CONTEXT.vaultOwnerToken,
        confirmation: expect.objectContaining({
          confirmedByUser: true,
          source: "one_location_saved_place_confirm",
        }),
      }),
    );
    expect(localStorageWrite).not.toHaveBeenCalled();
    localStorageWrite.mockRestore();
  });

  it("preserves existing Location-domain information while adding saved places", async () => {
    pkm.domainData = {
      mobility_preferences: {
        presence_mode: "precise",
      },
    };

    await addSavedLocation({
      context: CONTEXT,
      input: {
        category: "work",
        latitude: 12.9716,
        longitude: 77.5946,
      },
    });

    expect(pkm.domainData.mobility_preferences).toEqual({
      presence_mode: "precise",
    });
    expect(pkm.lastPlan).toMatchObject({
      scopePath: "saved_places",
      summary: {
        saved_places_configured: true,
        saved_places_count: 1,
      },
    });
    expect(JSON.stringify(pkm.lastPlan?.summary)).not.toContain("12.9716");
  });

  it("treats Home and Work as singletons", async () => {
    await addSavedLocation({
      context: CONTEXT,
      input: { category: "home", latitude: 1, longitude: 1 },
    });
    const locations = await addSavedLocation({
      context: CONTEXT,
      input: { category: "home", latitude: 2, longitude: 2 },
    });

    expect(locations.filter((location) => location.category === "home")).toHaveLength(1);
    expect(locations[0]?.latitude).toBe(2);
  });

  it("keeps distinct Other places and de-duplicates a matching one", async () => {
    await addSavedLocation({
      context: CONTEXT,
      input: {
        category: "other",
        label: "Gym",
        latitude: 10,
        longitude: 10,
      },
    });
    await addSavedLocation({
      context: CONTEXT,
      input: {
        category: "other",
        label: "Cafe",
        latitude: 20,
        longitude: 20,
      },
    });
    const locations = await addSavedLocation({
      context: CONTEXT,
      input: {
        category: "other",
        label: "Gym",
        latitude: 10,
        longitude: 10,
      },
    });

    expect(locations.filter((location) => location.category === "other")).toHaveLength(2);
    expect(locations.map((location) => location.label).sort()).toEqual([
      "Cafe",
      "Gym",
    ]);
  });

  it("rejects invalid coordinates before any PKM write", async () => {
    await expect(
      addSavedLocation({
        context: CONTEXT,
        input: {
          category: "home",
          latitude: Number.NaN,
          longitude: 5,
        },
      }),
    ).rejects.toThrow(/invalid/i);
    expect(pkm.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("fails closed when the vault is locked", async () => {
    await expect(
      loadSavedLocations({
        ...CONTEXT,
        vaultKey: null,
        vaultOwnerToken: null,
      }),
    ).rejects.toThrow(/unlock your vault/i);
    expect(pkm.getStaleFirst).not.toHaveBeenCalled();
  });

  it("removes a place and repairs its address through confirmed PKM writes", async () => {
    await addSavedLocation({
      context: CONTEXT,
      input: {
        category: "home",
        latitude: 12.9763,
        longitude: 77.5929,
      },
    });
    await addSavedLocation({
      context: CONTEXT,
      input: {
        category: "work",
        latitude: 12.9352,
        longitude: 77.6245,
      },
    });

    const repaired = await updateSavedLocationAddress({
      context: CONTEXT,
      id: "home",
      address: "Kasturba Road, Bengaluru, Karnataka 560001, India",
    });
    expect(repaired.find((location) => location.id === "home")?.address).toBe(
      "Kasturba Road, Bengaluru, Karnataka 560001, India",
    );

    const remaining = await removeSavedLocation({
      context: CONTEXT,
      id: "home",
    });
    expect(remaining.map((location) => location.id)).toEqual(["work"]);
  });

  it("sorts Home, Work, then recent Other places", () => {
    const sorted = sortSavedLocationsForDisplay([
      {
        id: "other-1",
        category: "other",
        label: "Gym",
        latitude: 0,
        longitude: 0,
        savedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "work",
        category: "work",
        label: "Work",
        latitude: 0,
        longitude: 0,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "home",
        category: "home",
        label: "Home",
        latitude: 0,
        longitude: 0,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(sorted.map((location) => location.category)).toEqual([
      "home",
      "work",
      "other",
    ]);
  });

  it("exposes safe default labels", () => {
    expect(defaultLabelForCategory("home")).toBe("Home");
    expect(defaultLabelForCategory("work")).toBe("Work");
    expect(defaultLabelForCategory("other")).toBe("Other");
  });
});
