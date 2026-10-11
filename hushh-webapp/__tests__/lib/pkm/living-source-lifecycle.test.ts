import { describe, expect, it } from "vitest";
import {
  reconcileLivingSources,
  type LivingSourceInput,
} from "@/lib/pkm/living-source-records";
import { sourceReceipts } from "@/lib/pkm/living-source-receipts";
import { collectDomainRows } from "@/lib/pkm/memory-complete-rows";
const T1 = "2026-10-11T00:00:00.000Z",
  T2 = "2026-10-11T00:01:00.000Z",
  T3 = "2026-10-11T00:02:00.000Z";
const profile = (name: string): LivingSourceInput => ({
  kind: "profile",
  id: "owner",
  value: { name, photo: "https://example.test/avatar.png" },
  createdAt: T1,
  updatedAt: T2,
});
const consent: LivingSourceInput = {
  kind: "consent",
  id: "grant-1",
  value: { scope: "attr.travel.visits", status: "approved", active: true },
  createdAt: T1,
  updatedAt: T1,
};
it("retains source identity and creation time, increments edits and is replay stable", () => {
  const a = reconcileLivingSources(
    null,
    [profile("Old"), consent],
    ["profile", "consent"],
    [],
    T1,
  );
  const b = reconcileLivingSources(
    a,
    [profile("New"), consent],
    ["profile", "consent"],
    [],
    T2,
  );
  expect(b.records.find((r) => r.kind === "profile")).toMatchObject({
    id: "owner",
    revision: 2,
    createdAt: T1,
    capturedAt: T2,
    value: { name: "New" },
  });
  expect(
    reconcileLivingSources(
      b,
      [profile("New"), consent],
      ["profile", "consent"],
      [],
      T3,
    ).records,
  ).toEqual(b.records);
});
it("does not delete unavailable sources, then tombstones after full verified readback", () => {
  const a = reconcileLivingSources(
    null,
    [profile("Owner"), consent],
    ["profile", "consent"],
    [],
    T1,
  );
  const failed = reconcileLivingSources(
    a,
    [profile("Owner")],
    ["profile"],
    ["consent"],
    T2,
  );
  expect(failed.complete).toBe(false);
  expect(failed.records.find((r) => r.id === consent.id)).toEqual(
    a.records.find((r) => r.id === consent.id),
  );
  const deleted = reconcileLivingSources(
    failed,
    [profile("Owner")],
    ["profile", "consent"],
    [],
    T3,
  );
  expect(deleted.records.find((r) => r.id === consent.id)).toMatchObject({
    value: {},
    revision: 2,
    createdAt: T1,
    deletedAt: T3,
  });
  const restored = JSON.parse(JSON.stringify(deleted));
  expect(
    reconcileLivingSources(
      restored,
      [profile("Owner")],
      ["profile", "consent"],
      [],
      T3,
    ).records,
  ).toEqual(deleted.records);
  const rows = collectDomainRows({
    domain: "one_living_sources",
    domainData: { _private: { inventory: restored } },
    audience: "self",
  });
  expect(JSON.stringify(rows.rows)).not.toContain("attr.travel.visits");
  expect(JSON.stringify(rows.rows)).toContain("deletedAt");
  expect(
    collectDomainRows({
      domain: "one_living_sources",
      domainData: { _private: { inventory: restored } },
      audience: "agent",
    }).rows,
  ).toEqual([]);
});
it("preserves every source record rather than a display-page cap", () => {
  const inputs = Array.from({ length: 401 }, (_, i): LivingSourceInput => ({
    ...consent,
    id: `grant-${i}`,
    value: { text: "x".repeat(500) },
  }));
  const inventory = reconcileLivingSources(null, inputs, ["consent"], [], T1);
  expect(inventory.records).toHaveLength(401);
  const result = collectDomainRows({
    domain: "one_living_sources",
    domainData: { _private: { inventory } },
    audience: "self",
  });
  expect(result.truncated).toBe(false);
  expect(result.rows.some((row) => row.value.includes("x".repeat(500)))).toBe(
    true,
  );
});
describe("owning source receipts", () => {
  it("records create edit delete and recreate without repeating deletion", () => {
    const a = sourceReceipts({}, {}, { home: { address: "Old" } }, T1);
    const b = sourceReceipts(
      a,
      { home: { address: "Old" } },
      { home: { address: "New" } },
      T2,
    );
    const c = sourceReceipts(b, { home: { address: "New" } }, {}, T3);
    expect(c.home).toEqual({
      id: "home",
      revision: 3,
      createdAt: T1,
      updatedAt: T3,
      deletedAt: T3,
    });
    expect(sourceReceipts(c, {}, {}, T3)).toEqual(c);
    expect(
      sourceReceipts(c, {}, { home: { address: "Recreated" } }, T3).home,
    ).toMatchObject({ revision: 4, createdAt: T1, deletedAt: null });
  });
  it("backfills legacy unchanged records and preserves known original creation", () => {
    const legacy = { home: { savedAt: T1, address: "Old" } };
    expect(sourceReceipts({}, legacy, legacy, T2).home).toMatchObject({
      createdAt: T1,
      revision: 1,
    });
    expect(sourceReceipts({}, legacy, {}, T2).home).toMatchObject({
      createdAt: T1,
      deletedAt: T2,
    });
    expect(
      sourceReceipts({}, { unknown: {} }, {}, T2).unknown.createdAt,
    ).toBeNull();
  });
  it("treats Object prototype names as real deleted source identifiers", () => {
    const before = Object.fromEntries([["toString", { createdAt: T1 }]]);
    expect(sourceReceipts({}, before, {}, T2).toString).toMatchObject({
      id: "toString",
      deletedAt: T2,
    });
  });
});
