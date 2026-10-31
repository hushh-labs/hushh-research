import { expect, it } from "vitest";
import { buildOwnerLivingFactIndex } from "@/lib/pkm/living-source-fact-index";
import { reconcileLivingSources, type LivingSourceInput } from "@/lib/pkm/living-source-records";

const T1 = "2026-10-15T00:00:00.000Z";
const T2 = "2026-10-15T00:01:00.000Z";
const T3 = "2026-10-15T00:02:00.000Z";
const profile = (name: string): LivingSourceInput => ({
  kind: "profile", id: "owner", createdAt: T1, updatedAt: T2,
  value: {
    name, photo: "https://example.test/photo", email: "owner@example.test",
    sex: "female", declared_age: 35, date_of_birth: "1991-01-01",
    coordinates: "1,2", oauthToken: "must-stay-out",
  },
});

it("indexes the corrected owner name with source revision and never invents sensitive facts", () => {
  const first = reconcileLivingSources(null, [profile("Ankit Kumar Singh")], ["profile"], [], T1);
  const corrected = reconcileLivingSources(first, [profile("Ankit")], ["profile"], [], T2);
  const index = buildOwnerLivingFactIndex({ expectedOwnerId: "owner", inventory: corrected, now: T3 });
  expect(index.complete).toBe(true);
  expect(index.byPredicate.get("profile.name")).toEqual([
    expect.objectContaining({ value: "Ankit", status: "verified", provenance: expect.objectContaining({
      kind: "profile", sourceId: "owner", revision: 2, capturedAt: T2, verifiedAt: T2,
    }) }),
  ]);
  expect(index.nodes.some(node => node.value === "Ankit Kumar Singh")).toBe(false);
  expect(index.nodes.some(node => /sex|age|birth|coordinate|token/i.test(node.predicate))).toBe(false);
  expect(index.nodes.some(node => node.value === "must-stay-out")).toBe(false);
});

it("retains a failed source as stale, then lets a verified tombstone supersede its old facts", () => {
  const connector: LivingSourceInput = {
    kind: "curated_oauth_connector", id: "google_drive", createdAt: T1, updatedAt: T1,
    value: { provider: "google_drive", status: "connected", connectedAt: T1, token: "never-index" },
  };
  const first = reconcileLivingSources(null, [profile("Ankit"), connector],
    ["profile", "curated_oauth_connector"], [], T1);
  const failed = reconcileLivingSources(first, [profile("Ankit")], ["profile"],
    ["curated_oauth_connector"], T2);
  const stale = buildOwnerLivingFactIndex({ expectedOwnerId: "owner", inventory: failed, now: T3 });
  expect(stale.complete).toBe(false);
  expect(stale.byPredicate.get("curated_oauth_connector.status")).toEqual([
    expect.objectContaining({ value: "connected", status: "stale" }),
  ]);
  expect(stale.byPredicate.get("profile.name")?.[0]?.status).toBe("verified");
  expect(stale.nodes.some(node => node.value === "never-index")).toBe(false);

  const deleted = reconcileLivingSources(failed, [profile("Ankit")],
    ["profile", "curated_oauth_connector"], [], T3);
  const index = buildOwnerLivingFactIndex({ expectedOwnerId: "owner", inventory: deleted, now: T3 });
  expect(index.byPredicate.get("curated_oauth_connector.status")).toBeUndefined();
  expect(index.byPredicate.get("curated_oauth_connector.__record")?.[0]).toMatchObject({
    status: "deleted", value: null, provenance: { sourceId: "google_drive", revision: 2 },
  });
});

it("fails closed on contradictory equal revisions or a foreign profile", () => {
  const inventory = reconcileLivingSources(null, [profile("Ankit")], ["profile"], [], T1);
  const contradictory = {
    ...inventory,
    records: [...inventory.records, { ...inventory.records[0]!, value: { name: "Another name" } }],
  };
  const conflict = buildOwnerLivingFactIndex({ expectedOwnerId: "owner", inventory: contradictory, now: T2 });
  expect(conflict.complete).toBe(false);
  expect(conflict.issues).toContain("conflict");
  expect(conflict.byPredicate.get("profile.name")).toBeUndefined();
  expect(conflict.byPredicate.get("profile.__record")?.[0]?.status).toBe("conflicted");

  const foreign = { ...inventory, records: [{ ...inventory.records[0]!, id: "other-owner" }] };
  const rejected = buildOwnerLivingFactIndex({ expectedOwnerId: "owner", inventory: foreign, now: T2 });
  expect(rejected.complete).toBe(false);
  expect(rejected.issues).toContain("owner_mismatch");
  expect(rejected.nodes).toEqual([]);
});
