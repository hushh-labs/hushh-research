// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  addSavedLocation,
  defaultLabelForCategory,
  loadSavedLocations,
  removeSavedLocation,
  sortSavedLocationsForDisplay,
} from "@/lib/one-location/saved-locations";

const USER = "user-123";

beforeEach(() => {
  window.localStorage.clear();
});

describe("saved-locations store", () => {
  it("returns an empty list when nothing is saved", async () => {
    expect(await loadSavedLocations(USER)).toEqual([]);
  });

  it("saves a home location and reads it back", async () => {
    await addSavedLocation(USER, {
      category: "home",
      latitude: 28.6139,
      longitude: 77.209,
      address: "New Delhi",
    });
    const list = await loadSavedLocations(USER);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      category: "home",
      label: "Home",
      latitude: 28.6139,
      longitude: 77.209,
      address: "New Delhi",
    });
    expect(list[0]?.id).toBe("home");
  });

  it("treats home and work as singletons (replace on re-save)", async () => {
    await addSavedLocation(USER, {
      category: "home",
      latitude: 1,
      longitude: 1,
    });
    await addSavedLocation(USER, {
      category: "home",
      latitude: 2,
      longitude: 2,
    });
    const list = await loadSavedLocations(USER);
    const homes = list.filter((l) => l.category === "home");
    expect(homes).toHaveLength(1);
    expect(homes[0]?.latitude).toBe(2);
  });

  it("allows multiple distinct 'other' places with custom labels", async () => {
    await addSavedLocation(USER, {
      category: "other",
      label: "Gym",
      latitude: 10,
      longitude: 10,
    });
    await addSavedLocation(USER, {
      category: "other",
      label: "Cafe",
      latitude: 20,
      longitude: 20,
    });
    const list = await loadSavedLocations(USER);
    expect(list.filter((l) => l.category === "other")).toHaveLength(2);
  });

  it("de-duplicates an identical 'other' place (same label + coords)", async () => {
    await addSavedLocation(USER, {
      category: "other",
      label: "Gym",
      latitude: 10,
      longitude: 10,
    });
    await addSavedLocation(USER, {
      category: "other",
      label: "Gym",
      latitude: 10,
      longitude: 10,
    });
    const list = await loadSavedLocations(USER);
    expect(list.filter((l) => l.category === "other")).toHaveLength(1);
  });

  it("falls back to the default label when none is provided", async () => {
    await addSavedLocation(USER, {
      category: "other",
      latitude: 5,
      longitude: 5,
    });
    const list = await loadSavedLocations(USER);
    expect(list[0]?.label).toBe("Other");
  });

  it("ignores non-finite coordinates", async () => {
    await addSavedLocation(USER, {
      category: "home",
      latitude: Number.NaN,
      longitude: 5,
    });
    expect(await loadSavedLocations(USER)).toEqual([]);
  });

  it("removes a saved location by id", async () => {
    await addSavedLocation(USER, {
      category: "home",
      latitude: 1,
      longitude: 1,
    });
    await addSavedLocation(USER, {
      category: "work",
      latitude: 2,
      longitude: 2,
    });
    const next = await removeSavedLocation(USER, "home");
    expect(next.some((l) => l.id === "home")).toBe(false);
    expect(next.some((l) => l.id === "work")).toBe(true);
  });

  it("scopes storage per user", async () => {
    await addSavedLocation(USER, {
      category: "home",
      latitude: 1,
      longitude: 1,
    });
    expect(await loadSavedLocations("other-user")).toEqual([]);
  });

  it("sorts home first, then work, then others", () => {
    const now = new Date().toISOString();
    const sorted = sortSavedLocationsForDisplay([
      { id: "other-1", category: "other", label: "Gym", latitude: 0, longitude: 0, savedAt: now },
      { id: "work", category: "work", label: "Work", latitude: 0, longitude: 0, savedAt: now },
      { id: "home", category: "home", label: "Home", latitude: 0, longitude: 0, savedAt: now },
    ]);
    expect(sorted.map((l) => l.category)).toEqual(["home", "work", "other"]);
  });

  it("exposes default labels per category", () => {
    expect(defaultLabelForCategory("home")).toBe("Home");
    expect(defaultLabelForCategory("work")).toBe("Work");
    expect(defaultLabelForCategory("other")).toBe("Other");
  });
});
