import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import type { BusinessCandidate, BusinessReviewCheckpoint } from "@/lib/agent/business-profile-review";
import { isInternalManifestPath } from "@/lib/pkm/internal-path-keys";
import { shouldSkipPkmAgentContextKey } from "@/lib/pkm/pkm-memory-cards";
import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";
import { encryptData, decryptData } from "@/lib/vault/encrypt";

const mocks = vi.hoisted(() => ({ read: vi.fn(), persist: vi.fn(), lookup: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/services/secure-resource-cache-service", () => ({ SecureResourceCacheService: { readRequired: mocks.read, writeRequired: mocks.persist } }));
vi.mock("@/lib/agent/connector-memory-review", () => ({ saveConnectorMemoryReview: mocks.save }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: { lookupMutationCommits: mocks.lookup } }));
vi.mock("@/lib/pkm/pkm-save-job", () => ({ withPkmSaveJobLock: async (_id: string, task: () => unknown) => task() }));
import { assertBusinessReviewFresh, attachBusinessOrigin, businessDraftMessage, createBusinessReviewJob, decideBusinessReview, loadBusinessReview, saveBusinessReview } from "@/lib/agent/business-profile-review";
import { businessReviewFields, businessReviewItems, selectBusinessReviewFields } from "@/lib/agent/business-profile-fields";
import { validBusinessProfilePreview } from "@/lib/agent/business-profile-contract";

export const candidate: BusinessCandidate = { businessUid: "urn:hushh:business:uat:hushh.ai:v1", synthetic: true,
  sourceIdentity: { source: "uat_fixture", sourceKey: "hushh.ai:v1" }, matchEvidence: [{ kind: "verified_email_domain", domain: "hushh.ai" }],
  draft: { name: "Hushh — UAT Test Business", website: "https://hushh.ai" }, ownershipVerified: false,
  claimCreated: false, verificationRequired: ["business_authority"] };
const card = (id = "one"): AgentPkmPreviewCard => ({ card_id: id, source_text: `Test detail ${id}`, write_mode: "confirm_first",
  target_domain: "professional", target_entity_scope: "businesses", target_entity_id: `mem_${id}`,
  candidate_payload: { businesses: { entities: { [`mem_${id}`]: { summary: `Test detail ${id}`, observations: [] } } } },
  merge_mode: "create_entity", merge_decision: { merge_mode: "create_entity" } });
let checkpoint: BusinessReviewCheckpoint | null;
beforeEach(() => {
  vi.clearAllMocks(); checkpoint = null;
  mocks.read.mockImplementation(async () => checkpoint);
  mocks.persist.mockImplementation(async ({ value }) => { checkpoint = structuredClone(value); });
  mocks.lookup.mockResolvedValue([{ exists: false, dataVersion: null }]);
  mocks.save.mockResolvedValue({ saved: 1, failed: 0, results: [{ success: true, result: { dataVersion: 1 } }] });
});
const args = (cards = [card()]) => ({ job: createBusinessReviewJob("owner", candidate, "Reviewed synthetic details", cards),
  vaultKey: "test-key", vaultOwnerToken: "test-token", assertCurrent: vi.fn(async () => undefined),
  isCurrent: () => true, sharingImpactAcknowledged: false, assertListingFresh: vi.fn(async () => undefined) });

describe("business profile reviewed-memory boundary", () => {
  it("keeps policy out of source facts and rejects personal destinations, sibling facts and invented metadata", () => {
    const message = businessDraftMessage(candidate, "Example business", "https://example.test");
    const details = JSON.parse(message);
    expect(details).toEqual({ name: "Example business", website: "https://example.test/" });
    const proposal = { ...card(), candidate_payload: { businesses: { entities: { mem_one: details } } } };
    expect(validBusinessProfilePreview([proposal], message)).toBe(true);
    expect(validBusinessProfilePreview([{ ...proposal, target_domain: "identity" }], message)).toBe(false);
    expect(validBusinessProfilePreview([{ ...proposal, candidate_payload: { ...proposal.candidate_payload, personal_fact: "example" } }], message)).toBe(false);
    expect(validBusinessProfilePreview([{ ...proposal, candidate_payload: { businesses: { entities: { mem_one: { ...details, summary: "A disclaimer" } } } } }], message)).toBe(false);
    expect(validBusinessProfilePreview([proposal, proposal], message)).toBe(false);
    expect(validBusinessProfilePreview([{ ...proposal, merge_decision: { merge_mode: "extend_entity", target_entity_path: "profile.entities.mem_one" } }], message)).toBe(false);
  });
  it("groups exact readable repetitions while preserving every raw consent reference", () => {
    const repeated = { ...card(), candidate_payload: { businesses: { entities: { mem_one: {
      kind: "profile_fact", summary: "state: TX", observations: ["state: TX"], status: "active",
    } } } } };
    const items = businessReviewItems([repeated]);
    const state = items.find(item => item.label === "State")!;
    expect(state.text).toBe("TX");
    expect(state.fields).toHaveLength(2);
    const selected = selectBusinessReviewFields(repeated, state.fields.map(field => field.fieldId))!;
    expect(selected.candidate_payload).toEqual({ businesses: { entities: { mem_one: { summary: "state: TX", observations: ["state: TX"] } } } });
    expect(items.filter(item => item.recordDetail).map(item => item.text)).toEqual(["Profile detail", "Active"]);
    const distinct = { ...card(), candidate_payload: { businesses: { entities: { mem_one: { summary: "state: TX", observations: ["state: tx"], city: "TX" } } } } };
    expect(businessReviewItems([distinct])).toHaveLength(3);
  });
  it("freezes approved nested fields without excluded payloads or summaries and replays them exactly", async () => {
    const original = { ...card(), source_text: "Secret phone +15555550100", context_quotes: ["+15555550100"],
      structure_decision: { target_domain: "professional", explanation: "The phone is +15555550100", summary_projection: { phone: "+15555550100" } },
      candidate_payload: { businesses: { entities: { mem_one: { name: "Approved", entity_id: "mem_one", updated_at: "writer metadata", contact: { phone: "+15555550100", website: "https://approved.test" } } },
        unreviewed: "+15555550100" } } };
    const fields = businessReviewFields(original);
    const projected = selectBusinessReviewFields(original, fields.filter(field => field.path.at(-1) !== "phone").map(field => field.id))!;
    expect(projected.candidate_payload).toEqual({ businesses: { entities: { mem_one: { name: "Approved", contact: { website: "https://approved.test" } } } } });
    expect(JSON.stringify(projected)).not.toContain("+15555550100");
    expect(projected.merge_decision).toEqual(original.merge_decision);
    expect(original.candidate_payload.businesses.unreviewed).toBe("+15555550100");
    expect(selectBusinessReviewFields(original, [])).toBeNull();
    expect(() => selectBusinessReviewFields(original, ["unknown"])).toThrow();
    const input = args([projected]);
    mocks.save.mockRejectedValueOnce(new Error("lost response"));
    await expect(saveBusinessReview(input)).rejects.toThrow();
    const frozen = structuredClone(checkpoint!.job!);
    expect(await saveBusinessReview({ ...input, job: frozen })).toEqual({ saved: 1, remaining: 0 });
    expect(mocks.save.mock.calls[1]![0].cards).toEqual(frozen.cards);
    expect(JSON.stringify(frozen.cards)).not.toContain("+15555550100");
  });
  it("recovers existing receipts during an outage but blocks unacknowledged stale writes", async () => {
    const assertListingFresh = vi.fn(async () => { throw new Error("Listing unavailable"); });
    const input = { ...args(), assertListingFresh };
    await expect(saveBusinessReview(input)).rejects.toThrow("Listing unavailable");
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.lookup.mockResolvedValue([{ exists: true, dataVersion: 2 }]);
    assertListingFresh.mockClear();
    expect(await saveBusinessReview(input)).toEqual({ saved: 1, remaining: 0 });
    expect(assertListingFresh).not.toHaveBeenCalled();
  });
  it("binds recovered cards and user edits to the original listing, not a same-UID refresh", async () => {
    const job = createBusinessReviewJob("owner", candidate, "Approved edits", [card()],
      { name: "My correction", website: "https://edited.test" });
    checkpoint = { version: 1, job };
    const recovered = await loadBusinessReview("owner", "key", candidate.businessUid);
    expect(recovered?.job?.reviewedName).toBe("My correction");
    expect(recovered?.job?.reviewedWebsite).toBe("https://edited.test");
    expect(() => assertBusinessReviewFresh(job, structuredClone(candidate))).not.toThrow();
    const changed = { ...candidate, draft: { ...candidate.draft, name: "New public name" } };
    expect(() => assertBusinessReviewFresh(job, changed)).toThrow("listing changed");
    expect(job.candidate?.draft.name).toBe(candidate.draft.name);
  });
  it("legacy pending reviews reconcile receipts but cannot initiate new writes", async () => {
    const input = args();
    delete input.job.candidate; delete input.job.candidateSnapshot;
    checkpoint = { version: 1, job: input.job };
    await expect(saveBusinessReview(input)).rejects.toThrow("no original listing snapshot");
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.lookup.mockResolvedValue([{ exists: true, dataVersion: 2 }]);
    expect(await saveBusinessReview(input)).toEqual({ saved: 1, remaining: 0 });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("isolates real business checkpoints and preserves real provenance on retry", async () => {
    const real: BusinessCandidate = { ...candidate, synthetic: false,
      businessUid: `urn:hushh:business:directory:hotel:${"a".repeat(64)}`,
      sourceIdentity: { source: "directory", sourceKey: '{"id":"1"}', vertical: "hotel" } };
    const input = { ...args(), job: createBusinessReviewJob("owner", real, "Reviewed public details", [card()]) };
    expect(await saveBusinessReview(input)).toEqual({ saved: 1, remaining: 0 });
    expect(mocks.read.mock.calls[0]![0].resourceKey).toContain(encodeURIComponent(real.businessUid));
    expect(mocks.persist.mock.calls.every(([value]) => value.resourceKey.includes(encodeURIComponent(real.businessUid)))).toBe(true);
    expect(JSON.stringify(input.job.cards)).toContain('"synthetic":false');
    checkpoint = { version: 1, job: input.job };
    await expect(loadBusinessReview("owner", "key", candidate.businessUid)).rejects.toThrow();
    expect(businessDraftMessage(real, "Example", "")).not.toContain("synthetic UAT");
  });
  it("keeps immutable business identity on the semantic entity without altering its domain or ID", () => {
    const original = card(); const result = attachBusinessOrigin(original, candidate);
    expect(result.target_domain).toBe("professional"); expect(result.target_entity_id).toBe("mem_one");
    expect(result.candidate_payload).toMatchObject({ businesses: { entities: { mem_one: { _business_origin: {
      business_uid: candidate.businessUid, synthetic: true, ownership_verified: false,
      source_identity: { source: "uat_fixture", source_key: "hushh.ai:v1" },
    } } } } });
    expect(JSON.stringify(original)).not.toContain("_business_origin");
    expect(shouldSkipPkmAgentContextKey("_business_origin")).toBe(true);
    expect(isInternalManifestPath("businesses.entities.mem_one.business_origin.business_uid")).toBe(true);
  });
  it("round-trips origin in encrypted domain data while keeping it out of exposable manifests", async () => {
    const payload = attachBusinessOrigin(card(), candidate).candidate_payload!;
    const key = "ab".repeat(32);
    const encrypted = await encryptData(JSON.stringify(payload), key);
    expect(JSON.stringify(encrypted)).not.toContain(candidate.businessUid);
    expect(JSON.parse(await decryptData(encrypted, key))).toEqual(payload);
    const artifacts = buildPersonalKnowledgeModelStructureArtifacts({ domain: "professional", domainData: payload });
    expect(artifacts.manifest.paths.filter(path => path.exposure_eligibility && path.json_path.includes("business_origin"))).toEqual([]);
    expect(JSON.stringify(artifacts.manifest)).not.toContain(candidate.businessUid);
  });
  it("rejects malformed or ambiguous semantic destinations instead of inventing a profile structure", () => {
    expect(() => attachBusinessOrigin({ ...card(), candidate_payload: { summary: "no entity" } }, candidate)).toThrow();
    expect(() => attachBusinessOrigin({ ...card(), candidate_payload: { businesses: { entities: { a: {}, b: {} } } } }, candidate)).toThrow();
    expect(() => attachBusinessOrigin({ ...card(), merge_mode: "delete_entity", merge_decision: { merge_mode: "delete_entity" } }, candidate)).toThrow();
    expect(() => attachBusinessOrigin({ ...card(), target_entity_id: "different" }, candidate)).toThrow();
    expect(() => attachBusinessOrigin({ ...card(), merge_decision: { merge_mode: "extend_entity", target_entity_path: "other.entities.other" } }, candidate)).toThrow();
    expect(() => attachBusinessOrigin({ ...card(), target_entity_scope: "other.entities" }, candidate)).toThrow();
  });
  it("accepts the canonical entity-collection scope without changing its destination", () => {
    const original = { ...card(), target_entity_scope: "businesses.entities" };
    const result = attachBusinessOrigin(original, candidate);
    expect(result.target_entity_scope).toBe("businesses.entities");
    expect(result.target_entity_id).toBe("mem_one");
    expect(result.candidate_payload).toMatchObject({ businesses: { entities: { mem_one: {
      _business_origin: { business_uid: candidate.businessUid },
    } } } });
    expect(() => attachBusinessOrigin({ ...original, target_entity_id: "other" }, candidate)).toThrow();
  });
  it("preserves the canonical merge destination when its scope differs from the incoming entity", () => {
    const original = { ...card(), target_entity_scope: "profile", merge_decision: {
      merge_mode: "create_entity", target_entity_path: "profile.entities.mem_one",
    } };
    const result = attachBusinessOrigin(original, candidate);
    expect(result.merge_decision).toEqual(original.merge_decision);
    expect(result.target_entity_scope).toBe("profile");
    expect(result.candidate_payload).toMatchObject({ businesses: { entities: { mem_one: {
      _business_origin: { business_uid: candidate.businessUid },
    } } } });
  });
  it("edits change reviewed content but never source identity; website credentials and unsafe schemes are rejected", () => {
    expect(businessDraftMessage(candidate, "Edited test business", "https://example.test")).toContain("Edited test business");
    expect(businessDraftMessage(candidate, "Edited test business", "https://example.test")).not.toContain("untrusted source details");
    expect(businessDraftMessage(candidate, "Edited test business", "http://example.test")).toContain("http://example.test/");
    for (const website of ["javascript:alert(1)", "https://user:pass@example.test", "http://user:pass@example.test"])
      expect(() => businessDraftMessage(candidate, "Test", website)).toThrow();
    expect(() => businessDraftMessage(candidate, "", "https://example.test")).toThrow();
  });
  it("checkpoints exact reviewed cards before any cloud write and completes only on acknowledged revisions", async () => {
    const input = args(); const result = await saveBusinessReview(input);
    expect(result).toEqual({ saved: 1, remaining: 0 });
    expect(mocks.persist.mock.invocationCallOrder[0]).toBeLessThan(mocks.save.mock.invocationCallOrder[0]!);
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ source: "business_profile_review", cards: input.job.cards,
      idempotencyScopes: input.job.scopes, message: input.job.message });
    expect(checkpoint).toEqual({ version: 1, decision: "saved" });
    expect(JSON.stringify(mocks.persist.mock.calls)).not.toContain("test-token");
  });
  it("fails closed when encrypted recovery is unavailable", async () => {
    mocks.persist.mockRejectedValue(new Error("synthetic storage failure"));
    await expect(saveBusinessReview(args())).rejects.toThrow(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("consults a lost-response receipt before retry; committed cards are not replayed", async () => {
    const input = args([card("one"), card("two")]);
    mocks.save.mockResolvedValueOnce({ results: [{ success: true, result: { dataVersion: 1 } }] }).mockRejectedValueOnce(new Error("lost response"));
    await expect(saveBusinessReview(input)).rejects.toThrow();
    expect(checkpoint?.job?.committed).toEqual(["one"]);
    const scopes = checkpoint!.job!.scopes;
    mocks.lookup.mockResolvedValue([{ exists: true, dataVersion: 2 }]);
    expect(await saveBusinessReview({ ...input, job: checkpoint!.job! })).toEqual({ saved: 2, remaining: 0 });
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(scopes).toEqual(input.job.scopes);
  });
  it("does not report missing acknowledgement as saved", async () => {
    mocks.save.mockResolvedValue({ results: [{ success: true, result: { dataVersion: undefined } }] });
    expect(await saveBusinessReview(args())).toEqual({ saved: 0, remaining: 1 });
    expect(checkpoint?.decision).toBeUndefined();
  });
  it("refuses a competing review revision instead of overwriting its checkpoint", async () => {
    checkpoint = { version: 1, job: args().job };
    await expect(saveBusinessReview(args())).rejects.toThrow("Another review");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("abort after a read prevents the next mutation", async () => {
    const input = args(); input.assertCurrent.mockRejectedValue(new DOMException("locked", "AbortError"));
    await expect(saveBusinessReview(input)).rejects.toThrow();
    expect(mocks.persist).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("does not restore a checkpoint belonging to a different owner", async () => {
    checkpoint = { version: 1, job: { ...args().job, ownerId: "another-owner" } };
    await expect(loadBusinessReview("owner", "test-key", candidate.businessUid)).rejects.toThrow();
  });
  it("rejects scope replay and duplicate acknowledgement IDs before any mutation", async () => {
    const job = args([card("one"), card("two")]).job;
    checkpoint = { version: 1, job: { ...job, scopes: [job.scopes[0]!, job.scopes[0]!] } };
    await expect(loadBusinessReview("owner", "key", candidate.businessUid)).rejects.toThrow();
    checkpoint = { version: 1, job: { ...job, committed: ["one", "one"] } };
    await expect(loadBusinessReview("owner", "key", candidate.businessUid)).rejects.toThrow();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("a stale Later preserves the other tab's exact pending job", async () => {
    const job = args().job; checkpoint = { version: 1, job };
    await decideBusinessReview({ ownerId: "owner", vaultKey: "key", businessUid: candidate.businessUid, decision: "later", assertCurrent: async () => undefined });
    expect(checkpoint?.job).toEqual(job); expect(checkpoint?.decision).toBe("later");
  });
  it("Not me cannot discard a pending job and Later cannot overwrite a completed save", async () => {
    checkpoint = { version: 1, job: args().job };
    await expect(decideBusinessReview({ ownerId: "owner", vaultKey: "key", businessUid: candidate.businessUid, decision: "not_me", assertCurrent: async () => undefined })).rejects.toThrow();
    checkpoint = { version: 1, decision: "saved" };
    await decideBusinessReview({ ownerId: "owner", vaultKey: "key", businessUid: candidate.businessUid, decision: "later", assertCurrent: async () => undefined });
    expect(checkpoint).toEqual({ version: 1, decision: "saved" });
  });
});
