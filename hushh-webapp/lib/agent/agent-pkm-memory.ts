"use client";

import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { buildReadablePkmMetadata } from "@/lib/personal-knowledge-model/natural-language";
import { ApiService } from "@/lib/services/api-service";
import {
  PersonalKnowledgeModelService,
  type PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";
import {
  PkmWriteCoordinator,
  type PkmWriteCoordinatorResult,
} from "@/lib/services/pkm-write-coordinator";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";

export type AgentPkmDomainChoice = {
  domain_key: string;
  display_name: string;
  description: string;
  recommended: boolean;
};

export type AgentPkmIntentFrame = {
  save_class?: string;
  intent_class?: string;
  mutation_intent?: string;
  requires_confirmation?: boolean;
  confirmation_reason?: string;
  candidate_domain_choices?: AgentPkmDomainChoice[];
};

export type AgentPkmPreviewCard = {
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
  write_mode?: "can_save" | "confirm_first" | "do_not_save" | string;
  requires_confirmation?: boolean;
  confirmation_reason?: string;
  candidate_domain_choices?: AgentPkmDomainChoice[];
  validation_hints?: string[];
  intent_frame?: AgentPkmIntentFrame;
  merge_decision?: Record<string, unknown>;
  candidate_payload?: Record<string, unknown>;
  structure_decision?: Record<string, unknown>;
  manifest_draft?: DomainManifest | null;
};

export type AgentPkmPreviewResponse = {
  agent_id: string;
  agent_name: string;
  model: string;
  used_fallback: boolean;
  routing_decision?: string;
  error?: string | null;
  intent_frame?: AgentPkmIntentFrame;
  merge_decision?: Record<string, unknown>;
  candidate_payload?: Record<string, unknown>;
  structure_decision?: Record<string, unknown>;
  write_mode?: string;
  primary_json_path?: string | null;
  target_entity_scope?: string | null;
  validation_hints?: string[];
  manifest_draft?: DomainManifest | null;
  preview_cards?: AgentPkmPreviewCard[];
  preview_summary?: Record<string, unknown>;
  performance?: Record<string, unknown>;
};

export type AgentPkmContext = {
  text: string;
  domains: string[];
  totalAttributes: number;
  updatedAt: string | null;
  detailCount?: number;
  source?: "metadata" | "decrypted_session_pkm";
  mode?: "summary" | "relevant" | "broad";
};

export type AgentPkmSaveResult = {
  attempted: number;
  saved: number;
  failed: number;
  domains: string[];
  results: Array<{
    cardId: string;
    domain: string;
    success: boolean;
    message?: string;
    result?: PkmWriteCoordinatorResult;
  }>;
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compactText(value: unknown, maxLength: number): string {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function titleize(value: string | null | undefined): string {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function normalizePreviewCards(response: AgentPkmPreviewResponse): AgentPkmPreviewCard[] {
  if (Array.isArray(response.preview_cards)) {
    return response.preview_cards;
  }
  if (!response.candidate_payload || !response.structure_decision) {
    return [];
  }
  return [
    {
      card_id: "agent_pkm_preview_1",
      source_text: "",
      save_class: response.intent_frame?.save_class,
      intent_class: response.intent_frame?.intent_class,
      mutation_intent: response.intent_frame?.mutation_intent,
      target_domain: readString(response.structure_decision.target_domain),
      primary_json_path: response.primary_json_path ?? null,
      target_entity_scope: response.target_entity_scope ?? null,
      write_mode: response.write_mode,
      requires_confirmation: response.intent_frame?.requires_confirmation,
      confirmation_reason: response.intent_frame?.confirmation_reason,
      candidate_domain_choices: response.intent_frame?.candidate_domain_choices,
      validation_hints: response.validation_hints,
      intent_frame: response.intent_frame,
      merge_decision: response.merge_decision,
      candidate_payload: response.candidate_payload,
      structure_decision: response.structure_decision,
      manifest_draft: response.manifest_draft ?? null,
    },
  ];
}

export function getAutoSavePkmCards(cards: readonly AgentPkmPreviewCard[]): AgentPkmPreviewCard[] {
  return cards.filter((card) => card.write_mode === "can_save");
}

export function getReviewRequiredPkmCards(
  cards: readonly AgentPkmPreviewCard[]
): AgentPkmPreviewCard[] {
  return cards.filter((card) => card.write_mode === "confirm_first");
}

export function getIgnoredPkmCards(cards: readonly AgentPkmPreviewCard[]): AgentPkmPreviewCard[] {
  return cards.filter((card) => card.write_mode === "do_not_save");
}

export async function previewAgentPkmMemory(params: {
  userId: string;
  message: string;
  currentDomains: string[];
  vaultOwnerToken: string;
}): Promise<AgentPkmPreviewResponse & { cards: AgentPkmPreviewCard[] }> {
  const response = await ApiService.apiFetch("/api/pkm/agent-lab/structure", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.vaultOwnerToken}`,
    },
    body: JSON.stringify({
      user_id: params.userId,
      message: params.message,
      current_domains: params.currentDomains,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `PKM memory preview failed with ${response.status}`);
  }

  const payload = (await response.json()) as AgentPkmPreviewResponse;
  return {
    ...payload,
    cards: normalizePreviewCards(payload).map((card, index) => ({
      ...card,
      card_id: card.card_id || `agent_pkm_preview_${index + 1}`,
      source_text: card.source_text || params.message,
    })),
  };
}

function resolveCardTargetDomain(card: AgentPkmPreviewCard): string {
  const structureDecision = toRecord(card.structure_decision);
  const manifestDraft = card.manifest_draft && typeof card.manifest_draft === "object"
    ? card.manifest_draft
    : null;
  return (
    readString(manifestDraft?.domain) ||
    readString(structureDecision.target_domain) ||
    readString(card.target_domain)
  );
}

export async function addToPKM(params: {
  userId: string;
  cards: AgentPkmPreviewCard[];
  sourceMessage: string;
  vaultKey: string;
  vaultOwnerToken: string;
  source?: string;
}): Promise<AgentPkmSaveResult> {
  const results: AgentPkmSaveResult["results"] = [];

  for (const card of params.cards) {
    const candidatePayload = toRecord(card.candidate_payload);
    const structureDecision = toRecord(card.structure_decision);
    const manifestDraft =
      card.manifest_draft && typeof card.manifest_draft === "object"
        ? card.manifest_draft
        : null;
    const targetDomain = resolveCardTargetDomain(card);
    const cardId = card.card_id || "agent_pkm_card";

    if (Object.keys(candidatePayload).length === 0 || !targetDomain) {
      results.push({
        cardId,
        domain: targetDomain || "unknown",
        success: false,
        message: "PKM preview did not produce a valid target domain or payload.",
      });
      continue;
    }

    const summaryProjection = toRecord(structureDecision.summary_projection);
    const readableMetadata = buildReadablePkmMetadata({
      domainKey: targetDomain,
      domainDisplayName: titleize(targetDomain),
      sourceText: card.source_text || params.sourceMessage,
      mergeMode:
        readString(card.merge_mode) ||
        readString(card.merge_decision?.merge_mode) ||
        null,
      intentClass:
        readString(card.intent_class) ||
        readString(card.intent_frame?.intent_class) ||
        null,
      manifest: manifestDraft,
      structureDecision,
      primaryJsonPath: readString(card.primary_json_path) || null,
      targetEntityScope: readString(card.target_entity_scope) || null,
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

    try {
      const result = await PkmWriteCoordinator.savePreparedDomain({
        userId: params.userId,
        domain: targetDomain,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        build: async () => ({
          domainData: candidatePayload,
          summary: {
            ...nextSummaryProjection,
            message_excerpt: compactText(card.source_text || params.sourceMessage, 160),
            source: params.source || "agent_chat",
            card_id: cardId,
          },
          mergeDecision: card.merge_decision,
          structureDecision: nextStructureDecision,
          manifest: nextManifest || undefined,
        }),
      });
      results.push({
        cardId,
        domain: targetDomain,
        success: result.success,
        message: result.message,
        result,
      });
    } catch (error) {
      results.push({
        cardId,
        domain: targetDomain,
        success: false,
        message: error instanceof Error ? error.message : "Failed to save PKM memory.",
      });
    }
  }

  const savedResults = results.filter((result) => result.success);
  if (savedResults.length > 0) {
    AgentPkmContextStore.invalidateUser(params.userId);
  }
  return {
    attempted: results.length,
    saved: savedResults.length,
    failed: results.length - savedResults.length,
    domains: Array.from(new Set(savedResults.map((result) => result.domain))).filter(Boolean),
    results,
  };
}

export function buildAgentPkmContextFromMetadata(
  metadata: PersonalKnowledgeModelMetadata | null
): AgentPkmContext {
  if (!metadata) {
    return {
      text: "",
      domains: [],
      totalAttributes: 0,
      updatedAt: null,
    };
  }

  const domains = metadata.domains
    .filter((domain) => {
      const hasSummary = Boolean(compactText(domain.readableSummary, 220));
      const hasHighlights = Array.isArray(domain.readableHighlights) && domain.readableHighlights.length > 0;
      return domain.attributeCount > 0 || hasSummary || hasHighlights;
    })
    .slice(0, 8);

  if (domains.length === 0) {
    return {
      text: "No saved PKM summaries are available yet.",
      domains: metadata.domains.map((domain) => domain.key).filter(Boolean),
      totalAttributes: metadata.totalAttributes || 0,
      updatedAt: metadata.lastUpdated || null,
    };
  }

  const lines = [
    "PKM compact context for Agent (summary metadata only; not the full decrypted PKM):",
    `Saved domains: ${domains.map((domain) => domain.displayName || domain.key).join(", ")}`,
    `Total saved details: ${metadata.totalAttributes || 0}`,
  ];

  for (const domain of domains) {
    const highlights = Array.isArray(domain.readableHighlights)
      ? domain.readableHighlights.map((item) => compactText(item, 100)).filter(Boolean).slice(0, 3)
      : [];
    const summary =
      compactText(domain.readableSummary, 240) ||
      compactText(domain.summary?.readable_summary, 240) ||
      compactText(domain.summary?.message_excerpt, 160) ||
      `${domain.attributeCount || 0} saved detail${domain.attributeCount === 1 ? "" : "s"}.`;
    lines.push(
      [
        `- ${domain.displayName || titleize(domain.key)} (${domain.key})`,
        summary ? `summary: ${summary}` : null,
        highlights.length > 0 ? `highlights: ${highlights.join("; ")}` : null,
        domain.lastUpdated ? `updated: ${domain.lastUpdated}` : null,
      ]
        .filter(Boolean)
        .join(" | ")
    );
  }

  return {
    text: lines.join("\n").slice(0, 6000),
    domains: metadata.domains.map((domain) => domain.key).filter(Boolean),
    totalAttributes: metadata.totalAttributes || 0,
    updatedAt: metadata.lastUpdated || null,
  };
}

export async function loadAgentPkmContext(params: {
  userId: string;
  vaultOwnerToken: string;
  vaultKey?: string | null;
  message?: string;
  forceRefresh?: boolean;
  maxChars?: number;
}): Promise<AgentPkmContext> {
  if (params.vaultKey) {
    try {
      return await AgentPkmContextStore.load({
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        message: params.message,
        forceRefresh: params.forceRefresh,
        maxChars: params.maxChars,
      });
    } catch {
      AgentPkmContextStore.invalidateUser(params.userId);
    }
  }
  const metadata = await PersonalKnowledgeModelService.getMetadata(
    params.userId,
    params.forceRefresh === true,
    params.vaultOwnerToken
  );
  return {
    ...buildAgentPkmContextFromMetadata(metadata),
    source: "metadata",
    mode: "summary",
  };
}

export function peekAgentPkmContext(params: {
  userId: string;
  message?: string;
  maxChars?: number;
}): AgentPkmContext | null {
  return AgentPkmContextStore.peek(params);
}

export function clearAgentPkmContext(userId?: string): void {
  AgentPkmContextStore.clear(userId);
}

export function formatAgentPkmSaveSummary(result: AgentPkmSaveResult): string {
  if (result.saved === 0) {
    return result.failed > 0
      ? "Agent could not save that PKM memory."
      : "No PKM memory was saved for this turn.";
  }
  const domainText =
    result.domains.length > 0 ? ` (${result.domains.map(titleize).join(", ")})` : "";
  return `Saved ${result.saved} PKM memor${result.saved === 1 ? "y" : "ies"}${domainText}.`;
}
