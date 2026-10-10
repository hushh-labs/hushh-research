import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mocks.fetch } }));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: {
  savePreparedDomain: mocks.write, saveMergedDomain: mocks.write,
} }));
vi.mock("@/lib/agent/agent-pkm-context-store", () => ({ AgentPkmContextStore: {
  load: async () => ({}), findBusinessReconciliationCandidates: () => [], findLocalDuplicate: () => null,
} }));
vi.mock("@/lib/profile/pkm-agent-lab-capture", () => ({ loadPkmAgentLabContext: async () => ({
  metadata: { domains: [{ key: "professional" }] }, manifests: {},
}) }));
import { prepareConnectorMemoryReview } from "@/lib/agent/connector-memory-review";

const fields = { name: "Portfolio Hotel", website: "https://example.test/",
  state: "TX ", description: "1. Business description with **literal** formatting" };
const input = { userId: "owner", vaultKey: "test-key", vaultOwnerToken: "test-token",
  source: "business_profile_review" as const, businessUid: "business-one", message: JSON.stringify(fields),
  assertCurrent: async () => undefined, isCurrent: () => true };
function response() {
  return { agent_id: "agent_pkm_structure", agent_name: "PKM Structure Agent", model: "test", used_fallback: false,
    preview_summary: { total_segments_detected: 1, split_recommended: false },
    preview_cards: [{ card_id: "one", source_text: input.message, write_mode: "confirm_first",
      target_domain: "professional", target_entity_scope: "businesses", target_entity_id: null,
      candidate_payload: { businesses: { entities: { raw_hotel: { ...fields } } } },
      structure_decision: { target_domain: "professional" },
      merge_decision: { merge_mode: "create_entity", target_domain: "professional", target_entity_path: "" },
    }] };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockImplementation(async () => ({ ok: true, json: async () => response() }));
});

it("runs the real HTTP normalizer, coverage and connector validators without changing exact listing strings", async () => {
  const result = await prepareConnectorMemoryReview(input);
  expect(result.incomplete).toBe(false);
  expect(result.cards).toHaveLength(1);
  expect(result.cards[0]!.candidate_payload).toEqual({ businesses: { entities: { raw_hotel: fields } } });
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  const [url, options] = mocks.fetch.mock.lastCall!;
  expect(url).toBe("/api/pkm/memory/proposals");
  expect(JSON.parse(options.body)).toMatchObject({ message: input.message, memory_profile: "business_directory_v1" });
  expect(mocks.write).not.toHaveBeenCalled();
});

it.each(["wrong_domain", "missing_field", "extra_field", "degraded", "split"])("rejects %s without a save or a substitute", async fault => {
  const payload = response();
  if (fault === "wrong_domain") payload.preview_cards[0]!.structure_decision.target_domain = "identity";
  if (fault === "missing_field") {
    const { state: _state, ...partial } = fields;
    payload.preview_cards[0]!.candidate_payload.businesses.entities.raw_hotel = partial as typeof fields;
  }
  if (fault === "extra_field") Object.assign(payload.preview_cards[0]!.candidate_payload.businesses.entities.raw_hotel, { invented: "Extra" });
  if (fault === "degraded") payload.used_fallback = true;
  if (fault === "split") payload.preview_summary.split_recommended = true;
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => payload });
  await expect(prepareConnectorMemoryReview(input)).rejects.toThrow();
  expect(mocks.write).not.toHaveBeenCalled();
});
