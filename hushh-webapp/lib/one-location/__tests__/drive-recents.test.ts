import { describe, expect, it, beforeEach } from "vitest";

import {
  addRecentDestination,
  loadRecentDestinations,
} from "@/lib/one-location/drive-recents";

const dest = (label: string, placeId?: string) => ({
  label,
  latitude: 1,
  longitude: 2,
  placeId: placeId ?? null,
});

describe("drive-recents", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns empty when none stored", async () => {
    expect(await loadRecentDestinations("u1")).toEqual([]);
  });

  it("adds most-recent first", async () => {
    await addRecentDestination("u1", dest("A", "a"));
    await addRecentDestination("u1", dest("B", "b"));
    const out = await loadRecentDestinations("u1");
    expect(out.map((d) => d.label)).toEqual(["B", "A"]);
  });

  it("dedupes by placeId and caps at 5", async () => {
    for (const l of ["A", "B", "C", "D", "E", "F"]) {
      await addRecentDestination("u1", dest(l, l.toLowerCase()));
    }
    await addRecentDestination("u1", dest("A2", "a")); // same placeId as A
    const out = await loadRecentDestinations("u1");
    expect(out).toHaveLength(5);
    expect(out[0]!.label).toBe("A2");
    expect(out.filter((d) => d.placeId === "a")).toHaveLength(1);
  });

  it("scopes by userId", async () => {
    await addRecentDestination("u1", dest("A", "a"));
    expect(await loadRecentDestinations("u2")).toEqual([]);
  });
});
