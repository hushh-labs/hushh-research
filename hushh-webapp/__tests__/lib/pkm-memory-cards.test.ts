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
});
