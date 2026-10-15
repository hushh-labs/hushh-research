import { describe, expect, it } from "vitest";
import { collectDomainRows, MAX_LIVING_SOURCE_MEMORY_ROWS } from "@/lib/pkm/memory-complete-rows";
import { buildMemoryDocument } from "@/lib/pkm/memory-document";
import type { PkmMemorySnapshot } from "@/lib/pkm/pkm-memory-cards";

const emptySnapshot: PkmMemorySnapshot = { cards: [], domainInsights: [], totalCards: 0 };

describe("a memory record is complete, not a display summary", () => {
  it("keeps every value in a domain, past the browsing card caps", () => {
    // buildPkmMemorySnapshot caps at 24 cards per domain and 96 overall, and
    // reports totalCards as what it KEPT, so truncation there is invisible.
    const domainData = {
      travel: Object.fromEntries(
        Array.from({ length: 150 }, (_, index) => [`trip_${index}`, `City ${index}`]),
      ),
    };
    const section = collectDomainRows({
      domain: "travel",
      domainData: domainData.travel,
      audience: "self",
    });
    expect(section.rows).toHaveLength(150);
    expect(section.truncated).toBe(false);
  });

  it("keeps a long value in full rather than clipping it at 180 characters", () => {
    const long = "x".repeat(500);
    const section = collectDomainRows({
      domain: "notes",
      domainData: { note: long },
      audience: "self",
    });
    expect(section.rows[0]!.value).toBe(long);
    expect(section.rows[0]!.value).not.toContain("...");
  });

  it("walks nested objects and arrays to their leaves", () => {
    const section = collectDomainRows({
      domain: "travel",
      domainData: { trips: [{ city: "Tokyo", legs: [{ mode: "rail" }] }] },
      audience: "self",
    });
    const paths = section.rows.map((row) => row.path);
    expect(paths).toContain("trips.0.city");
    expect(paths).toContain("trips.0.legs.0.mode");
  });

  it("reports a document as incomplete when a section truncated", () => {
    // A blob deep enough to hit the depth bound.
    let deep: Record<string, unknown> = { value: "bottom" };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };

    const result = buildMemoryDocument({
      snapshot: emptySnapshot,
      sources: [{ domain: "deep", contentRevision: 1 }],
      audience: "self",
      builtAt: "2026-10-10T12:00:00.000Z",
      domainData: { deep },
    });

    expect(result.complete).toBe(false);
    expect(result.markdown).toContain("Truncated.");
    expect(result.freshness.find((f) => f.domain === "deep")?.truncated).toBe(true);
  });

  it("a fully-walked document stays complete", () => {
    const result = buildMemoryDocument({
      snapshot: emptySnapshot,
      sources: [{ domain: "personal_data", contentRevision: 3 }],
      audience: "self",
      builtAt: "2026-10-10T12:00:00.000Z",
      domainData: { personal_data: { home: { city: "Bengaluru" } } },
    });
    expect(result.complete).toBe(true);
    expect(result.markdown).toContain("Bengaluru");
    expect(result.markdown).not.toContain("Truncated.");
  });
});

describe("exclusion still applies to the complete walk", () => {
  it("keeps private Wallet artwork out of owner and agent documents while retaining owner summaries", () => {
    const wallet = { summary: { card_1: { nickname: "Everyday card" } },
      artwork: { card_1: { image: "private-raster-marker" } } };
    for (const audience of ["self", "agent"] as const) {
      const rows = collectDomainRows({ domain: "wallet", domainData: wallet, audience });
      const document = buildMemoryDocument({ snapshot: emptySnapshot, audience,
        sources: [{ domain: "wallet", contentRevision: 1 }], domainData: { wallet },
        builtAt: "2026-10-15T00:00:00.000Z" });
      expect(JSON.stringify(rows)).not.toContain("private-raster-marker");
      expect(document.markdown).not.toContain("private-raster-marker");
      if (audience === "self") expect(document.markdown).toContain("Everyday card");
    }
  });

  it("bounds source rows deterministically and reports an incomplete record at the cap", () => {
    const now = "2026-10-15T00:00:00.000Z";
    const records = Array.from({ length: 2_224 }, (_, index) => ({
      kind: "connection", id: `peer-${String(index).padStart(4, "0")}`,
      revision: 1, createdAt: now, updatedAt: now, capturedAt: now,
      deletedAt: null, value: { counterpartId: `peer-${index}` },
    }));
    const inventory = { complete: true, unavailable: [], observedAt: now,
      verifiedAt: { connection: now }, records };
    const collect = (sourceRecords: typeof records) => collectDomainRows({
      domain: "one_living_sources", audience: "self", ownerUserId: "owner", now,
      domainData: { _private: { inventory: { ...inventory, records: sourceRecords } } },
    });
    const first = collect(records);
    const reordered = collect([...records].reverse());
    expect(first.rows).toHaveLength(MAX_LIVING_SOURCE_MEMORY_ROWS);
    expect(first.truncated).toBe(true);
    expect(reordered.truncated).toBe(true);
    expect(reordered.rows).toEqual(first.rows);
    expect(inventory.records).toHaveLength(2_224);
  });

  it("shows only the owner a bounded retained change log and its retention boundary", () => {
    const now = "2026-10-15T00:00:00.000Z";
    const domainData = { _private: {
      inventory: { complete: true, unavailable: [], observedAt: now, records: [] },
      observed_history: { firstRetainedSequence: 5, nextSequence: 7,
        truncatedAt: "2026-10-14T00:00:00.000Z", changes: [
          { sequence: 6, kind: "profile", id: "owner", revision: 2,
            operation: "upsert", capturedAt: now, sourceUpdatedAt: now,
            value: { name: "Ankit" } },
          { sequence: 5, kind: "profile", id: "owner", revision: 1,
            operation: "upsert", capturedAt: now, sourceUpdatedAt: now,
            value: { name: "Ankit Kumar Singh" } },
        ] },
    } };
    const owner = collectDomainRows({ domain: "one_living_sources", domainData,
      audience: "self", ownerUserId: "owner", now });
    const agent = collectDomainRows({ domain: "one_living_sources", domainData,
      audience: "agent" });
    expect(owner.rows.map(row => row.value)).toContain('{"name":"Ankit"}');
    expect(owner.rows.some(row => row.label.includes("First retained sequence"))).toBe(false);
    expect(owner.rows.some(row => row.value.includes("First retained sequence 5"))).toBe(true);
    expect(owner.rows.some(row => row.label.includes("Recent observed change #6"))).toBe(true);
    expect(agent.rows).toHaveLength(0);
    expect(JSON.stringify(agent)).not.toContain("Ankit");
  });

  it("keeps indexed source facts in the owner's document and out of agent exports", () => {
    const now = "2026-10-15T00:00:00.000Z";
    const domainData = { one_living_sources: { _private: { inventory: {
      complete: true, unavailable: [], observedAt: now,
      records: [{ kind: "profile", id: "owner", revision: 1, createdAt: now,
        updatedAt: now, capturedAt: now, deletedAt: null, value: { name: "Ankit" } }],
    } } } };
    const build = (audience: "self" | "agent") => buildMemoryDocument({
      snapshot: emptySnapshot, domainData, ownerUserId: "owner", audience,
      sources: [{ domain: "one_living_sources", contentRevision: 1 }], builtAt: now,
    });
    expect(build("self").markdown).toContain("profile.name · verified");
    expect(build("agent").markdown).not.toContain("Ankit");
    expect(build("agent").markdown).not.toContain("profile.name · verified");
  });

  it("withholds a reserved label_only branch from an agent record and names it", () => {
    const section = collectDomainRows({
      domain: "wallet",
      domainData: { summary: { card_1: { last4: "4242", nickname: "Visa" } } },
      audience: "agent",
    });
    expect(section.rows).toHaveLength(0);
    expect(section.withheld).toContain("wallet");
    expect(JSON.stringify(section)).not.toContain("4242");
  });

  it("keeps the same branch for the owner's own record", () => {
    // Negative control: the exclusion is audience-specific, not a blanket ban.
    const section = collectDomainRows({
      domain: "wallet",
      domainData: { summary: { card_1: { last4: "4242" } } },
      audience: "self",
    });
    expect(section.rows.some((row) => row.value === "4242")).toBe(true);
  });

  it("drops internal plumbing keys at any depth", () => {
    const section = collectDomainRows({
      domain: "travel",
      domainData: { trips: [{ city: "Tokyo", ciphertext: "AAAA", iv: "BBBB" }] },
      audience: "self",
    });
    const values = section.rows.map((row) => row.value);
    expect(values).toContain("Tokyo");
    expect(values).not.toContain("AAAA");
    expect(values).not.toContain("BBBB");
  });
});
