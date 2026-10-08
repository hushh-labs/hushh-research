import { describe, expect, it } from "vitest";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import { assertBusinessMemoryTarget } from "@/lib/pkm/business-memory-origin";
const card: AgentPkmPreviewCard = { card_id: "test", source_text: "Synthetic business", target_entity_scope: "businesses",
  target_entity_id: "chosen", candidate_payload: { businesses: { entities: { chosen: { _business_origin: { business_uid: "business-A" } } } } },
  merge_decision: { target_entity_path: "businesses.entities.chosen", merge_mode: "extend_entity" } };
const current = (uid: string) => ({ businesses: { entities: { chosen: { _business_origin: { business_uid: uid }, summary: "Synthetic" } } } });
describe("one owner with independent businesses", () => {
  it("allows new business memory and same-UID updates", () => {
    expect(() => assertBusinessMemoryTarget({}, card, { businessUid: "business-A" })).not.toThrow();
    expect(() => assertBusinessMemoryTarget(current("business-A"), card, { businessUid: "business-A" })).not.toThrow();
  });
  it("never relabels business A as B even when the private agent suggests the same entity", () => {
    const data = current("business-A"); const before = structuredClone(data);
    const second = { ...card, candidate_payload: current("business-B") };
    expect(() => assertBusinessMemoryTarget(data, second, { businessUid: "business-B" })).toThrow("different or unidentified");
    expect(data).toEqual(before);
  });
  it("checks the actual merge destination, not the incoming scope, on a retargeted preview", () => {
    const retargeted = { ...card, merge_decision: { merge_mode: "create_entity", target_entity_path: "profile.entities.chosen" } };
    expect(() => assertBusinessMemoryTarget({}, retargeted, { businessUid: "business-A" })).not.toThrow();
    const destination = (uid: string) => ({ profile: { entities: { chosen: { _business_origin: { business_uid: uid } } } } });
    expect(() => assertBusinessMemoryTarget(destination("business-A"), retargeted, { businessUid: "business-A" })).not.toThrow();
    const other = destination("business-B"); const before = structuredClone(other);
    expect(() => assertBusinessMemoryTarget(other, retargeted, { businessUid: "business-A" })).toThrow("different or unidentified");
    expect(other).toEqual(before);
    expect(() => assertBusinessMemoryTarget({ profile: { entities: { chosen: { summary: "Unidentified" } } } },
      retargeted, { businessUid: "business-A" })).toThrow();
  });
  it("does not silently claim an older unlabeled entity", () => {
    expect(() => assertBusinessMemoryTarget({ businesses: { entities: { chosen: { summary: "Unknown business" } } } }, card,
      { businessUid: "business-A" })).toThrow();
  });
  it("rejects unknown destination and prototype traversal", () => {
    expect(() => assertBusinessMemoryTarget({}, { ...card, target_entity_scope: undefined, target_entity_id: undefined,
      merge_decision: undefined }, { businessUid: "business-A" })).toThrow();
    expect(() => assertBusinessMemoryTarget({}, { ...card, merge_decision: { target_entity_path: "__proto__.test" } },
      { businessUid: "business-A" })).toThrow();
  });
  it("rejects missing or contradictory incoming provenance before creating an entity", () => {
    expect(() => assertBusinessMemoryTarget({}, { ...card, candidate_payload: {} }, { businessUid: "business-A" })).toThrow();
    expect(() => assertBusinessMemoryTarget({}, card, { businessUid: "business-B" })).toThrow();
  });
});
