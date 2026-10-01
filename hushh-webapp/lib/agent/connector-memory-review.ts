import { addToPKM, clearAgentPkmContext, isReservedPkmCard, type AgentPkmPreviewCard, type AgentPkmSaveResult } from "@/lib/agent/agent-pkm-memory";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";
import { isUnresolvedSourceBlock, prepareNaturalLanguagePkm } from "@/lib/pkm/pkm-natural-language-ingestion";
import { loadPkmAgentLabContext } from "@/lib/profile/pkm-agent-lab-capture";
import { isDegradedPreviewCard } from "@/lib/profile/pkm-agent-lab-preview";

export type ConnectorMemorySource = "first_connect_insights" | "drive_read_review";
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
}): Promise<{ cards: AgentPkmPreviewCard[]; incomplete: boolean; alreadySaved: boolean }> {
  await input.assertCurrent();
  // A restored answer may be reviewed before a new chat turn hydrates memory.
  // Warm the existing bounded, decrypted inventory so local duplicate checks
  // also work after a cold refresh. No new cache or plaintext storage.
  await AgentPkmContextStore.load({
    userId: input.userId, vaultKey: input.vaultKey, vaultOwnerToken: input.vaultOwnerToken,
  });
  await input.assertCurrent();
  const context = await loadPkmAgentLabContext({ userId: input.userId, vaultOwnerToken: input.vaultOwnerToken });
  await input.assertCurrent();
  const prepared = await prepareNaturalLanguagePkm({
    userId: input.userId,
    message: input.message,
    currentDomains: (context.metadata?.domains || []).map(domain => domain.key),
    currentManifests: Object.values(context.manifests || {}).filter(Boolean),
    vaultOwnerToken: input.vaultOwnerToken,
    source: input.source,
    allowEmpty: true,
    findDuplicate: candidate => AgentPkmContextStore.findLocalDuplicate({ userId: input.userId, candidate }),
    beforeEffect: input.assertCurrent,
    isEffectCurrent: input.isCurrent,
  });
  await input.assertCurrent();
  const cards = prepared.cards.filter(card =>
    (card.write_mode === "can_save" || card.write_mode === "confirm_first") &&
    !isReservedPkmCard(card) && !isDegradedPreviewCard(card),
  );
  const coverage = prepared.sourceCoverage || [];
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
