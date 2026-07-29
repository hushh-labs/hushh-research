import { describe, expect, it } from "vitest";

import {
  buildPkmMemorySnapshot,
  deletePkmDomainValue,
  selectRelevantPkmMemoryCards,
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

  it("returns empty array without crash when limit is zero (minimum boundary guard)", () => {
    // selectRelevantPkmMemoryCards calls cards.slice(0, limit) directly.
    // Passing limit=0 must yield [] and never throw — slice(0, 0) is the
    // zero-page-size boundary and the function must handle it gracefully.
    const snapshot = buildPkmMemorySnapshot({
      metadata,
      fullBlob: {
        professional: {
          profile: {
            name: "test_user_alpha",
            university: "test_org_beta",
          },
        },
      },
    });

    // Snapshot must have at least one card so we know cards were available.
    expect(snapshot.cards.length).toBeGreaterThanOrEqual(1);

    // Empty query bypasses scoring and goes straight to cards.slice(0, limit).
    const result = selectRelevantPkmMemoryCards(snapshot.cards, "", 0);

    expect(result).toHaveLength(0);
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns only available cards without crash when limit far exceeds dataset size (upper boundary guard)", () => {
    // Passing limit=9999 to a 2-card snapshot must return at most the 2 real
    // cards — slice(0, 9999) on a 2-element array yields the 2 elements, not
    // 9999 phantom entries. No index error, no undefined slots.
    const snapshot = buildPkmMemorySnapshot({
      metadata,
      fullBlob: {
        professional: {
          profile: {
            name: "test_user_alpha",
            university: "test_org_beta",
          },
        },
      },
    });

    const datasetSize = snapshot.cards.length;
    expect(datasetSize).toBeGreaterThanOrEqual(1);

    const result = selectRelevantPkmMemoryCards(snapshot.cards, "", 9999);

    // Must be bounded by the actual dataset — no phantom items beyond what exists.
    expect(result.length).toBeLessThanOrEqual(datasetSize);
    // Must return the full dataset when the limit exceeds it.
    expect(result.length).toBe(datasetSize);
    // Every returned entry must be a real card with a non-empty id.
    result.forEach((card) => expect(card.id).toBeTruthy());
  });
});
