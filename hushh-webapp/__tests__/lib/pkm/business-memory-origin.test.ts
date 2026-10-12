import { describe, expect, it } from "vitest";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import {
  assertBusinessMemoryTarget,
  assertProfileReviewTargetPath,
  assertProfileSelectionCreateTarget,
  touchesBusinessRecord,
} from "@/lib/pkm/business-memory-origin";
const card: AgentPkmPreviewCard = {
  card_id: "test",
  source_text: "Synthetic business",
  target_entity_scope: "businesses",
  target_entity_id: "chosen",
  candidate_payload: {
    businesses: {
      entities: {
        chosen: { _business_origin: { business_uid: "business-A" } },
      },
    },
  },
  merge_decision: {
    target_entity_path: "businesses.entities.chosen",
    merge_mode: "extend_entity",
  },
};
const current = (uid: string) => ({
  businesses: {
    entities: {
      chosen: { _business_origin: { business_uid: uid }, summary: "Synthetic" },
    },
  },
});
describe("one owner with independent businesses", () => {
  it("a checked addition cannot replace existing details at a fresh create target", () => {
    const incoming = {
      ...card,
      validation_hints: ["exact_profile_selection_v1"],
      merge_decision: {
        target_entity_path: "businesses.entities.chosen",
        merge_mode: "create_entity",
      },
    };
    expect(() =>
      assertProfileSelectionCreateTarget(incoming, {}),
    ).not.toThrow();
    const existing = current("business-A");
    const before = structuredClone(existing);
    expect(() =>
      assertProfileSelectionCreateTarget(incoming, existing),
    ).toThrow("Nothing was replaced");
    expect(existing).toEqual(before);
    expect(() =>
      assertProfileSelectionCreateTarget(
        {
          ...incoming,
          merge_decision: {
            ...incoming.merge_decision,
            merge_mode: "extend_entity",
          },
        },
        existing,
      ),
    ).not.toThrow();
  });
  it("rejects suffixes the writer would truncate, duplicate entity roots, and prototype paths", () => {
    for (const path of [
      "career.summary",
      "profile.entities.known.details",
      "entities.one.entities.two",
      "profile.__proto__.name",
    ])
      expect(() =>
        assertProfileReviewTargetPath({
          ...card,
          merge_decision: { target_entity_path: path },
        }),
      ).toThrow("destination");
    expect(() => assertProfileReviewTargetPath(card)).not.toThrow();
  });
  it("recognizes stored business origin at the actual target across scopes and on an implicit create", () => {
    const data = {
      profile: {
        entities: {
          known: { _business_origin: { business_uid: "business-A" } },
        },
      },
    };
    const incoming = {
      ...card,
      target_entity_scope: "notes",
      candidate_payload: {
        notes: { entities: { known: { summary: "A change" } } },
      },
      merge_decision: {
        merge_mode: "extend_entity",
        target_entity_path: "profile.entities.known",
      },
    };
    expect(touchesBusinessRecord(incoming)).toBe(false);
    expect(touchesBusinessRecord(incoming, data)).toBe(true);
    expect(
      touchesBusinessRecord(
        {
          ...incoming,
          merge_decision: {
            merge_mode: "extend_entity",
            target_entity_path: "profile.entities.other",
          },
        },
        data,
      ),
    ).toBe(false);
    expect(
      touchesBusinessRecord(
        {
          ...incoming,
          candidate_payload: {
            profile: { entities: { known: { summary: "A change" } } },
          },
          merge_decision: {
            merge_mode: "create_entity",
            target_entity_path: "",
          },
        },
        data,
      ),
    ).toBe(true);
  });
  it("uses the model payload identity for a new business but never invents an update target", () => {
    const created = {
      ...card,
      target_entity_id: undefined,
      merge_decision: {
        merge_mode: "create_entity",
        target_entity_id: "",
        target_entity_path: "",
      },
    };
    expect(() =>
      assertBusinessMemoryTarget({}, created, { businessUid: "business-A" }),
    ).not.toThrow();
    expect(() =>
      assertBusinessMemoryTarget(current("business-A"), created, {
        businessUid: "business-A",
      }),
    ).toThrow("already exists");
    expect(() =>
      assertBusinessMemoryTarget(
        {},
        {
          ...created,
          merge_decision: {
            merge_mode: "extend_entity",
            target_entity_path: "",
          },
        },
        { businessUid: "business-A" },
      ),
    ).toThrow("fresh review");
  });
  it("rejects the same UID at another entity or scope without choosing a new destination", () => {
    const existing = {
      profile: {
        entities: { old: { _business_origin: { business_uid: "business-A" } } },
      },
    };
    expect(() =>
      assertBusinessMemoryTarget(existing, card, { businessUid: "business-A" }),
    ).toThrow("already saved");
    expect(() =>
      assertBusinessMemoryTarget(
        { ...existing, ...current("business-A") },
        card,
        { businessUid: "business-A" },
      ),
    ).toThrow("already saved");
    const different = {
      profile: {
        entities: { old: { _business_origin: { business_uid: "business-B" } } },
      },
    };
    expect(() =>
      assertBusinessMemoryTarget(different, card, {
        businessUid: "business-A",
      }),
    ).not.toThrow();
  });
  it("allows new business memory and same-UID updates", () => {
    expect(() =>
      assertBusinessMemoryTarget({}, card, { businessUid: "business-A" }),
    ).not.toThrow();
    expect(() =>
      assertBusinessMemoryTarget(current("business-A"), card, {
        businessUid: "business-A",
      }),
    ).not.toThrow();
  });
  it("never relabels business A as B even when the private agent suggests the same entity", () => {
    const data = current("business-A");
    const before = structuredClone(data);
    const second = { ...card, candidate_payload: current("business-B") };
    expect(() =>
      assertBusinessMemoryTarget(data, second, { businessUid: "business-B" }),
    ).toThrow("different or unidentified");
    expect(data).toEqual(before);
  });
  it("checks the actual merge destination, not the incoming scope, on a retargeted preview", () => {
    const retargeted = {
      ...card,
      merge_decision: {
        merge_mode: "create_entity",
        target_entity_path: "profile.entities.chosen",
      },
    };
    expect(() =>
      assertBusinessMemoryTarget({}, retargeted, { businessUid: "business-A" }),
    ).not.toThrow();
    const destination = (uid: string) => ({
      profile: {
        entities: { chosen: { _business_origin: { business_uid: uid } } },
      },
    });
    expect(() =>
      assertBusinessMemoryTarget(destination("business-A"), retargeted, {
        businessUid: "business-A",
      }),
    ).toThrow("already exists");
    expect(() =>
      assertBusinessMemoryTarget(
        destination("business-A"),
        { ...retargeted, merge_mode: "extend_entity" },
        { businessUid: "business-A" },
      ),
    ).toThrow("already exists");
    const update = {
      ...retargeted,
      merge_decision: {
        ...retargeted.merge_decision,
        merge_mode: "correct_entity",
      },
    };
    expect(() =>
      assertBusinessMemoryTarget(destination("business-A"), update, {
        businessUid: "business-A",
      }),
    ).not.toThrow();
    const other = destination("business-B");
    const before = structuredClone(other);
    expect(() =>
      assertBusinessMemoryTarget(other, retargeted, {
        businessUid: "business-A",
      }),
    ).toThrow("different or unidentified");
    expect(other).toEqual(before);
    expect(() =>
      assertBusinessMemoryTarget(
        { profile: { entities: { chosen: { summary: "Unidentified" } } } },
        retargeted,
        { businessUid: "business-A" },
      ),
    ).toThrow();
  });
  it("does not silently claim an older unlabeled entity", () => {
    expect(() =>
      assertBusinessMemoryTarget(
        {
          businesses: { entities: { chosen: { summary: "Unknown business" } } },
        },
        card,
        { businessUid: "business-A" },
      ),
    ).toThrow();
  });
  it("rejects unknown destination and prototype traversal", () => {
    expect(() =>
      assertBusinessMemoryTarget(
        {},
        {
          ...card,
          target_entity_scope: undefined,
          target_entity_id: undefined,
          merge_decision: undefined,
        },
        { businessUid: "business-A" },
      ),
    ).toThrow();
    expect(() =>
      assertBusinessMemoryTarget(
        {},
        { ...card, merge_decision: { target_entity_path: "__proto__.test" } },
        { businessUid: "business-A" },
      ),
    ).toThrow();
  });
  it("rejects missing or contradictory incoming provenance before creating an entity", () => {
    expect(() =>
      assertBusinessMemoryTarget(
        {},
        { ...card, candidate_payload: {} },
        { businessUid: "business-A" },
      ),
    ).toThrow();
    expect(() =>
      assertBusinessMemoryTarget({}, card, { businessUid: "business-B" }),
    ).toThrow();
  });
});
