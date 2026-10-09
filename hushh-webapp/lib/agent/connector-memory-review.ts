import { addToPKM, clearAgentPkmContext, isReservedPkmCard, type AgentPkmPreviewCard, type AgentPkmSaveResult } from "@/lib/agent/agent-pkm-memory";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";
import { isUnresolvedSourceBlock, prepareNaturalLanguagePkm } from "@/lib/pkm/pkm-natural-language-ingestion";
import { loadPkmAgentLabContext } from "@/lib/profile/pkm-agent-lab-capture";
import { isDegradedPreviewCard } from "@/lib/profile/pkm-agent-lab-preview";
import type { BusinessMemoryOrigin } from "@/lib/pkm/business-memory-origin";
import { validBusinessProfilePreview } from "@/lib/agent/business-profile-contract";

export type ConnectorMemorySource = "first_connect_insights" | "drive_read_review" | "business_profile_review";
type MemorySession = {
  userId: string;
  vaultOwnerToken: string;
  isCurrent: () => boolean;
  assertCurrent: () => Promise<void>;
};

/** Reuse the semantic preview and duplicate inventory. Preparing never writes memory. */
export async function prepareConnectorMemoryReview(input: MemorySession & {
  message: string;
  source: ConnectorMemorySource;
  vaultKey: string;
  businessUid?: string;
}): Promise<{ cards: AgentPkmPreviewCard[]; incomplete: boolean; alreadySaved: boolean }> {
  await input.assertCurrent();
  if (input.source === "business_profile_review" && !input.businessUid)
    throw new Error("Business identity is required for review.");
  // A restored answer may be reviewed before a new chat turn hydrates memory.
  // Warm the existing bounded, decrypted inventory so local duplicate checks
  // also work after a cold refresh. No new cache or plaintext storage.
  await AgentPkmContextStore.load({
    userId: input.userId, vaultKey: input.vaultKey, vaultOwnerToken: input.vaultOwnerToken,
    ...(input.source === "business_profile_review" ? { forceRefresh: true } : {}),
  });
  await input.assertCurrent();
  const businessCandidates = input.source === "business_profile_review"
    ? AgentPkmContextStore.findBusinessReconciliationCandidates({ userId: input.userId, businessUid: input.businessUid! }) : [];
  if (businessCandidates.length === 1) {
    const supplied = JSON.parse(input.message) as Record<string, unknown>;
    const existing = JSON.parse(businessCandidates[0]!.message) as Record<string, unknown>;
    if (Object.keys(supplied).length && Object.entries(supplied).every(([key, value]) =>
      typeof value === "string" && existing[key] === value))
      return { cards: [], incomplete: false, alreadySaved: true };
  }
  const context = await loadPkmAgentLabContext({ userId: input.userId, vaultOwnerToken: input.vaultOwnerToken });
  await input.assertCurrent();
  const prepared = await prepareNaturalLanguagePkm({
    userId: input.userId,
    message: input.message,
    currentDomains: (context.metadata?.domains || []).map(domain => domain.key),
    currentManifests: Object.values(context.manifests || {}).filter(Boolean),
    vaultOwnerToken: input.vaultOwnerToken,
    source: input.source,
    memoryProfile: input.source === "business_profile_review" ? "business_directory_v1" : "general",
    allowEmpty: true,
    findDuplicate: candidate => AgentPkmContextStore.findLocalDuplicate({ userId: input.userId, candidate }),
    findReconciliationCandidates: input.source === "business_profile_review" ? () => businessCandidates : undefined,
    beforeEffect: input.assertCurrent,
    isEffectCurrent: input.isCurrent,
  });
  await input.assertCurrent();
  const cards = prepared.cards.filter(card =>
    (card.write_mode === "can_save" || card.write_mode === "confirm_first") &&
    !isReservedPkmCard(card) && !isDegradedPreviewCard(card),
  );
  const coverage = prepared.sourceCoverage || [];
  if (input.source === "business_profile_review" && cards.length && !validBusinessProfilePreview(cards, input.message))
    return { cards: [], alreadySaved: false, incomplete: true };
  // Only explicit exact-duplicate evidence can claim this is already saved.
  const alreadySaved = cards.length === 0 && coverage.length > 0 && coverage.every(block =>
    !block.preparationIssue && block.disposition === "intentionally_ignored" &&
    (block.duplicateCount || 0) > 0 &&
    (block.duplicateCount || 0) >= block.detectedFactCount &&
    !(block.excludedSecretCount || 0),
  );
  return { cards, alreadySaved, incomplete: coverage.some(isUnresolvedSourceBlock) || cards.length < prepared.cards.filter(card => card.write_mode !== "do_not_save").length };
}

export function connectorMemorySharingImpact(cards: AgentPkmPreviewCard[]): number {
  // Different cards can affect different recipients. Count the union when
  // available; old previews supply only a count, so retain that upper bound.
  const labels = new Set(cards.flatMap(card => card.sharing_impact?.recipient_labels || []));
  return Math.max(labels.size, 0, ...cards.map(card => card.sharing_impact?.active_recipient_count || 0));
}

/** Exact reviewed selection only; all encryption and writes stay with addToPKM. */
export async function saveConnectorMemoryReview(input: MemorySession & {
  cards: AgentPkmPreviewCard[];
  message: string;
  source: ConnectorMemorySource;
  vaultKey: string;
  sharingImpactAcknowledged?: boolean;
  idempotencyScopes?: readonly string[];
  businessOrigin?: BusinessMemoryOrigin;
}): Promise<AgentPkmSaveResult | null> {
  await input.assertCurrent();
  if (!input.cards.length || input.cards.some(card =>
    !["can_save", "confirm_first"].includes(card.write_mode || "") || isReservedPkmCard(card) || isDegradedPreviewCard(card),
  )) return null;
  if (connectorMemorySharingImpact(input.cards) > 0 && !input.sharingImpactAcknowledged) return null;
  const result = await addToPKM({
    userId: input.userId,
    cards: input.cards,
    sourceMessage: input.message,
    vaultKey: input.vaultKey,
    vaultOwnerToken: input.vaultOwnerToken,
    source: input.source,
    idempotencyScopes: input.idempotencyScopes,
    businessOrigin: input.businessOrigin,
    beforeEffect: input.assertCurrent,
    mayPublish: input.isCurrent,
    confirmation: {
      confirmedByUser: true,
      surface: "chat",
      source: input.source,
      sharingImpactAcknowledged: input.sharingImpactAcknowledged === true,
    },
  });
  if (result.saved > 0 && input.isCurrent()) clearAgentPkmContext(input.userId);
  return result;
}
