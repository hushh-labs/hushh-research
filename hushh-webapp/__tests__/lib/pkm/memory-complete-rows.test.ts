import { describe, expect, it } from "vitest";
import { collectDomainRows } from "@/lib/pkm/memory-complete-rows";
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
