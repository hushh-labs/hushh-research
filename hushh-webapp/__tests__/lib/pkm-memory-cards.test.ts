import { describe, expect, it } from "vitest";

import {
  buildPkmMemorySnapshot,
  deletePkmDomainValue,
  pkmMemoryRowLabels,
  selectRelevantPkmMemoryCards,
  shouldSkipPkmMemoryKey,
  updatePkmDomainValue,
} from "@/lib/pkm/pkm-memory-cards";
import type { PersonalKnowledgeModelMetadata } from "@/lib/services/personal-knowledge-model-service";

const metadata: PersonalKnowledgeModelMetadata = {
  userId: "user-1",
  domains: [
    {
      key: "professional",
      displayName: "Professional",
      icon: "briefcase",
      color: "#38bdf8",
      attributeCount: 3,
      summary: {},
      availableScopes: ["attr.professional.*"],
      lastUpdated: "2026-05-20T12:00:00Z",
      readableSummary: null,
      readableHighlights: [],
      readableUpdatedAt: null,
      readableSourceLabel: "Saved memory",
      domainContractVersion: 1,
      readableSummaryVersion: 1,
      upgradedAt: null,
    },
  ],
  totalAttributes: 3,
  modelCompleteness: 20,
  modelVersion: 4,
  storedModelVersion: 4,
  effectiveModelVersion: 4,
  targetModelVersion: 4,
  upgradeStatus: "current",
  upgradableDomains: [],
  lastUpgradedAt: null,
  suggestedDomains: [],
  lastUpdated: "2026-05-20T12:00:00Z",
};

describe("PKM memory cards", () => {
  it("derives readable memory cards from decrypted PKM", () => {
    const snapshot = buildPkmMemorySnapshot({
      metadata,
      fullBlob: {
        professional: {
          profile: {
            name: "Akshat Kumar",
            roll_no: "22b4513",
            university: "IIT Bombay",
          },
        },
      },
    });

    expect(snapshot.cards.map((card) => card.title)).toEqual(
      expect.arrayContaining([
        "Your name is Akshat Kumar",
        "Roll number: 22b4513",
        "You study at IIT Bombay",
      ])
    );
    expect(snapshot.domainInsights[0]?.summary).toContain("education");
  });

  it("selects prompt-relevant cards for Agent context", () => {
    const snapshot = buildPkmMemorySnapshot({
      metadata,
      fullBlob: {
        professional: {
          profile: {
            name: "Akshat Kumar",
            university: "IIT Bombay",
          },
        },
      },
    });

    const relevant = selectRelevantPkmMemoryCards(snapshot.cards, "where do I study", 2);

    expect(relevant[0]?.title).toBe("You study at IIT Bombay");
  });

  it("updates and deletes card values by path without mutating the source object", () => {
    const domainData = {
      profile: {
        name: "Akshat Kumar",
        roll_no: "22b4513",
      },
    };

    const updated = updatePkmDomainValue({
      domainData,
      pathSegments: ["profile", "name"],
      previousValue: "Akshat Kumar",
      nextValue: "Akshat K.",
    });
    const deleted = deletePkmDomainValue({
      domainData,
      pathSegments: ["profile", "roll_no"],
    });

    expect((updated.profile as Record<string, unknown>).name).toBe("Akshat K.");
    expect((domainData.profile as Record<string, unknown>).name).toBe("Akshat Kumar");
    expect((deleted.profile as Record<string, unknown>).roll_no).toBeUndefined();
  });

  it("refuses stale or missing exact-path mutations", () => {
    const snapshot = buildPkmMemorySnapshot({
      metadata,
      fullBlob: { professional: { profile: { name: "Akshat Kumar" } } },
    });
    const card = snapshot.cards.find((entry) => entry.path === "profile.name");
    expect(card).toBeDefined();

    expect(() =>
      updatePkmDomainValue({
        domainData: { profile: { name: "Changed elsewhere" } },
        pathSegments: card!.pathSegments,
        previousValue: card!.value,
        nextValue: "Akshat K.",
        expectedValueFingerprint: card!.valueFingerprint,
      })
    ).toThrow(/changed before the correction/i);
    expect(() =>
      deletePkmDomainValue({
        domainData: { profile: {} },
        pathSegments: card!.pathSegments,
        expectedValueFingerprint: card!.valueFingerprint,
      })
    ).toThrow(/changed before it could be removed/i);
  });

  it("keeps secret-shaped values out of in-memory consumer cards", () => {
    const snapshot = buildPkmMemorySnapshot({
      metadata,
      fullBlob: {
        professional: {
          profile: { name: "Visible" },
          runtime_secrets: { vault_passphrase: "must-not-render" },
          api_key: "must-not-render",
        },
      },
    });

    expect(JSON.stringify(snapshot)).toContain("Visible");
    expect(JSON.stringify(snapshot)).not.toContain("must-not-render");
  });

  it("keeps entity-map identifiers internal while retaining exact mutation paths", () => {
    const snapshot = buildPkmMemorySnapshot({
      metadata,
      fullBlob: {
        professional: {
          changes: {
            entities: {
              sf_residence_001: { summary: "I live in New York City now." },
            },
          },
        },
      },
    });
    const card = snapshot.cards[0];

    expect(card.pathSegments).toContain("sf_residence_001");
    expect(card.detail).not.toMatch(/sf residence|sf_residence_001/i);
    expect(card.detail).toContain("Changes");
  });

  it("browses and searches array items past index 11 (no per-array truncation)", () => {
    const holdings = Array.from({ length: 15 }, (_, index) => `HOLD${index + 1}`);
    const snapshot = buildPkmMemorySnapshot({
      metadata,
      fullBlob: { professional: { portfolio: { holdings } } },
    });

    const item15 = snapshot.cards.find((entry) => entry.path === "portfolio.holdings[14]");
    expect(item15?.value).toBe("HOLD15");

    const found = selectRelevantPkmMemoryCards(snapshot.cards, "HOLD15", 5);
    expect(found.map((entry) => entry.value)).toContain("HOLD15");
  });

  describe("shouldSkipPkmMemoryKey", () => {
    it("hides raw underscore-prefixed keys that normalization would otherwise unmask", () => {
      expect(shouldSkipPkmMemoryKey("_internal")).toBe(true);
      expect(shouldSkipPkmMemoryKey("_private_metadata")).toBe(true);
      expect(shouldSkipPkmMemoryKey("  _hidden")).toBe(true);
    });

    it("still renders ordinary user keys", () => {
      expect(shouldSkipPkmMemoryKey("risk_profile")).toBe(false);
      expect(shouldSkipPkmMemoryKey("target_corpus")).toBe(false);
      expect(shouldSkipPkmMemoryKey("student_id")).toBe(false);
      expect(shouldSkipPkmMemoryKey("primary_bank")).toBe(false);
    });

    it("keeps existing reserved / secret / id filtering", () => {
      expect(shouldSkipPkmMemoryKey("runtime_secrets")).toBe(true);
      expect(shouldSkipPkmMemoryKey("kyc_workflow")).toBe(true);
      expect(shouldSkipPkmMemoryKey("manifest_version")).toBe(true);
      expect(shouldSkipPkmMemoryKey("vault_passphrase")).toBe(true);
      expect(shouldSkipPkmMemoryKey("access_token")).toBe(true);
      expect(shouldSkipPkmMemoryKey("artifact_id")).toBe(true);
    });

    it("keeps the wallet domain memory-visible while pruning its secrets subtree", () => {
      // Card summaries (nickname, network, last4) are Memory items like any
      // other domain; PAN, CVV, and PIN live under `secrets`, which
      // SECRET_KEY_PATTERN prunes before anything reaches a card or a model.
      expect(shouldSkipPkmMemoryKey("wallet")).toBe(false);
      expect(shouldSkipPkmMemoryKey("secrets")).toBe(true);
      const snapshot = buildPkmMemorySnapshot({
        metadata: null,
        fullBlob: {
          wallet: {
            summary: { card_1: { nickname: "Everyday Visa", brand: "visa", last4: "1111" } },
            secrets: { card_1: { pan: "4111111111111111", cvv: "123", pin: "1234" } },
          },
        },
      });
      const rendered = JSON.stringify(snapshot);
      expect(rendered).toContain("Everyday Visa");
      expect(rendered).not.toContain("4111111111111111");
      expect(rendered).not.toContain("1234");
    });
  });

  describe("pkmMemoryRowLabels", () => {
    it("uses the leaf path segment as the row name and the value sentence as the subtitle", () => {
      const snapshot = buildPkmMemorySnapshot({
        metadata,
        fullBlob: {
          professional: { preferences: { morning_flights: "morning flights" } },
        },
      });
      const card = snapshot.cards.find((entry) => entry.path.endsWith("morning_flights"));
      expect(card).toBeDefined();

      const labels = pkmMemoryRowLabels(card!);
      expect(labels.primary).toBe("Morning Flights");
      expect(labels.secondary).toBe("morning flights");
    });

    it("falls back to the raw value when the name would echo the sentence", () => {
      const labels = pkmMemoryRowLabels({
        id: "financial:x",
        domain: "financial",
        domainTitle: "Financial",
        title: "Risk Profile",
        detail: "Stored in Financial.",
        value: "balanced",
        valueFingerprint: "fp",
        path: "profile.risk_profile",
        pathSegments: ["profile", "risk_profile"],
        sourceLabel: "Saved memory",
        updatedAt: null,
        confidence: 0.9,
        kind: "financial",
        editable: true,
        searchText: "financial risk profile balanced",
      });
      expect(labels.primary).toBe("Risk Profile");
      expect(labels.secondary).toBe("balanced");
    });
  });
});

describe("global card budget fairness", () => {
  it("keeps every domain represented instead of spending the budget on the first ones", () => {
    // Before round-robin, cards were flattened in domain order and sliced, so a
    // domain late in the iteration order (wallet, alphabetically last) could
    // contribute nothing and vanish from Memory entirely.
    const fullBlob: Record<string, unknown> = {};
    for (const domain of ["aaa", "bbb", "ccc", "wallet"]) {
      const fields: Record<string, string> = {};
      for (let i = 0; i < 30; i += 1) fields[`field_${i}`] = `${domain} value ${i}`;
      fullBlob[domain] = fields;
    }
    const snapshot = buildPkmMemorySnapshot({
      metadata: null,
      fullBlob,
      maxCards: 8,
    } as never);
    const domains = new Set(snapshot.cards.map((card) => card.domain));
    expect(snapshot.cards.length).toBeLessThanOrEqual(8);
    expect(domains.has("wallet")).toBe(true);
    expect(domains.size).toBe(4);
  });
});
