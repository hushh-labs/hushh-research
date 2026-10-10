import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import { resolveCardTargetDomain } from "@/lib/agent/agent-pkm-memory";
import { saveConnectorMemoryReview } from "@/lib/agent/connector-memory-review";
import { pkmPlanIdForIdempotencyScope } from "@/lib/personal-knowledge-model/mutation-plan";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";
import type { BusinessSuggestion } from "@/lib/services/business-suggestion-service";
import { withPkmSaveJobLock } from "@/lib/pkm/pkm-save-job";
import { businessMemoryEntity } from "@/lib/pkm/business-memory-origin";

export type BusinessCandidate = BusinessSuggestion["candidates"][number];

/**
 * A stable listing UID does not mean the public fields are unchanged. Keep a
 * deterministic snapshot so a stale review cannot be written after refresh.
 */
function stableCandidateValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCandidateValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableCandidateValue(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function businessCandidateSnapshot(candidate: BusinessCandidate): string {
  return stableCandidateValue(candidate);
}
export class BusinessOriginValidationError extends Error {
  constructor(readonly reason: "path" | "id" | "scope") {
    super("The proposed destination changed. Review the details again.");
  }
}
export type BusinessReviewJob = {
  version: 1;
  ownerId: string;
  businessUid: string;
  revision: string;
  message: string;
  cards: AgentPkmPreviewCard[];
  scopes: string[];
  committed: string[];
  /** Kept encrypted with the review; never substitute newer discovery fields. */
  candidate?: BusinessCandidate;
  candidateSnapshot?: string;
  reviewedName?: string;
  reviewedWebsite?: string;
};
export type BusinessReviewCheckpoint = {
  version: 1;
  decision?: "later" | "not_me" | "saved";
  until?: number;
  job?: BusinessReviewJob;
};
const resource = (businessUid: string) => `business_profile_review:uat:v1:${encodeURIComponent(businessUid)}`;
const TTL = 30 * 24 * 60 * 60 * 1000;

/** Control/recovery information only; the authoritative profile stays in PKM. */
export async function loadBusinessReview(ownerId: string, vaultKey: string, businessUid?: string) {
  if (!businessUid?.trim()) throw new Error("Business identity is required.");
  const value = await SecureResourceCacheService.readRequired<BusinessReviewCheckpoint>({
    userId: ownerId, vaultKey, resourceKey: resource(businessUid),
  });
  if (!value) return null;
  if (value.version !== 1 || (value.decision && !["later", "not_me", "saved"].includes(value.decision)))
    throw new Error("The saved review needs to be restarted.");
  if (value.job && (value.job.version !== 1 || value.job.ownerId !== ownerId ||
    value.job.businessUid !== businessUid ||
    !Array.isArray(value.job.cards) || value.job.cards.length > 64 ||
    value.job.cards.length !== value.job.scopes?.length ||
    !Array.isArray(value.job.committed) || typeof value.job.revision !== "string" ||
    typeof value.job.message !== "string" || !value.job.revision.trim() ||
    !value.job.scopes.every((scope, index) => scope ===
      `business-review:${ownerId}:${businessUid}:${value.job!.revision}:${index}`) ||
    value.job.cards.some(card => !card || typeof card.card_id !== "string" || !card.card_id.trim()) ||
    new Set(value.job.committed).size !== value.job.committed.length ||
    new Set(value.job.cards.map(card => card.card_id)).size !== value.job.cards.length ||
    !value.job.committed.every(id => value.job!.cards.some(card => card.card_id === id))))
    throw new Error("The saved review needs to be restarted.");
  if (value.job?.candidate && (value.job.candidate.businessUid !== businessUid ||
    value.job.candidateSnapshot !== businessCandidateSnapshot(value.job.candidate) ||
    typeof value.job.reviewedName !== "string" || typeof value.job.reviewedWebsite !== "string"))
    throw new Error("The saved review needs to be restarted.");
  return value;
}

/** Legacy jobs have no listing snapshot and must never authorize new writes. */
export function assertBusinessReviewFresh(job: BusinessReviewJob, candidate: BusinessCandidate) {
  if (!job.candidate || !job.candidateSnapshot || job.businessUid !== candidate.businessUid ||
    job.candidateSnapshot !== businessCandidateSnapshot(job.candidate) ||
    job.candidateSnapshot !== businessCandidateSnapshot(candidate))
    throw new Error("The listing changed since this review. Pending details have not been overwritten.");
}

export async function persistBusinessReview(ownerId: string, vaultKey: string, value: BusinessReviewCheckpoint, businessUid?: string) {
  if (!businessUid?.trim()) throw new Error("Business identity is required.");
  await SecureResourceCacheService.writeRequired({ userId: ownerId, vaultKey,
    resourceKey: resource(businessUid), value, ttlMs: TTL });
}

export async function decideBusinessReview(input: {
  ownerId: string; vaultKey: string; decision: "later" | "not_me"; businessUid?: string;
  assertCurrent: () => Promise<void>;
}) {
  return withPkmSaveJobLock(`business-review:${input.ownerId}`, async () => {
    await input.assertCurrent();
    const prior = await loadBusinessReview(input.ownerId, input.vaultKey, input.businessUid);
    await input.assertCurrent();
    if (prior?.decision === "saved" || prior?.decision === "not_me") return;
    if (prior?.job && input.decision === "not_me") throw new Error("A save is pending. Review it first.");
    await persistBusinessReview(input.ownerId, input.vaultKey, { version: 1, decision: input.decision,
      until: input.decision === "later" ? Date.now() + 24 * 60 * 60 * 1000 : undefined,
      job: prior?.job }, input.businessUid);
    await input.assertCurrent();
    return true;
  });
}

export function businessDraftMessage(candidate: BusinessCandidate, name: string, website: string) {
  if (!name.trim() || name.length > 160 || website.length > 512) throw new Error("Check the business details.");
  const url = website.trim() ? new URL(website) : null;
  if (url && (!["https:", "http:"].includes(url.protocol) || url.username || url.password)) throw new Error("Use an HTTP or HTTPS website without credentials.");
  // Do not infer an owner, phone, address, or role from the matched domain.
  // Only listing values enter the source span. Trust/consent policy belongs in
  // the authored business_directory_v1 agent instructions, never as a fact.
  const details = Object.fromEntries(Object.entries({ ...candidate.draft, name: name.trim(), website: url?.href || "" })
    .filter(([, value]) => typeof value === "string" && value.trim()));
  const message = JSON.stringify(details);
  if (message.length > 4000) throw new Error("This listing is too large for one business review.");
  return message;
}

/**
 * Build a local card only for explicitly synthetic unit-test fixtures. Live
 * directory records never use this shortcut and remain model-backed.
 */
export function buildSyntheticBusinessPreview(candidate: BusinessCandidate, name: string, website: string): AgentPkmPreviewCard[] {
  // This helper is retained for isolated synthetic test fixtures only. Live
  // directory candidates—including operator-seeded UAT rows—always use the
  // model-backed preparation path in the chat component.
  if (!candidate.synthetic || candidate.sourceIdentity.source !== "uat_fixture" || Object.keys(candidate.draft).length < 3) return [];
  const entityId = `hushh_fixture_${candidate.sourceIdentity.sourceKey.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`.slice(0, 80);
  const entity = Object.fromEntries(Object.entries({
    ...candidate.draft, name: name.trim(), website: website.trim(),
  }).filter(([, value]) => typeof value === "string" && value.trim())) as Record<string, string>;
  return [{
    card_id: `business_profile:${entityId}`,
    source_text: businessDraftMessage(candidate, name, website),
    write_mode: "confirm_first",
    requires_confirmation: true,
    confirmation_reason: "Business details are public or synthetic UAT data and require your explicit review.",
    target_domain: "professional",
    target_entity_scope: "businesses",
    target_entity_id: entityId,
    candidate_payload: { businesses: { entities: { [entityId]: entity } } },
    structure_decision: { target_domain: "professional" },
    merge_decision: { merge_mode: "create_entity", target_entity_path: `businesses.entities.${entityId}` },
    confidence: 1,
  }];
}

/** Keep immutable origin on the agent-selected entity, never invent its destination. */
export function attachBusinessOrigin(card: AgentPkmPreviewCard, candidate: BusinessCandidate): AgentPkmPreviewCard {
  const fixture = candidate.synthetic === true && candidate.sourceIdentity.source === "uat_fixture";
  const directory = candidate.synthetic === false && candidate.sourceIdentity.source === "directory" &&
    !!candidate.sourceIdentity.sourceKey && /^urn:hushh:business:directory:(hotel|healthcare|ria|insurance|business):[a-f0-9]{64}$/.test(candidate.businessUid) &&
    candidate.businessUid.includes(`:directory:${candidate.sourceIdentity.vertical}:`);
  if (!fixture && !directory)
    throw new Error("The business suggestion changed. Review it again.");
  const copy = structuredClone(card);
  const entity = businessMemoryEntity(copy);
  if (!["create_entity", "extend_entity", "correct_entity"].includes(
    String(copy.merge_decision?.merge_mode || copy.merge_mode || "")))
    throw new Error("The proposed detail needs a fresh review before saving.");
  const path = entity.path.join(".");
  const entityId = entity.path.at(-1);
  const scope = entity.path.slice(0, -2).join(".");
  const targetPath = String(copy.merge_decision?.target_entity_path || "");
  const targetSegments = targetPath ? targetPath.split(".") : entity.path;
  const targetScope = targetSegments.slice(0, -2).join(".");
  // The structure and merge stages can select different scopes for the same
  // entity ID. Preserve both outputs, just as the canonical writer does;
  // the conflict-aware save guard checks provenance at the merge destination.
  if (targetSegments.length < 3 || targetSegments.at(-2) !== "entities" || targetSegments.at(-1) !== entityId ||
    targetSegments.some(segment => !segment || ["__proto__", "prototype", "constructor"].includes(segment)))
    throw new BusinessOriginValidationError("path");
  if (copy.target_entity_id && copy.target_entity_id !== entityId) throw new BusinessOriginValidationError("id");
  if (copy.target_entity_scope && ![scope, `${scope}.entities`, path, targetScope, `${targetScope}.entities`, targetPath].includes(copy.target_entity_scope))
    throw new BusinessOriginValidationError("scope");
  entity.value._business_origin = { version: 1, business_uid: candidate.businessUid,
    source_identity: { source: candidate.sourceIdentity.source, source_key: candidate.sourceIdentity.sourceKey },
    synthetic: candidate.synthetic, ownership_verified: false };
  return copy;
}

export function createBusinessReviewJob(ownerId: string, candidate: BusinessCandidate, message: string, cards: AgentPkmPreviewCard[],
  edited = { name: candidate.draft.name, website: candidate.draft.website }): BusinessReviewJob {
  if (!cards.length || cards.length > 64 || cards.some(card => !card.card_id?.trim()) ||
    new Set(cards.map(card => card.card_id)).size !== cards.length)
    throw new Error("Select valid details to save.");
  const revision = crypto.randomUUID();
  return { version: 1, ownerId, businessUid: candidate.businessUid, revision, message,
    candidate: structuredClone(candidate), candidateSnapshot: businessCandidateSnapshot(candidate),
    reviewedName: edited.name, reviewedWebsite: edited.website,
    cards: cards.map(card => attachBusinessOrigin(card, candidate)),
    scopes: cards.map((_, index) => `business-review:${ownerId}:${candidate.businessUid}:${revision}:${index}`), committed: [] };
}

/** Retry the exact encrypted review, consulting server receipts before replaying. */
export async function saveBusinessReview(input: {
  job: BusinessReviewJob; vaultKey: string; vaultOwnerToken: string;
  assertCurrent: () => Promise<void>; isCurrent: () => boolean;
  sharingImpactAcknowledged: boolean;
  /** Recheck the directory only when a new mutation is needed, not for receipts. */
  assertListingFresh: () => Promise<void>;
}): Promise<{ saved: number; remaining: number } | null> {
  return withPkmSaveJobLock(`business-review:${input.job.ownerId}`, async () => {
    await input.assertCurrent();
    const prior = await loadBusinessReview(input.job.ownerId, input.vaultKey, input.job.businessUid);
    await input.assertCurrent();
    if (prior?.decision === "saved") return { saved: input.job.cards.length, remaining: 0 };
    if (prior?.decision === "not_me" || (prior?.job && prior.job.revision !== input.job.revision))
      throw new Error("Another review changed this suggestion. Reopen it before saving.");
    const job = structuredClone(prior?.job || input.job);
    await persistBusinessReview(job.ownerId, input.vaultKey, { version: 1, job }, job.businessUid);
    for (let index = 0; index < job.cards.length; index++) {
      await input.assertCurrent();
      const card = job.cards[index]!;
      if (job.committed.includes(card.card_id)) continue;
      const rows = await PersonalKnowledgeModelService.lookupMutationCommits({
        userId: job.ownerId, vaultOwnerToken: input.vaultOwnerToken,
        commits: [{ domain: resolveCardTargetDomain(card), planId: pkmPlanIdForIdempotencyScope(job.scopes[index]!) }],
      });
      await input.assertCurrent();
      let acknowledged = rows[0]?.exists === true && rows[0].dataVersion !== null;
      if (!acknowledged) {
        // A legacy checkpoint can reconcile an acknowledged commit, but cannot
        // write a card whose original public listing was never checkpointed.
        if (!job.candidate) throw new Error("This pending review has no original listing snapshot. No new details were saved.");
        assertBusinessReviewFresh(job, job.candidate);
        await input.assertListingFresh();
        await input.assertCurrent();
        const result = await saveConnectorMemoryReview({
          ...input, userId: job.ownerId, cards: [card], message: job.message,
          source: "business_profile_review", idempotencyScopes: [job.scopes[index]!],
          businessOrigin: { businessUid: job.businessUid },
        });
        await input.assertCurrent();
        acknowledged = result?.results.some(row => row.success && typeof row.result?.dataVersion === "number") === true;
      }
      if (acknowledged) job.committed.push(card.card_id);
      await persistBusinessReview(job.ownerId, input.vaultKey, { version: 1, job }, job.businessUid);
    }
    await input.assertCurrent();
    const remaining = job.cards.length - job.committed.length;
    await persistBusinessReview(job.ownerId, input.vaultKey, remaining
      ? { version: 1, job } : { version: 1, decision: "saved" }, job.businessUid);
    return { saved: job.committed.length, remaining };
  });
}
