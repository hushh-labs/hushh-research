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
});
