"use client";

/**
 * The person asked One to save something ("save this to my memory").
 *
 * This is a different authority from background auto-capture. Auto-capture
 * writes only what the agents marked `can_save` with no confirmation, and an
 * incomplete preparation taints every card. That policy is right for silent
 * capture and wrong for an explicit request: measured on production
 * 2026-09-29, a pasted personal-context document produced corrections,
 * new domains and sensitive facts, every one of which the auto-save filter
 * dropped, so nothing was saved while One said it was.
 *
 * Here the owner's own request is the confirmation for the content they
 * supplied (`owner_confirmed`, as the chat KYC path already records). Three
 * things still need their direct tap: identifier-class values (government ids,
 * account numbers, dates of birth), details that would change what they
 * already share with someone, and anything the agents refused (reserved,
 * secret, degraded, or `do_not_save`, which is never saved).
 *
 * Nothing here says "saved" until the server acknowledged a committed revision.
 */

import {
  addToPKM,
  isReservedPkmCard,
  type AgentPkmPreviewCard,
  type AgentPkmSaveResult,
} from "@/lib/agent/agent-pkm-memory";
import {
  buildPkmSaveReceipt,
  type ExplicitPkmSaveProgress,
  type ExplicitSavePartition,
  type PkmSaveReceipt,
} from "@/lib/agent/pkm-save-receipt";
import type { PkmReconciliationCandidate } from "@/lib/agent/agent-pkm-context-store";
import { fieldKeyIsSensitive, valueIsIdentifierShaped } from "@/lib/consent/field-sensitivity";
import type { PkmUserConfirmation } from "@/lib/personal-knowledge-model/mutation-plan";
import {
  prepareNaturalLanguagePkm,
  type PkmNaturalLanguageDuplicateMatch,
} from "@/lib/pkm/pkm-natural-language-ingestion";
import { isDegradedPreviewCard } from "@/lib/profile/pkm-agent-lab-preview";

/** Long documents need more than the 120 s review budget; still bounded. */
export const EXPLICIT_SAVE_PREPARATION_BUDGET_MS = 300_000;

export const EXPLICIT_SAVE_CONFIRMATION: PkmUserConfirmation = {
  confirmedByUser: true,
  surface: "chat",
  source: "agent_chat_owner_request",
};

function isSecretRejected(card: AgentPkmPreviewCard): boolean {
  return (card.validation_hints || []).some((hint) => String(hint).startsWith("sensitive_"));
}

/**
 * The merge agent's own decision that this repeats something stored: no_op
 * with the existing entity it matched. Its untargeted no_op means "not durable"
 * and stays a skip. Measured live 2026-09-29: 72 of 73 no_op cards on a re-paste
 * named a target; 10 of 11 on a first paste did not.
 */
function isRestatementOfKnownDetail(card: AgentPkmPreviewCard): boolean {
  const decision = (card.merge_decision ?? {}) as { merge_mode?: unknown; target_entity_path?: unknown; target_entity_id?: unknown };
  const mode = String(card.merge_mode || decision.merge_mode || "").trim().toLowerCase();
  return mode === "no_op" && Boolean(String(decision.target_entity_path || decision.target_entity_id || "").trim());
}

function hasIdentifierField(value: unknown, path: string[] = []): boolean {
  if (Array.isArray(value)) return value.some((item) => hasIdentifierField(item, path));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
      hasIdentifierField(nested, [...path, key]),
    );
  }
  if (value === null || value === undefined || value === "") return false;
  return (path.length > 0 && fieldKeyIsSensitive(path)) || valueIsIdentifierShaped(value);
}

export function partitionExplicitSaveCards(
  cards: readonly AgentPkmPreviewCard[],
): ExplicitSavePartition {
  const partition: ExplicitSavePartition = { save: [], needsOwner: [], known: [], unreadable: [], skipped: [] };
  for (const card of cards) {
    if (isRestatementOfKnownDetail(card)) {
      partition.known.push(card);
      continue;
    }
    if (isDegradedPreviewCard(card)) {
      partition.unreadable.push(card);
      continue;
    }
    if (isReservedPkmCard(card) || isSecretRejected(card)) {
      partition.skipped.push(card);
      continue;
    }
    if (card.write_mode !== "can_save" && card.write_mode !== "confirm_first") {
      partition.skipped.push(card);
      continue;
    }
    if (
      (card.sharing_impact?.active_recipient_count || 0) > 0 ||
      hasIdentifierField(card.candidate_payload)
    ) {
      partition.needsOwner.push(card);
      continue;
    }
    partition.save.push(card);
  }
  return partition;
}

export type ExplicitPkmSaveResult = {
  receipt: PkmSaveReceipt;
  /** Cards that still need the owner's direct tap; session memory only. */
  needsOwnerCards: AgentPkmPreviewCard[];
};

export async function runExplicitPkmSave(params: {
  userId: string;
  message: string;
  currentDomains: string[];
  currentManifests?: unknown[];
  vaultKey: string;
  vaultOwnerToken: string;
  findDuplicate?: (candidate: string) => PkmNaturalLanguageDuplicateMatch;
  findReconciliationCandidates?: (passage: string) => readonly PkmReconciliationCandidate[];
  domainTitles?: ReadonlyMap<string, string>;
  beforeEffect?: () => Promise<void>;
  isEffectCurrent?: () => boolean;
  mayPublish?: () => boolean;
  onProgress?: (progress: ExplicitPkmSaveProgress) => void;
  preparationBudgetMs?: number;
}): Promise<ExplicitPkmSaveResult> {
  const prepared = await prepareNaturalLanguagePkm({
    userId: params.userId,
    message: params.message,
    currentDomains: params.currentDomains,
    currentManifests: params.currentManifests,
    vaultOwnerToken: params.vaultOwnerToken,
    source: "agent_chat_owner_request",
    allowEmpty: true,
    granularity: "section",
    findDuplicate: params.findDuplicate,
    findReconciliationCandidates: params.findReconciliationCandidates,
    preparationBudgetMs: params.preparationBudgetMs ?? EXPLICIT_SAVE_PREPARATION_BUDGET_MS,
    beforeEffect: params.beforeEffect,
    isEffectCurrent: params.isEffectCurrent,
    onProgress: (progress) => {
      if (progress.phase === "prepared") return;
      params.onProgress?.({
        stage: "reading",
        done: Math.min(progress.chunkIndex, progress.chunkCount),
        total: progress.chunkCount,
      });
    },
  });
  await params.beforeEffect?.();
  // An incomplete preparation does not taint the sections that were prepared:
  // the owner asked for this save, and unread sections are reported, not hidden.
  const cards = prepared.cards.map((card) => {
    if (!card.preparation_requires_review) return card;
    const { preparation_requires_review: _unused, ...rest } = card;
    return rest;
  });
  const partition = partitionExplicitSaveCards(cards);
  let saveResult: AgentPkmSaveResult | null = null;
  if (partition.save.length) {
    params.onProgress?.({ stage: "saving", total: partition.save.length });
    saveResult = await addToPKM({
      userId: params.userId,
      cards: partition.save,
      sourceMessage: params.message,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      source: "agent_chat_owner_request",
      confirmation: { ...EXPLICIT_SAVE_CONFIRMATION, confirmedAt: new Date().toISOString() },
      beforeEffect: params.beforeEffect,
      mayPublish: params.mayPublish,
    });
  }
  return {
    receipt: buildPkmSaveReceipt({
      coverage: prepared.sourceCoverage,
      partition,
      saveResult,
      domainTitles: params.domainTitles,
    }),
    needsOwnerCards: partition.needsOwner,
  };
}

/** The owner tapped "Save these too" on the result card: a direct confirmation. */
export async function saveOwnerConfirmedCards(params: {
  userId: string;
  cards: AgentPkmPreviewCard[];
  sourceMessage: string;
  vaultKey: string;
  vaultOwnerToken: string;
  beforeEffect?: () => Promise<void>;
  mayPublish?: () => boolean;
}): Promise<AgentPkmSaveResult> {
  const sharesChange = params.cards.some((card) => (card.sharing_impact?.active_recipient_count || 0) > 0);
  return addToPKM({
    userId: params.userId,
    cards: params.cards,
    sourceMessage: params.sourceMessage,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    source: "agent_chat_owner_confirmed_card",
    confirmation: {
      confirmedByUser: true,
      surface: "chat",
      source: "agent_chat_owner_confirmed_card",
      confirmedAt: new Date().toISOString(),
      sharingImpactAcknowledged: sharesChange,
    },
    beforeEffect: params.beforeEffect,
    mayPublish: params.mayPublish,
  });
}

export {
  applyOwnerConfirmedSave,
  describePkmSaveReceipt,
  emptyPkmSaveReceipt,
  formatPkmSaveReceiptForAgent,
  pkmSaveReceiptWrote,
  type PkmSaveReceipt,
  type ExplicitPkmSaveProgress,
} from "@/lib/agent/pkm-save-receipt";
