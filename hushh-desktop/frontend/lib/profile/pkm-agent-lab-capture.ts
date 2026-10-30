"use client";

import { ApiService } from "@/lib/services/api-service";
import { buildReadablePkmMetadata } from "@/lib/personal-knowledge-model/natural-language";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  PersonalKnowledgeModelService,
  type PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";
import {
  PkmWriteCoordinator,
  type PkmWriteCoordinatorResult,
} from "@/lib/services/pkm-write-coordinator";

export type PkmAgentLabDomainChoice = {
  domain_key: string;
  display_name: string;
  description: string;
  recommended: boolean;
};

export type PkmAgentLabIntentFrame = {
  save_class?: string;
  intent_class?: string;
  mutation_intent?: string;
  requires_confirmation?: boolean;
  confirmation_reason?: string;
  candidate_domain_choices?: PkmAgentLabDomainChoice[];
  confidence?: number;
};

export type PkmAgentLabPreviewCard = {
  card_id: string;
  source_text: string;
  save_class?: string;
  intent_class?: string;
  mutation_intent?: string;
  merge_mode?: string;
  target_domain?: string;
  primary_json_path?: string | null;
  target_entity_scope?: string | null;
  target_entity_id?: string | null;
  write_mode?: string;
  requires_confirmation?: boolean;
  confirmation_reason?: string;
  candidate_domain_choices?: PkmAgentLabDomainChoice[];
  validation_hints?: string[];
  intent_frame?: PkmAgentLabIntentFrame;
  merge_decision?: Record<string, unknown>;
  candidate_payload?: Record<string, unknown>;
  structure_decision?: Record<string, unknown>;
  manifest_draft?: DomainManifest | null;
};

export type PkmAgentLabResponse = {
  agent_id: string;
  agent_name: string;
  model: string;
  used_fallback: boolean;
  error?: string | null;
  intent_frame?: PkmAgentLabIntentFrame;
  merge_decision?: Record<string, unknown>;
  candidate_payload: Record<string, unknown>;
  structure_decision: Record<string, unknown>;
  write_mode?: string;
  primary_json_path?: string | null;
  target_entity_scope?: string | null;
  validation_hints?: string[];
  manifest_draft?: DomainManifest | null;
  preview_cards?: PkmAgentLabPreviewCard[];
  preview_summary?: Record<string, unknown>;
};

type PkmAgentLabContext = {
  metadata: PersonalKnowledgeModelMetadata | null;
  manifests: Record<string, DomainManifest | null>;
};

function titleize(value: string | null | undefined): string {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeMode(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function getPkmAgentLabPersistableCards(
  response: PkmAgentLabResponse | null | undefined
): PkmAgentLabPreviewCard[] {
  return (response?.preview_cards || []).filter((card) => card.write_mode !== "do_not_save");
}

export function getDirectPkmVoiceSaveBlockReason(
  response: PkmAgentLabResponse | null | undefined
): string | null {
  const cards = getPkmAgentLabPersistableCards(response);
  if (cards.length === 0) return "No durable memory was detected.";
  if (cards.length > 1) return "Multiple memories need review before saving.";
  const card = cards[0]!;
  if (card.write_mode !== "can_save") return "This memory needs review before saving.";
  if (card.requires_confirmation || card.intent_frame?.requires_confirmation) {
    return "This memory needs confirmation before saving.";
  }
  const mutationIntent = normalizeMode(card.mutation_intent || card.intent_frame?.mutation_intent);
  const mergeMode = normalizeMode(card.merge_mode || card.merge_decision?.merge_mode);
  if (
    mutationIntent === "correct" ||
    mutationIntent === "delete" ||
    mergeMode === "correct_entity" ||
    mergeMode === "delete_entity"
  ) {
    return "Corrections and deletions need review before saving.";
  }
  const confidence = Number(card.intent_frame?.confidence ?? 0.9);
  if (Number.isFinite(confidence) && confidence < 0.82) {
    return "One is not confident enough to save this without review.";
  }
  return null;
}

export async function loadPkmAgentLabContext(params: {
  userId: string;
  vaultOwnerToken: string;
}): Promise<PkmAgentLabContext> {
  const metadata = await PersonalKnowledgeModelService.getMetadata(
    params.userId,
    false,
    params.vaultOwnerToken
  ).catch(() => null);
  const manifests: Record<string, DomainManifest | null> = {};
  if (metadata) {
    await Promise.all(
      metadata.domains.map(async (domain) => {
        manifests[domain.key] = await PersonalKnowledgeModelService.getDomainManifest(
          params.userId,
          domain.key,
          params.vaultOwnerToken
        ).catch(() => null);
      })
    );
  }
  return { metadata, manifests };
}

export async function previewPkmAgentLabCapture(params: {
  userId: string;
  message: string;
  vaultOwnerToken: string;
  context?: PkmAgentLabContext | null;
}): Promise<PkmAgentLabResponse> {
  const context =
    params.context ||
    (await loadPkmAgentLabContext({
      userId: params.userId,
      vaultOwnerToken: params.vaultOwnerToken,
    }));
  const response = await ApiService.apiFetch("/api/pkm/agent-lab/structure", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.vaultOwnerToken}`,
    },
    body: JSON.stringify({
      user_id: params.userId,
      message: params.message,
      current_domains: context.metadata?.domains.map((domain) => domain.key) || [],
      current_manifests: Object.values(context.manifests).filter(Boolean),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `PKM capture preview failed with ${response.status}`);
  }
  return (await response.json()) as PkmAgentLabResponse;
}

export async function savePkmAgentLabResponse(params: {
  userId: string;
  message: string;
  vaultKey: string;
  vaultOwnerToken: string;
  response: PkmAgentLabResponse;
}): Promise<PkmWriteCoordinatorResult[]> {
  const results: PkmWriteCoordinatorResult[] = [];
  for (const card of getPkmAgentLabPersistableCards(params.response)) {
    const candidatePayload =
      card.candidate_payload && typeof card.candidate_payload === "object"
        ? card.candidate_payload
        : null;
    const structureDecision = toRecord(card.structure_decision);
    const manifestDraft =
      card.manifest_draft && typeof card.manifest_draft === "object"
        ? card.manifest_draft
        : null;
    const targetDomain =
      (typeof manifestDraft?.domain === "string" && manifestDraft.domain) ||
      (typeof structureDecision.target_domain === "string" && structureDecision.target_domain) ||
      "";
    if (!candidatePayload || !targetDomain) {
      throw new Error("One preview card did not produce a valid PKM payload.");
    }

    const summaryProjection =
      structureDecision.summary_projection &&
      typeof structureDecision.summary_projection === "object"
        ? (structureDecision.summary_projection as Record<string, unknown>)
        : {};
    const readableMetadata = buildReadablePkmMetadata({
      domainKey: targetDomain,
      domainDisplayName: titleize(targetDomain),
      sourceText: String(card.source_text || params.message),
      mergeMode:
        typeof card.merge_mode === "string"
          ? card.merge_mode
          : typeof card.merge_decision?.merge_mode === "string"
            ? String(card.merge_decision.merge_mode)
            : null,
      intentClass:
        typeof card.intent_class === "string"
          ? card.intent_class
          : typeof card.intent_frame?.intent_class === "string"
            ? card.intent_frame.intent_class
            : null,
      manifest: manifestDraft,
      structureDecision,
      primaryJsonPath: typeof card.primary_json_path === "string" ? card.primary_json_path : null,
      targetEntityScope:
        typeof card.target_entity_scope === "string" ? card.target_entity_scope : null,
    });
    const nextSummaryProjection = {
      ...summaryProjection,
      ...readableMetadata,
    };
    const nextStructureDecision = {
      ...structureDecision,
      summary_projection: nextSummaryProjection,
    };
    const nextManifest =
      manifestDraft && typeof manifestDraft === "object"
        ? ({
            ...manifestDraft,
            summary_projection: {
              ...(manifestDraft.summary_projection || {}),
              ...readableMetadata,
            },
          } as DomainManifest)
        : null;

    const result = await PkmWriteCoordinator.savePreparedDomain({
      userId: params.userId,
      domain: targetDomain,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      build: async () => ({
        domainData: candidatePayload,
        summary: {
          ...nextSummaryProjection,
          message_excerpt: String(card.source_text || params.message).slice(0, 160),
          source: "pkm_agent_lab",
          card_id: card.card_id,
        },
        mergeDecision: card.merge_decision,
        structureDecision: nextStructureDecision,
        manifest: nextManifest || undefined,
      }),
    });
    results.push(result);
    if (!result.success) {
      throw new Error(result.message || "Failed to save PKM preview.");
    }
  }
  return results;
}
