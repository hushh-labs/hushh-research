import { describe, expect, it } from "vitest";

import {
  pkmMemoryCardBreadcrumb,
  resolvePkmMemoryLevel,
} from "@/lib/pkm/pkm-memory-level";
import { buildPkmMemoryCardsFromNode } from "@/lib/pkm/pkm-memory-cards";

/**
 * Synthetic nested fixture only — the arbitrary-depth PKM shape the Memory
 * browser must walk without reading anyone's encrypted vault.
 */
function financialData() {
  return {
    goals: {
      retirement: {
        target_corpus: "5 crore",
        target_age: 55,
        auth_token: "must-not-render",
        milestones: [
          { name: "First 1 crore", status: "done" },
          { title: "Second milestone", status: "pending" },
          { status: "future" },
        ],
      },
      house: { down_payment: "40 lakh" },
    },
    runtime_secrets: { api_key: "sk-must-not-render" },
    kyc_workflow: { step: "done" },
    manifest_version: 4,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const BASE = {
  domainKey: "financial",
  domainTitle: "Financial",
  sourceLabel: "Saved memory",
  updatedAt: null,
};

describe("resolvePkmMemoryLevel", () => {
  it("shows only the immediate children at the domain root and hides reserved/internal keys", () => {
    const level = resolvePkmMemoryLevel({ ...BASE, data: financialData(), pathStack: [] });

    expect(level.title).toBe("Financial");
    expect(level.parentLabel).toBe("Memory");
    expect(level.entries.map((entry) => entry.kind === "group" && entry.label)).toEqual([
      "Goals",
    ]);
    expect(level.entries[0]).toMatchObject({ kind: "group", segment: "goals" });
    // runtime_secrets / _private / kyc_workflow / updated_at never surface.
    expect(JSON.stringify(level)).not.toContain("must-not-render");
    expect(JSON.stringify(level)).not.toContain("Kyc");
  });

  it("descends one arbitrary level at a time and counts descendant memories", () => {
    const data = financialData();

    const goals = resolvePkmMemoryLevel({ ...BASE, data, pathStack: ["goals"] });
    expect(goals.title).toBe("Goals");
    expect(goals.crumbs).toEqual(["Financial", "Goals"]);
    // Retirement: target_corpus + target_age + 5 milestone fields (auth_token is hidden).
    expect(goals.entries.map((e) => (e.kind === "group" ? [e.label, e.childCount] : e))).toEqual([
      ["Retirement", 7],
      ["House", 1],
    ]);

    const retirement = resolvePkmMemoryLevel({
      ...BASE,
      data,
      pathStack: ["goals", "retirement"],
    });
    expect(retirement.crumbs).toEqual(["Financial", "Goals", "Retirement"]);
    // Two readable leaves, one nested array group — the secret leaf is gone.
    expect(retirement.entries.map((e) => e.kind)).toEqual(["leaf", "leaf", "group"]);
    const leafTitles = retirement.entries
      .filter((e): e is Extract<typeof e, { kind: "leaf" }>=> e.kind === "leaf")
      .map((e) => e.card.pathSegments.join("."));
    expect(leafTitles).toEqual([
      "goals.retirement.target_corpus",
      "goals.retirement.target_age",
    ]);
    expect(JSON.stringify(retirement)).not.toContain("must-not-render");
  });

  it("labels array items from name/title/label and never from a raw index", () => {
    const milestones = resolvePkmMemoryLevel({
      ...BASE,
      data: financialData(),
      pathStack: ["goals", "retirement", "milestones"],
    });

    expect(milestones.crumbs).toEqual(["Financial", "Goals", "Retirement", "Milestones"]);
    expect(milestones.entries.map((e) => e.kind === "group" && e.label)).toEqual([
      "First 1 crore",
      "Second milestone",
      "Milestone 3",
    ]);
    // Drilling into an array item still exposes its exact path for mutation.
    const nested = resolvePkmMemoryLevel({
      ...BASE,
      data: financialData(),
      pathStack: ["goals", "retirement", "milestones", 0],
    });
    const statusLeaf = nested.entries.find(
      (e): e is Extract<typeof e, { kind: "leaf" }>=>
        e.kind === "leaf" && e.card.pathSegments.join(".") === "goals.retirement.milestones.0.status",
    );
    expect(statusLeaf).toBeDefined();
  });

  it("preserves siblings — every non-hidden child of a level is listed", () => {
    const retirement = resolvePkmMemoryLevel({
      ...BASE,
      data: financialData(),
      pathStack: ["goals", "retirement"],
    });
    const keys = retirement.entries.map((e) =>
      e.kind === "leaf" ? e.card.pathSegments.at(-1) : e.segment,
    );
    expect(keys).toEqual(["target_corpus", "target_age", "milestones"]);
  });

  it("exposes every array item, including past index 11", () => {
    const holdings = Array.from({ length: 15 }, (_, index) => ({
      name: `Holding ${index + 1}`,
      units: index + 1,
    }));
    const data = { portfolio: { holdings } } as Record<string, unknown>;

    const level = resolvePkmMemoryLevel({
      ...BASE,
      data,
      pathStack: ["portfolio", "holdings"],
    });
    expect(level.entries).toHaveLength(15);
    expect(level.entries.map((e) => e.kind === "group" && e.label)).toContain("Holding 15");

    // ...and its leaves carry the exact index-15 path for edit / forget.
    const item15 = resolvePkmMemoryLevel({
      ...BASE,
      data,
      pathStack: ["portfolio", "holdings", 14],
    });
    const unitsLeaf = item15.entries.find(
      (e): e is Extract<typeof e, { kind: "leaf" }>=>
        e.kind === "leaf" && e.card.pathSegments.join(".") === "portfolio.holdings.14.units",
    );
    expect(unitsLeaf?.card.value).toBe("15");
  });

  it("flags a path that no longer resolves", () => {
    const level = resolvePkmMemoryLevel({
      ...BASE,
      data: financialData(),
      pathStack: ["goals", "gone"],
    });
    expect(level.notFound).toBe(true);
    expect(level.entries).toEqual([]);
  });

  it("keeps a drilled leaf card identical to its search-snapshot card", () => {
    const data = financialData();
    const level = resolvePkmMemoryLevel({
      ...BASE,
      data,
      pathStack: ["goals", "retirement"],
    });
    const drilled = level.entries.find(
      (e): e is Extract<typeof e, { kind: "leaf" }>=> e.kind === "leaf",
    )!.card;

    const [fromNode] = buildPkmMemoryCardsFromNode({
      domain: "financial",
      domainTitle: "Financial",
      value: data.goals.retirement.target_corpus,
      sourceLabel: "Saved memory",
      updatedAt: null,
      pathSegments: ["goals", "retirement", "target_corpus"],
    });
    expect(drilled.id).toBe(fromNode.id);
    expect(drilled.valueFingerprint).toBe(fromNode.valueFingerprint);
  });
});

describe("pkmMemoryCardBreadcrumb", () => {
  it("renders a human path and drops the leaf, indices and entity ids", () => {
    const [card] = buildPkmMemoryCardsFromNode({
      domain: "financial",
      domainTitle: "Financial",
      value: "5 crore",
      sourceLabel: "Saved memory",
      updatedAt: null,
      pathSegments: ["goals", "retirement", "target_corpus"],
    });
    expect(pkmMemoryCardBreadcrumb(card)).toBe("Financial › Goals › Retirement");

    const [entityCard] = buildPkmMemoryCardsFromNode({
      domain: "changes",
      domainTitle: "Changes",
      value: "I moved cities",
      sourceLabel: "Saved memory",
      updatedAt: null,
      pathSegments: ["history", "entities", "mem_abc123", "summary"],
    });
    expect(pkmMemoryCardBreadcrumb(entityCard)).toBe("Changes › History");
  });
});

describe("opaque segment titles", () => {
  const WALLET = {
    summary: {
      "card_94d850a3-a02c-414c-9813-a48e64b0fa53": {
        nickname: "Discover",
        brand: "discover",
        last4: "3654",
        expiry_month: 9,
        expiry_year: 2028,
        issuing_region: "US",
      },
    },
  };
  const WALLET_BASE = { domainKey: "wallet", domainTitle: "Wallet", sourceLabel: "Wallet" };

  it("lists a saved card by its nickname, not its uuid segment", () => {
    const level = resolvePkmMemoryLevel({
      ...WALLET_BASE,
      data: WALLET,
      pathStack: ["summary"],
    });
    expect(level.entries.map((entry) => entry.kind === "group" && entry.label)).toEqual([
      "Discover",
    ]);
    // The uuid stays as the navigation segment; it must never be the label.
    expect(level.entries[0]).toMatchObject({
      kind: "group",
      segment: "card_94d850a3-a02c-414c-9813-a48e64b0fa53",
    });
  });

  it("titles the card detail with the nickname", () => {
    // The regression: `card_<uuid>` fell through humanize() and the owner's
    // screen read "Card 94d850a3 A02c 414c 9813 A48e64b0fa53".
    const level = resolvePkmMemoryLevel({
      ...WALLET_BASE,
      data: WALLET,
      pathStack: ["summary", "card_94d850a3-a02c-414c-9813-a48e64b0fa53"],
    });
    expect(level.title).toBe("Discover");
    expect(level.crumbs).toEqual(["Wallet", "Summary", "Discover"]);
    expect(level.title).not.toContain("94d850a3");
  });
});
