import { describe, expect, it } from "vitest";
import {
  appendJournalGapMarkers,
  appendVerifiedLivingSourceChanges,
  MAX_RETAINED_LIVING_SOURCE_CHANGES,
  reconcileLivingSources,
  type LivingJournalPending,
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

it("keeps verified corrections and deletion in an encrypted-domain history without duplicate replay", () => {
  const first = reconcileLivingSources(null, [profile("Ankit Kumar Singh")], ["profile"], [], T1);
  const changed = reconcileLivingSources(first, [profile("Ankit")], ["profile"], [], T2);
  const removed = reconcileLivingSources(changed, [], ["profile"], [], T3);
  const a = appendVerifiedLivingSourceChanges(null, null, first);
  const b = appendVerifiedLivingSourceChanges(a, first, changed);
  const c = appendVerifiedLivingSourceChanges(b, changed, removed);
  expect(c.changes.map(({ sequence, revision, operation, value }) => ({ sequence, revision, operation, value })))
    .toEqual([
      { sequence: 1, revision: 1, operation: "upsert", value: profile("Ankit Kumar Singh").value },
      { sequence: 2, revision: 2, operation: "upsert", value: profile("Ankit").value },
      { sequence: 3, revision: 3, operation: "delete", value: {} },
    ]);
  expect(appendVerifiedLivingSourceChanges(c, removed, removed)).toEqual(c);
});

it("declares a retention gap when the bounded owner history rolls over", () => {
  const inputs = Array.from({ length: MAX_RETAINED_LIVING_SOURCE_CHANGES + 1 }, (_, i): LivingSourceInput => ({
    ...consent, id: `grant-${i}`,
  }));
  const inventory = reconcileLivingSources(null, inputs, ["consent"], [], T1);
  const history = appendVerifiedLivingSourceChanges(null, null, inventory);
  expect(history.changes).toHaveLength(MAX_RETAINED_LIVING_SOURCE_CHANGES);
  expect(history.firstRetainedSequence).toBe(2);
  expect(history.nextSequence).toBe(MAX_RETAINED_LIVING_SOURCE_CHANGES + 2);
  expect(history.truncatedAt).toBe(T1);
});

const pendingConsent = (count: number | null, historySequence: number): LivingJournalPending => ({
  version: 1,
  kinds: { consent: { count, firstOccurredAt: T1, lastOccurredAt: T2, historySequence } },
});
const revoked = (input: LivingSourceInput): LivingSourceInput => ({
  ...input, value: { ...input.value, status: "revoked", active: false },
});

it("marks committed changes this history did not capture, never the values in between", () => {
  const before = reconcileLivingSources(null, [consent], ["consent"], [], T1);
  const history = appendVerifiedLivingSourceChanges(null, null, before);
  const pendingFrom = history.nextSequence;
  const after = reconcileLivingSources(before, [revoked(consent)], ["consent"], [], T3);
  const withLatest = appendVerifiedLivingSourceChanges(history, before, after);

  const marked = appendJournalGapMarkers(withLatest, pendingConsent(3, pendingFrom), ["consent"], T3);
  expect(marked.changes.map((change) => change.operation)).toEqual(["upsert", "upsert", "gap"]);
  const marker = marked.changes.at(-1)!;
  expect(marker).toEqual({
    sequence: 3, kind: "consent", id: "*", revision: 0, operation: "gap",
    capturedAt: T3, sourceUpdatedAt: null,
    value: {
      reason: "unobserved_changes", committedChanges: 3, verifiedChanges: 1,
      firstOccurredAt: T1, lastOccurredAt: T2,
    },
  });
  expect(Object.keys(marker.value).sort()).toEqual([
    "committedChanges", "firstOccurredAt", "lastOccurredAt", "reason", "verifiedChanges",
  ]);
  // Every committed change was recorded, or the source was not verified: no marker.
  expect(appendJournalGapMarkers(withLatest, pendingConsent(1, pendingFrom), ["consent"], T3))
    .toEqual(withLatest);
  expect(appendJournalGapMarkers(withLatest, pendingConsent(3, pendingFrom), ["profile"], T3))
    .toEqual(withLatest);
  // A journal reset leaves the committed count unknown.
  expect(appendJournalGapMarkers(withLatest, pendingConsent(null, pendingFrom), ["consent"], T3)
    .changes.at(-1)?.value).toMatchObject({ reason: "journal_gap", committedChanges: null });
  // Retention already removed part of the span, so the recorded count is unknown.
  const trimmed = { ...withLatest, changes: withLatest.changes.slice(1), firstRetainedSequence: 2 };
  expect(appendJournalGapMarkers(trimmed, pendingConsent(3, 1), ["consent"], T3)
    .changes.at(-1)?.value).toMatchObject({ committedChanges: 3, verifiedChanges: null });
});

it("writes no gap for a hint that changed no mirrored record", () => {
  // Journal triggers also fire for rows the mirror does not hold (a sent
  // connection request, a consent audit row). The verified re-read then finds
  // every record unchanged, and the history must not claim missed changes.
  const before = reconcileLivingSources(null, [consent], ["consent"], [], T1);
  const history = appendVerifiedLivingSourceChanges(null, null, before);
  const after = reconcileLivingSources(before, [consent], ["consent"], [], T3);
  const unchanged = appendVerifiedLivingSourceChanges(history, before, after);
  expect(unchanged).toEqual(history);
  for (const count of [1, null])
    expect(appendJournalGapMarkers(unchanged, pendingConsent(count, unchanged.nextSequence), ["consent"], T3))
      .toEqual(unchanged);
});

it("keeps gap markers inside the shared retention cap and renders them as counted, not truncated", () => {
  const grants = Array.from({ length: MAX_RETAINED_LIVING_SOURCE_CHANGES }, (_, i): LivingSourceInput => ({
    ...consent, id: `grant-${i}`,
  }));
  const full = reconcileLivingSources(null, grants, ["consent"], [], T1);
  const history = appendVerifiedLivingSourceChanges(null, null, full);
  expect(history.changes).toHaveLength(MAX_RETAINED_LIVING_SOURCE_CHANGES);
  expect(history.truncatedAt).toBeNull();
  const changed = reconcileLivingSources(full, [revoked(grants[0]!), ...grants.slice(1)], ["consent"], [], T2);
  const next = appendJournalGapMarkers(
    appendVerifiedLivingSourceChanges(history, full, changed),
    pendingConsent(3, history.nextSequence), ["consent"], T2,
  );
  expect(next.changes).toHaveLength(MAX_RETAINED_LIVING_SOURCE_CHANGES);
  expect(next.firstRetainedSequence).toBe(3);
  expect(next.truncatedAt).toBe(T2);

  const render = (observed: typeof next) => collectDomainRows({
    domain: "one_living_sources", audience: "self",
    domainData: { _private: { inventory: changed, observed_history: observed } },
  });
  const rendered = render(next);
  const gapRow = rendered.rows.find((row) => row.label.includes("consent:* · gap"));
  expect(gapRow?.value).toBe("3 changes committed; 1 recorded. Values in between were not seen.");
  expect(rendered.truncated).toBe(false);
  // An unknown recorded count says so, never that values went unseen.
  const unknown = render({ ...next, changes: next.changes.map((change) => change.operation === "gap"
    ? { ...change, value: { ...change.value, verifiedChanges: null } } : change) });
  expect(unknown.rows.find((row) => row.label.includes("consent:* · gap"))?.value)
    .toBe("3 changes committed; recorded count unknown.");
  expect(unknown.truncated).toBe(false);
  // Negative control: a malformed marker cannot vouch for the span it covers.
  const malformed = { ...next, changes: next.changes.map((change) => change.operation === "gap"
    ? { ...change, value: { ...change.value, committedChanges: "3" } } : change) };
  expect(render(malformed).truncated).toBe(true);
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

it("preserves __proto__ source receipts through JSON restart and deletion", () => {
  const records = Object.fromEntries([
    ["__proto__", { createdAt: T1, note: "Full record" }],
  ]);
  const created = sourceReceipts({}, {}, records, T1);
  expect(Object.hasOwn(created, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(created)).toBe(Object.prototype);
  const restarted = JSON.parse(JSON.stringify(created));
  const deleted = sourceReceipts(restarted, records, {}, T2);
  expect(Object.hasOwn(deleted, "__proto__")).toBe(true);
  expect(deleted["__proto__"]).toMatchObject({
    id: "__proto__",
    revision: 2,
    createdAt: T1,
    deletedAt: T2,
  });
});

it("retains provenance backfill for an unchanged source", () => {
  const input = {
    kind: "profile" as const,
    id: "owner",
    value: { name: "Owner" },
    createdAt: null,
    updatedAt: null,
  };
  const first = reconcileLivingSources(null, [input], ["profile"], [], T1);
  const next = reconcileLivingSources(
    first,
    [{ ...input, createdAt: T1, updatedAt: T2 }],
    ["profile"],
    [],
    T2,
  );
  expect(next.records[0]).toMatchObject({
    createdAt: T1,
    updatedAt: T2,
    revision: 1,
  });
});
