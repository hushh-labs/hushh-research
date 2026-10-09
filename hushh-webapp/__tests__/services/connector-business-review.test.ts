import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), candidates: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/agent/agent-pkm-context-store", () => ({ AgentPkmContextStore: {
  load: mocks.load, findBusinessReconciliationCandidates: mocks.candidates,
  findLocalDuplicate: () => null,
} }));
vi.mock("@/lib/profile/pkm-agent-lab-capture", () => ({ loadPkmAgentLabContext: async () => ({
  metadata: { domains: [{ key: "professional" }] }, manifests: {},
}) }));
vi.mock("@/lib/pkm/pkm-natural-language-ingestion", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/pkm/pkm-natural-language-ingestion")>(),
  prepareNaturalLanguagePkm: mocks.prepare,
}));
import { prepareConnectorMemoryReview } from "@/lib/agent/connector-memory-review";

const fields = { name: "Example", website: "https://example.test/", state: "TX" };
const input = { userId: "owner", vaultKey: "test-key", vaultOwnerToken: "test-token",
  source: "business_profile_review" as const, businessUid: "business-one", message: JSON.stringify(fields),
  assertCurrent: async () => undefined, isCurrent: () => true };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({});
  mocks.candidates.mockReturnValue([]);
  mocks.prepare.mockResolvedValue({ sourceCoverage: [], cards: [{ card_id: "example", write_mode: "confirm_first",
    target_domain: "professional", target_entity_scope: "businesses", target_entity_id: null,
    candidate_payload: { businesses: { entities: { example: fields } } },
    structure_decision: { target_domain: "professional" },
    merge_decision: { merge_mode: "create_entity", target_entity_path: "" },
  }] });
});

it("accepts a real create-shaped proposal and never substitutes generic preparation", async () => {
  const result = await prepareConnectorMemoryReview(input);
  expect(result.cards).toHaveLength(1);
  expect(result.incomplete).toBe(false);
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ memoryProfile: "business_directory_v1" }));
  expect(mocks.candidates).toHaveBeenCalledWith({ userId: "owner", businessUid: "business-one" });
});

it("suppresses only exact saved fields of the same UID and sends changed or missing fields for model review", async () => {
  const existing = { domain: "professional", entity_id: "example", entity_scope: "businesses",
    message: JSON.stringify(fields), active: true };
  mocks.candidates.mockReturnValue([existing]);
  expect(await prepareConnectorMemoryReview(input)).toEqual({ cards: [], incomplete: false, alreadySaved: true });
  expect(mocks.prepare).not.toHaveBeenCalled();
  for (const saved of [{ ...fields, state: "WA" }, { name: fields.name }]) {
    mocks.candidates.mockReturnValue([{ ...existing, message: JSON.stringify(saved) }]);
    await prepareConnectorMemoryReview(input);
    const request = mocks.prepare.mock.lastCall![0];
    expect(request.findReconciliationCandidates(input.message)[0].message).toBe(JSON.stringify(saved));
  }
  mocks.candidates.mockReturnValue([]);
  expect((await prepareConnectorMemoryReview({ ...input, businessUid: "another-business" })).alreadySaved).toBe(false);
});

it("keeps wrong destinations and extra policy facts out of the save UI", async () => {
  const prepared = await mocks.prepare();
  mocks.prepare.mockResolvedValue({ ...prepared, cards: [{ ...prepared.cards[0], target_domain: "identity" }] });
  expect(await prepareConnectorMemoryReview(input)).toMatchObject({ cards: [], incomplete: true, alreadySaved: false });
});
