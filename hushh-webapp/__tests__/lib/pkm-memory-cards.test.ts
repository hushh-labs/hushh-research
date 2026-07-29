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

  it("strips regex metacharacters from the search query and evaluates tokens as literals (regex escape guard)", () => {
    // tokens() splits the query on the static pre-compiled regex
    // /[^a-z0-9$.\-]+/g — metacharacters such as *, ?, + become
    // split delimiters and are never forwarded to new RegExp().
    // Constructing `new RegExp("test*user?alpha+")` would throw a
    // SyntaxError (quantifiers with nothing to quantify).  The static
    // split path must NOT throw and must produce the same token set —
    // and therefore the same scoring results — as the plain equivalent.
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

    expect(() =>
      selectRelevantPkmMemoryCards(snapshot.cards, "test*user?alpha+", 18)
    ).not.toThrow();

    const resultWithMetachars = selectRelevantPkmMemoryCards(
      snapshot.cards,
      "test*user?alpha+",
      18
    );
    const resultPlain = selectRelevantPkmMemoryCards(
      snapshot.cards,
      "test user alpha",
      18
    );

    // Both calls must return arrays — never undefined on malformed input.
    expect(Array.isArray(resultWithMetachars)).toBe(true);
    // Metachar query must score at least one match: tokens "test", "user",
    // "alpha" all appear in the "test_user_alpha" card searchText.
    expect(resultWithMetachars.length).toBeGreaterThan(0);
    // Token sets are identical after stripping metacharacters — results
    // must match exactly, proving operators were stripped not evaluated.
    expect(resultWithMetachars.length).toBe(resultPlain.length);
  });
});
