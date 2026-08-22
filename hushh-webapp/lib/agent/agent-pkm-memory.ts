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
import {
  isOwnerAutoSaveAuthorization,
  type PkmUserConfirmation,
  type PkmWriteAuthorization,
} from "@/lib/personal-knowledge-model/mutation-plan";
import {
  AgentPkmContextStore,
  type AgentPkmContextCoverage,
} from "@/lib/agent/agent-pkm-context-store";

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
  sharing_impact?: {
    active_recipient_count: number;
    recipient_labels: string[];
    enters_next_export_revision: boolean;
    summary: string;
    affected_grant_ids: string[];
    affected_export_ids: string[];
  };
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
  coverage?: AgentPkmContextCoverage;
};

export type AgentPkmSaveResult = {
  attempted: number;
  saved: number;
  failed: number;
  domains: string[];
  results: Array<{
    cardId: string;
    domain: string;
    scope: string | null;
    sharingPosture: string;
    success: boolean;
    message?: string;
    result?: PkmWriteCoordinatorResult;
  }>;
};

export class AgentPkmContextNotReadyError extends Error {
  readonly code = "AGENT_PKM_CONTEXT_NOT_READY";

  constructor(message = "Your private memory is not ready yet.") {
    super(message);
    this.name = "AgentPkmContextNotReadyError";
  }
}

// The unlock orchestrator may warm this private-memory working set after the
// owner unlocks. It stays process-memory-only, user-scoped, and coalesced with
// any fallback warmup started by the Agent workspace.
const agentPkmWarmups = new Map<string, Promise<void>>();

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

export function getPkmConfirmationCards(
  cards: readonly AgentPkmPreviewCard[]
): AgentPkmPreviewCard[] {
  return cards.filter(
    (card) =>
      !isReservedPkmCard(card) &&
      (card.write_mode === "confirm_first" ||
        (card.write_mode === "can_save" &&
          (card.sharing_impact?.active_recipient_count || 0) > 0))
  );
}

export function getPkmAutoSaveCards(
  cards: readonly AgentPkmPreviewCard[]
): AgentPkmPreviewCard[] {
  return cards.filter(
    (card) =>
      !isReservedPkmCard(card) &&
      card.write_mode === "can_save" &&
      (card.sharing_impact?.active_recipient_count || 0) === 0
  );
}

export function getIgnoredPkmCards(cards: readonly AgentPkmPreviewCard[]): AgentPkmPreviewCard[] {
  return cards.filter((card) => card.write_mode === "do_not_save");
}

export function isReservedPkmCard(card: AgentPkmPreviewCard): boolean {
  const decision = toRecord(card.structure_decision);
  const action = readString(decision.action).toLowerCase();
  const hints = (card.validation_hints || []).map((hint) => readString(hint).toLowerCase());

  return (
    card.write_mode === "do_not_save" ||
    action === "reject_reserved_target" ||
    action === "reserved_target" ||
    action === "reserved" ||
    hints.some((hint) => hint.includes("reserved"))
  );
}

export function isAgentPkmDependentRequest(message: string): boolean {
  const text = String(message || "").trim().toLowerCase();
  if (!text) return false;

  return (
    /\b(?:read|show|list|summari[sz]e|remember|recall|know)\b[^.?!]{0,80}\b(?:my|pkm|memory|vault|profile)\b/.test(
      text
    ) ||
    /\bmy\s+(?:pkm|memory|vault|profile|preferences?|favo(?:u)?rites?|food|drinks?|games?|hobbies|interests?)\b/.test(
      text
    ) ||
    /\b(?:what|which|who)\b[^.?!]{0,80}\b(?:i|my)\b[^.?!]{0,80}\b(?:prefer|like|saved|remember)\b/.test(
      text
    )
  );
}

export async function previewAgentPkmMemory(params: {
  userId: string;
  message: string;
  currentDomains: string[];
  vaultOwnerToken: string;
  ingestionId?: string;
  chunkIndex?: number;
}): Promise<AgentPkmPreviewResponse & { cards: AgentPkmPreviewCard[] }> {
  const response = await ApiService.apiFetch("/api/pkm/memory/proposals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.vaultOwnerToken}`,
      ...(params.ingestionId
        ? { "X-PKM-Ingestion-Id": params.ingestionId }
        : {}),
      ...(typeof params.chunkIndex === "number"
        ? { "X-PKM-Chunk-Index": String(params.chunkIndex) }
        : {}),
    },
    body: JSON.stringify({
      user_id: params.userId,
      message: params.message,
      current_domains: params.currentDomains,
    }),
  });

  if (!response.ok) {
    let errorCode = `http_${response.status}`;
    try {
      const payload = await response.json() as {
        detail?: { type?: unknown; code?: unknown } | Array<{ type?: unknown; code?: unknown }>;
      };
      const detail = Array.isArray(payload?.detail) ? payload.detail[0] : payload?.detail;
      if (detail && typeof detail === "object") {
        const candidate = detail.code || detail.type;
        if (typeof candidate === "string" && candidate.trim()) {
          errorCode = candidate.trim();
        }
      }
    } catch {
      // Error bodies can contain the rejected source text. Never surface or log them.
    }
    console.error("[PKM_INGEST] proposal_failed", {
      ingestion_id: params.ingestionId || "none",
      chunk_index: params.chunkIndex ?? 0,
      status: response.status,
      error_code: errorCode,
    });
    throw new Error(`Memory preparation failed (${errorCode}). Please try again.`);
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

function resolveCardScope(card: AgentPkmPreviewCard): string | null {
  const value = readString(card.primary_json_path) || readString(card.target_entity_scope);
  return value || null;
}

function resolveCardSharingPosture(card: AgentPkmPreviewCard): string {
  if ((card.sharing_impact?.active_recipient_count || 0) > 0) {
    return "Approved for sharing with the recipients shown above.";
  }
  return "Private to your private agent. Consent is required before external sharing.";
}

function formatPkmLocation(domain: string, scope: string | null): string {
  const path = String(scope || "")
    .split(".")
    .map((segment) => titleize(segment))
    .filter(Boolean);
  return [titleize(domain), ...path].filter(Boolean).join(" > ");
}

export async function addToPKM(params: {
  userId: string;
  cards: AgentPkmPreviewCard[];
  sourceMessage: string;
  vaultKey: string;
  vaultOwnerToken: string;
  source?: string;
  confirmation: PkmWriteAuthorization;
}): Promise<AgentPkmSaveResult> {
  // Writes to a single domain must stay ordered: each write reads and merges
  // the result of the preceding one. Independent domains have no such
  // dependency, so a small bounded fan-out keeps large imports responsive
  // without risking same-domain lost updates.
  const maxParallelDomainWrites = 3;
  const results: Array<AgentPkmSaveResult["results"][number] | undefined> =
    new Array(params.cards.length);
  const automatic = isOwnerAutoSaveAuthorization(params.confirmation);
  if (!params.confirmation || (!automatic && params.confirmation.confirmedByUser !== true)) {
    return {
      attempted: params.cards.length,
      saved: 0,
      failed: params.cards.length,
      domains: [],
      results: params.cards.map((card) => ({
        cardId: card.card_id || "agent_pkm_card",
        domain: resolveCardTargetDomain(card) || "unknown",
        scope: resolveCardScope(card),
        sharingPosture: resolveCardSharingPosture(card),
        success: false,
        message: "Your confirmation is required before saving to Memory.",
      })),
    };
  }

  const saveCard = async (card: AgentPkmPreviewCard, index: number): Promise<void> => {
    if (isReservedPkmCard(card)) {
      results[index] = {
        cardId: card.card_id || "agent_pkm_card",
        domain: resolveCardTargetDomain(card) || "unknown",
        scope: resolveCardScope(card),
        sharingPosture: "Reserved, never shareable.",
        success: false,
        message: "This memory is reserved and cannot be saved from Agent chat.",
      };
      return;
    }
    if (card.write_mode !== "can_save" && card.write_mode !== "confirm_first") {
      results[index] = {
        cardId: card.card_id || "agent_pkm_card",
        domain: resolveCardTargetDomain(card) || "unknown",
        scope: resolveCardScope(card),
        sharingPosture: resolveCardSharingPosture(card),
        success: false,
        message: "This memory preview is not eligible for confirmation and saving.",
      };
      return;
    }
    if (
      automatic &&
      (card.write_mode !== "can_save" || (card.sharing_impact?.active_recipient_count || 0) > 0)
    ) {
      results[index] = {
        cardId: card.card_id || "agent_pkm_card",
        domain: resolveCardTargetDomain(card) || "unknown",
        scope: resolveCardScope(card),
        sharingPosture: resolveCardSharingPosture(card),
        success: false,
        message: "This memory needs review before it can be saved.",
      };
      return;
    }
    const candidatePayload = toRecord(card.candidate_payload);
    const structureDecision = toRecord(card.structure_decision);
    const manifestDraft =
      card.manifest_draft && typeof card.manifest_draft === "object"
        ? card.manifest_draft
        : null;
    const targetDomain = resolveCardTargetDomain(card);
    const cardId = card.card_id || "agent_pkm_card";

    if (Object.keys(candidatePayload).length === 0 || !targetDomain) {
      results[index] = {
        cardId,
        domain: targetDomain || "unknown",
        scope: resolveCardScope(card),
        sharingPosture: resolveCardSharingPosture(card),
        success: false,
        message: "Memory preview did not produce a valid place to save this detail.",
      };
      return;
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
      const sharingImpact = card.sharing_impact;
      const ownerConfirmation = automatic
        ? null
        : params.confirmation as PkmUserConfirmation;
      const result = await PkmWriteCoordinator.savePreparedDomain({
        userId: params.userId,
        domain: targetDomain,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        confirmation: automatic
          ? params.confirmation
          : {
              ...ownerConfirmation!,
              sharingImpactAcknowledged:
                (sharingImpact?.active_recipient_count || 0) > 0
                  ? ownerConfirmation!.sharingImpactAcknowledged === true
                  : false,
              sharingImpact: sharingImpact
                ? {
                    activeRecipientCount: sharingImpact.active_recipient_count,
                    recipientLabels: sharingImpact.recipient_labels,
                    entersNextExportRevision: sharingImpact.enters_next_export_revision,
                    summary: sharingImpact.summary,
                    affectedGrantIds: sharingImpact.affected_grant_ids,
                    affectedExportIds: sharingImpact.affected_export_ids,
                  }
                : undefined,
            },
        build: async () => ({
          domainData: candidatePayload,
          summary: {
            ...nextSummaryProjection,
            source: params.source || "agent_chat",
          },
          mergeDecision: card.merge_decision,
          structureDecision: nextStructureDecision,
          manifest: nextManifest || undefined,
        }),
      });
      results[index] = {
        cardId,
        domain: targetDomain,
        scope: resolveCardScope(card),
        sharingPosture: resolveCardSharingPosture(card),
        success: result.success,
        message: result.message,
        result,
      };
    } catch (error) {
      results[index] = {
        cardId,
        domain: targetDomain,
        scope: resolveCardScope(card),
        sharingPosture: resolveCardSharingPosture(card),
        success: false,
        message: error instanceof Error ? error.message : "Failed to save this memory.",
      };
    }
  };

  const domainQueues = new Map<string, Array<[number, AgentPkmPreviewCard]>>();
  params.cards.forEach((card, index) => {
    // Invalid domains receive their own queue so a malformed card never
    // blocks valid data from a different domain.
    const domain = resolveCardTargetDomain(card) || `__invalid_${index}`;
    const queue = domainQueues.get(domain) || [];
    queue.push([index, card]);
    domainQueues.set(domain, queue);
  });

  const queues = Array.from(domainQueues.values());
  let nextQueueIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextQueueIndex < queues.length) {
      const queue = queues[nextQueueIndex++];
      if (!queue) return;
      for (const [index, card] of queue) {
        await saveCard(card, index);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(maxParallelDomainWrites, queues.length) },
      () => worker(),
    ),
  );

  const completedResults = results.filter(
    (result): result is AgentPkmSaveResult["results"][number] => Boolean(result),
  );

  const savedResults = completedResults.filter((result) => result.success);
  if (savedResults.length > 0) {
    AgentPkmContextStore.invalidateUser(params.userId);
  }
  return {
    attempted: completedResults.length,
    saved: savedResults.length,
    failed: completedResults.length - savedResults.length,
    domains: Array.from(new Set(savedResults.map((result) => result.domain))).filter(Boolean),
    results: completedResults,
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
  /**
   * Interactive first turns may use redacted metadata while the decrypted
   * session working set warms in the background. This never writes or changes
   * PKM relevance/save policy; it only avoids blocking a new conversation on
   * a full encrypted blob.
   */
  metadataOnly?: boolean;
  /**
   * Personal-memory requests must fail closed until the decrypted, typed
   * session inventory is available. Metadata is intentionally insufficient.
   */
  requireDecrypted?: boolean;
}): Promise<AgentPkmContext> {
  if (params.requireDecrypted && (!params.vaultKey || params.metadataOnly)) {
    throw new AgentPkmContextNotReadyError(
      "Unlock your vault before asking Agent about your private memory."
    );
  }

  if (params.vaultKey && !params.metadataOnly) {
    try {
      const workingContext = await AgentPkmContextStore.load({
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        message: params.message,
        forceRefresh: params.forceRefresh,
        maxChars: params.maxChars,
      });
      if (workingContext) {
        return workingContext;
      }
      if (params.requireDecrypted) {
        throw new AgentPkmContextNotReadyError(
          "Your private memory is still preparing. Please try again in a moment."
        );
      }
      return {
        text: "",
        domains: [],
        totalAttributes: 0,
        updatedAt: null,
      };
    } catch (error) {
      if (error instanceof AgentPkmContextNotReadyError) {
        throw error;
      }
      AgentPkmContextStore.invalidateUser(params.userId);
      if (params.requireDecrypted) {
        throw new AgentPkmContextNotReadyError(
          "Your private memory could not be loaded. Please try again in a moment."
        );
      }
      return {
        text: "",
        domains: [],
        totalAttributes: 0,
        updatedAt: null,
      };
    }
  }
  if (params.requireDecrypted) {
    throw new AgentPkmContextNotReadyError(
      "Unlock your vault before asking Agent about your private memory."
    );
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

export function warmAgentPkmContext(params: {
  userId: string;
  vaultOwnerToken: string;
  vaultKey?: string | null;
}): Promise<void> {
  if (!params.vaultKey) return Promise.resolve();

  const existing = agentPkmWarmups.get(params.userId);
  if (existing) return existing;

  const warmup = loadAgentPkmContext({
    ...params,
    message: "",
    requireDecrypted: true,
  })
    .then(() => undefined)
    .finally(() => {
      if (agentPkmWarmups.get(params.userId) === warmup) {
        agentPkmWarmups.delete(params.userId);
      }
    });
  agentPkmWarmups.set(params.userId, warmup);
  return warmup;
}

export function clearAgentPkmContext(userId?: string): void {
  if (userId) {
    agentPkmWarmups.delete(userId);
  } else {
    agentPkmWarmups.clear();
  }
  AgentPkmContextStore.clear(userId);
}

export function formatAgentPkmSaveSummary(result: AgentPkmSaveResult): string {
  if (result.saved === 0) {
    return result.failed > 0
      ? "One could not save that memory."
      : "No memory was saved for this message.";
  }
  const saved = result.results.filter((entry) => entry.success);
  const locations = Array.from(
    new Set(
      saved
        .map((entry) => formatPkmLocation(entry.domain, entry.scope))
        .filter(Boolean)
    )
  );
  const posture = saved[0]?.sharingPosture;
  const locationText = locations.length > 0 ? `Saved in ${locations.join(", ")}.` : "Saved to your memory.";
  return `${locationText}${posture ? ` ${posture}` : ""}`;
}
