import { describe, expect, it } from "vitest";

import {
  buildPkmMemoryCardsFromNode,
  buildPkmMemorySnapshot,
  deletePkmDomainValue,
  pkmMemoryRowLabels,
  selectRelevantPkmMemoryCards,
  shouldSkipPkmAgentContextKey,
  shouldSkipPkmMemoryKey,
  updatePkmDomainValue,
} from "@/lib/pkm/pkm-memory-cards";
import type { PersonalKnowledgeModelMetadata } from "@/lib/services/personal-knowledge-model-service";
import { buildLocationMemoryPresentation, findLocationMemoryFieldForCard, resolveLocationMemoryField } from "@/lib/profile/location-memory-presentation";

describe("Location memory read projection", () => {
  it("routes represented title and address leaves from search without adding duplicate display rows", () => {
    const data = { saved_places: { locations: [{ id: "home", label: "Home", category: "home", address: "Synthetic street", addressBase: "Synthetic street" }] }, visit_notes: { visits: [{ placeId: "cafe", label: "Cafe", note: "Synthetic visit" }] } };
    const presentation = buildLocationMemoryPresentation({ data });
    expect(presentation.sections.flatMap((section) => section.fields).map((field) => field.value)).toEqual(["Synthetic street", "Synthetic visit"]);
    const cards = buildPkmMemoryCardsFromNode({ domain: "location", domainTitle: "Location", value: data, sourceLabel: "Saved memory", updatedAt: null, pathSegments: [] });
    for (const card of cards) {
      const field = findLocationMemoryFieldForCard(presentation, card);
      expect(field?.card.path).toEqual(card.path);
      expect(field?.selector, card.path).toMatch(/^[a-f0-9]{16}$/);
      expect(resolveLocationMemoryField(presentation, field?.selector)?.card.pathSegments).toEqual(card.pathSegments);
      expect(field?.card.reservedOwner?.appName).toBe("Location");
    }
  });

  it("does not confuse a represented record label with a nested future field of the same name", () => {
    const data = { saved_places: { locations: [{ id: "home", label: "Home", addressDetails: { label: "Entrance" } }] } };
    const presentation = buildLocationMemoryPresentation({ data });
    const [label] = buildPkmMemoryCardsFromNode({ domain: "location", domainTitle: "Location", value: "Home", sourceLabel: "Saved memory", updatedAt: null, pathSegments: ["saved_places", "locations", 0, "label"] });
    const field = findLocationMemoryFieldForCard(presentation, label!);
    expect(resolveLocationMemoryField(presentation, field?.selector)?.value).toBe("Home");
    expect(presentation.sections[0]!.fields.map((entry) => entry.value)).toEqual(["Entrance"]);
  });

  it("matches canonical typed paths when dotted legacy keys have the same display path and value", () => {
    const data = { agent_memory: { "a.b": "Same", a: { b: "Same" } } };
    const presentation = buildLocationMemoryPresentation({ data });
    const cards = buildPkmMemoryCardsFromNode({ domain: "location", domainTitle: "Location", value: data, sourceLabel: "Saved memory", updatedAt: null, pathSegments: [] });
    expect(cards[0]!.path).toBe(cards[1]!.path);
    for (const card of cards) {
      const field = findLocationMemoryFieldForCard(presentation, card);
      expect(resolveLocationMemoryField(presentation, field?.selector)?.card.pathSegments).toEqual(card.pathSegments);
    }
    expect(findLocationMemoryFieldForCard({ ...presentation, navigationFields: [presentation.sections[0]!.fields[0]!] }, cards[0]!)).toBeNull();
  });

  it("keeps writer entity identities stable for equal visible records and rejects indistinguishable fallback records", () => {
    const a = { entity_id: "a", note: "Same note" };
    const b = { entity_id: "b", note: "Same note" };
    const first = buildLocationMemoryPresentation({ data: { agent_memory: { places: [a, b] } } });
    const selector = first.sections[0]!.fields[0]!.selector;
    const next = buildLocationMemoryPresentation({ data: { agent_memory: { places: [b, a] } } });
    expect(resolveLocationMemoryField(next, selector)?.card.pathSegments).toEqual(["agent_memory", "places", 1, "note"]);
    const ambiguous = buildLocationMemoryPresentation({ data: { agent_memory: { places: [{ note: "Same note", secret_key: "hidden-a" }, { note: "Same note", secret_key: "hidden-b" }] } } });
    expect(ambiguous.sections[0]!.fields).toHaveLength(2);
    expect(ambiguous.sections[0]!.fields.every((field) => field.selector === null)).toBe(true);
    expect(resolveLocationMemoryField(ambiguous, selector)).toBeNull();
  });

  it("bounds fallback identity traversal before serialization of deep and wide legacy arrays", () => {
    let deep: unknown = "Deep leaf";
    for (let level = 0; level < 10_000; level += 1) deep = { child: deep };
    for (const items of [[{ note: "Readable", deep }], [{ note: "Readable", children: Array.from({ length: 20_001 }, () => null) }]]) {
      const presentation = buildLocationMemoryPresentation({ data: { agent_memory: { places: items } } });
      expect(presentation.incomplete).toBe(true);
      const readable = presentation.sections.flatMap((section) => section.fields).find((field) => field.value === "Readable");
      expect(readable).toBeDefined();
      expect(readable?.selector).toBeNull();
    }
  });

  it("retains legacy nested facts, primitive values and malformed collection entries without changing their paths", () => {
    const presentation = buildLocationMemoryPresentation({ data: { saved_places: { locations: ["Legacy place", { label: "Label only" }, { category: "home" }] }, legacy: { addresses: [{ note: "Legacy note", enabled: false, floor: 0 }] }, home_city: "Synthetic city" } });
    const fields = presentation.sections.flatMap((section) => section.fields);
    expect(fields.map((field) => field.value)).toEqual(["Legacy place", "Label only", "home", "Legacy note", "false", "0", "Synthetic city"]);
    expect(fields.find((field) => field.value === "Legacy place")?.card.pathSegments).toEqual(["saved_places", "locations", 0]);
    expect(fields.find((field) => field.value === "Legacy note")?.card.pathSegments).toEqual(["legacy", "addresses", 0, "note"]);
    expect(buildLocationMemoryPresentation({ data: null }).sections).toEqual([]);
    expect(buildLocationMemoryPresentation({ data: { saved_places: { locations: [] }, visit_notes: { visits: [] } } }).sections).toEqual([]);
  });

  it("exposes complete place details without changing the typed record or reserved policy", () => {
    const address = "Synthetic long address ".repeat(20);
    const data = { saved_places: { schema_version: 2, locations: [{ id: "place-a", label: "Home", address, addressBase: "Distinct street", latitude: 10, longitude: 20, addressDetails: { houseOrFlat: "12", postalCode: "12345" } }] }, visit_notes: { visits: [{ placeId: "venue-a", label: "Cafe", note: "Synthetic note", rating: 4 }] } };
    const original = structuredClone(data);
    const presentation = buildLocationMemoryPresentation({ data });
    expect(data).toEqual(original);
    expect(presentation.sections.map((section) => section.title)).toEqual(["Home", "Cafe"]);
    const fields = presentation.sections[0]!.fields;
    expect(fields.find((field) => field.label === "Address")?.value).toBe(address);
    expect(fields.find((field) => field.label === "Street address")?.value).toBe("Distinct street");
    expect(fields.find((field) => field.label === "House or flat")?.card.pathSegments).toEqual(["saved_places", "locations", 0, "addressDetails", "houseOrFlat"]);
    expect(fields.every((field) => !field.card.editable && field.card.reservedOwner?.appName === "Location")).toBe(true);
  });

  it("filters hidden ancestors and fields and keeps secrets out of routing identity", () => {
    const data = { _private: { note: "hidden ancestor" }, access_token: { note: "hidden token" }, agent_memory: { places: [{ name: "Visible", note: "Visible note", access_token: "secret-one" }] } };
    const first = buildLocationMemoryPresentation({ data });
    data.agent_memory.places[0]!.access_token = "secret-two";
    const next = buildLocationMemoryPresentation({ data });
    expect(first.sections.flatMap((section) => section.fields.map((field) => field.value))).toEqual(["Visible", "Visible note"]);
    expect(next.sections.flatMap((section) => section.fields.map((field) => field.selector))).toEqual(first.sections.flatMap((section) => section.fields.map((field) => field.selector)));
  });

  it("resolves stable record links after reordering and fails closed for deleted or ambiguous records", () => {
    const a = { id: "a", label: "Home", address: "Same address" };
    const b = { id: "b", label: "Work", address: "Same address" };
    const first = buildLocationMemoryPresentation({ data: { saved_places: { locations: [a, b] } } });
    const selector = first.sections[0]!.fields[0]!.selector;
    const reordered = buildLocationMemoryPresentation({ data: { saved_places: { locations: [b, a] } } });
    expect(resolveLocationMemoryField(reordered, selector)?.card.pathSegments).toEqual(["saved_places", "locations", 1, "address"]);
    expect(resolveLocationMemoryField(buildLocationMemoryPresentation({ data: { saved_places: { locations: [b] } } }), selector)).toBeNull();
    expect(resolveLocationMemoryField(buildLocationMemoryPresentation({ data: { saved_places: { locations: [a, a] } } }), selector)).toBeNull();
    expect(resolveLocationMemoryField(reordered, "Home/Same address")).toBeNull();
  });
});

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

  it("never shows a superseded value as a current fact, in Memory or in One's context", () => {
    // An update keeps the earlier value under `superseded` (pkm-supersede-merge.ts).
    const snapshot = buildPkmMemorySnapshot({
      metadata,
      fullBlob: {
        professional: {
          current_role: {
            title: "Staff Engineer",
            superseded: { title: [{ value: "Senior Engineer", superseded_at: "2026-09-29T00:00:00.000Z" }] },
          },
        },
      },
    });
    expect(JSON.stringify(snapshot)).toContain("Staff Engineer");
    expect(JSON.stringify(snapshot)).not.toContain("Senior Engineer");
    expect(shouldSkipPkmAgentContextKey("superseded")).toBe(true);
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

  describe("shouldSkipPkmAgentContextKey", () => {
    it("keeps restricted KYC identifiers out of One's automatic PKM context", () => {
      expect(shouldSkipPkmAgentContextKey("aadhaar_number")).toBe(true);
      expect(shouldSkipPkmAgentContextKey("aadhar_number")).toBe(true);
      expect(shouldSkipPkmAgentContextKey("pan_number")).toBe(true);
      expect(shouldSkipPkmAgentContextKey("passport_number")).toBe(true);
      expect(shouldSkipPkmAgentContextKey("roll_number")).toBe(false);
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

describe("Memory policy for app-owned branches (reserved-branches.v1.json)", () => {
  const cardsAt = (domain: string, value: unknown) =>
    buildPkmMemoryCardsFromNode({
      domain,
      domainTitle: domain,
      value,
      sourceLabel: "Saved memory",
      updatedAt: null,
      pathSegments: [],
    });

  it("makes an item in a reserved branch read-only and names the app that owns it", () => {
    const [card] = cardsAt("location", { saved_places: { home: { label: "Home" } } });
    expect(card?.editable).toBe(false);
    expect(card?.reservedOwner).toEqual({
      ownerFeature: "location",
      appName: "Location",
      routePattern: "/one/location",
    });
  });

  it("keeps an item in the agent_memory sibling editable (negative control)", () => {
    const [card] = cardsAt("location", { agent_memory: { entities: { mem_1: { summary: "Near the lake" } } } });
    expect(card?.editable).toBe(true);
    expect(card?.reservedOwner).toBeNull();
  });
});
