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
import { attachBusinessOrigin, businessDraftMessage, createBusinessReviewJob, decideBusinessReview, loadBusinessReview, saveBusinessReview } from "@/lib/agent/business-profile-review";

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
  isCurrent: () => true, sharingImpactAcknowledged: false });

describe("business profile reviewed-memory boundary", () => {
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
    expect(businessDraftMessage(candidate, "Edited test business", "https://example.test")).toContain("keep its fields together");
    for (const website of ["http://example.test", "javascript:alert(1)", "https://user:pass@example.test"])
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
    await expect(loadBusinessReview("owner", "test-key")).rejects.toThrow();
  });
  it("a stale Later preserves the other tab's exact pending job", async () => {
    const job = args().job; checkpoint = { version: 1, job };
    await decideBusinessReview({ ownerId: "owner", vaultKey: "key", decision: "later", assertCurrent: async () => undefined });
    expect(checkpoint?.job).toEqual(job); expect(checkpoint?.decision).toBe("later");
  });
  it("Not me cannot discard a pending job and Later cannot overwrite a completed save", async () => {
    checkpoint = { version: 1, job: args().job };
    await expect(decideBusinessReview({ ownerId: "owner", vaultKey: "key", decision: "not_me", assertCurrent: async () => undefined })).rejects.toThrow();
    checkpoint = { version: 1, decision: "saved" };
    await decideBusinessReview({ ownerId: "owner", vaultKey: "key", decision: "later", assertCurrent: async () => undefined });
    expect(checkpoint).toEqual({ version: 1, decision: "saved" });
  });
});
