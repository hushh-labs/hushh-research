"use client";

import {
  addToPKM,
  getPkmAutoSaveCards,
  previewAgentPkmMemory,
  type AgentPkmPreviewCard,
  type AgentPkmPreviewResponse,
  type AgentPkmSaveResult,
} from "@/lib/agent/agent-pkm-memory";
import type { PkmWriteAuthorization } from "@/lib/personal-knowledge-model/mutation-plan";

const MAX_PROPOSAL_MESSAGE_CHARS = 6_000;
const MAX_STRUCTURED_SECTIONS_PER_CHUNK = 6;
const MIN_RETRY_CHUNK_CHARS = 96;
const MAX_PROPOSAL_CHUNKS = 32;

export type PkmNaturalLanguageIngestionResult = {
  preview: AgentPkmPreviewResponse;
  previews: AgentPkmPreviewResponse[];
  chunkCount: number;
  save: AgentPkmSaveResult;
};

export type PkmNaturalLanguageWritePolicy = "reviewable" | "auto_save_only";

export type PkmNaturalLanguagePreparationResult = {
  preview: AgentPkmPreviewResponse;
  previews: AgentPkmPreviewResponse[];
  cards: AgentPkmPreviewCard[];
  chunkCount: number;
  ingestionId: string;
  sourceCoverage: PkmNaturalLanguageSourceCoverage[];
};

export type PkmNaturalLanguageSourceCoverage = {
  sourceBlockId: string;
  disposition: "proposed" | "intentionally_ignored" | "review_required" | "failed";
  detectedFactCount: number;
  accountedFactCount: number;
  /** Cards dropped because the same value is already in Memory. */
  duplicateCount?: number;
  /** Cards the structurer refused because they carry a secret. */
  excludedSecretCount?: number;
};

export type PkmNaturalLanguageDuplicateMatch =
  | { kind: "exact" | "possible"; domain: string; path: string[] }
  | null;

export type PkmNaturalLanguagePreparationProgress = {
  phase: "preparing" | "splitting" | "prepared";
  chunkIndex: number;
  chunkCount: number;
  cardCount: number;
};

type PkmIngestionLogFields = {
  ingestion_id: string;
  source: string;
  chunk_count?: number;
  chunk_index?: number;
  message_chars?: number;
  card_count?: number;
  saved?: number;
  failed?: number;
  duration_ms?: number;
  error_code?: string;
};

function createIngestionId(): string {
  return globalThis.crypto?.randomUUID?.() || `pkm_${Date.now().toString(36)}`;
}

function logIngestion(event: string, fields: PkmIngestionLogFields): void {
  console.info(`[PKM_INGEST] ${event}`, fields);
}

function splitText(text: string, maximumLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maximumLength) {
    const minimumBoundary = Math.floor(maximumLength * 0.45);
    const candidates = [
      remaining.lastIndexOf("\n\n", maximumLength),
      remaining.lastIndexOf("\n", maximumLength),
      remaining.lastIndexOf(". ", maximumLength) + 1,
      remaining.lastIndexOf("! ", maximumLength) + 1,
      remaining.lastIndexOf("? ", maximumLength) + 1,
      remaining.lastIndexOf(", ", maximumLength) + 1,
      remaining.lastIndexOf(" ", maximumLength),
    ];
    const boundary = Math.max(...candidates);
    const end = boundary >= minimumBoundary ? boundary : maximumLength;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

function splitStructuredText(text: string): string[] {
  const lines = text.trim().split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];
  const beginsSection = (line: string) =>
    /^\s*(?:#{1,6}\s+|\d{1,3}[.)]\s+\S)/.test(line);
  for (const line of lines) {
    if (beginsSection(line) && current.some((item) => item.trim())) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.some((item) => item.trim())) sections.push(current.join("\n").trim());
  if (sections.length <= 1) return splitText(text, MAX_PROPOSAL_MESSAGE_CHARS);

  const chunks: string[] = [];
  let pending: string[] = [];
  let pendingLength = 0;
  const flush = () => {
    if (!pending.length) return;
    chunks.push(pending.join("\n\n").trim());
    pending = [];
    pendingLength = 0;
  };
  for (const section of sections) {
    if (section.length > MAX_PROPOSAL_MESSAGE_CHARS) {
      flush();
      chunks.push(...splitText(section, MAX_PROPOSAL_MESSAGE_CHARS));
      continue;
    }
    const nextLength = pendingLength + (pending.length ? 2 : 0) + section.length;
    if (
      pending.length >= MAX_STRUCTURED_SECTIONS_PER_CHUNK ||
      nextLength > MAX_PROPOSAL_MESSAGE_CHARS
    ) {
      flush();
    }
    pending.push(section);
    pendingLength += (pending.length > 1 ? 2 : 0) + section.length;
  }
  flush();
  return chunks;
}

function splitRecommendedPreview(preview: AgentPkmPreviewResponse): boolean {
  return preview.preview_summary?.split_recommended === true;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function classifySourceBlock(
  preview: AgentPkmPreviewResponse & { cards: AgentPkmPreviewCard[] },
  blockIndex: number,
): PkmNaturalLanguageSourceCoverage {
  const detectedFactCount =
    readNonNegativeInteger(preview.preview_summary?.total_segments_detected) ??
    preview.cards.length;
  const accountedFactCount = preview.cards.length;
  if (detectedFactCount !== accountedFactCount || accountedFactCount === 0) {
    throw new Error(
      `Memory import block ${blockIndex + 1} was not fully accounted for. Split or clarify that section before saving.`,
    );
  }
  const everyCardIgnored = preview.cards.every(
    (card) => card.write_mode === "do_not_save",
  );
  const needsReview =
    Boolean(preview.error) ||
    preview.used_fallback === true ||
    preview.cards.some(
      (card) => card.write_mode === "confirm_first" || card.requires_confirmation,
    );
  return {
    sourceBlockId: `source_block_${String(blockIndex + 1).padStart(3, "0")}`,
    disposition: everyCardIgnored
      ? "intentionally_ignored"
      : needsReview
        ? "review_required"
        : "proposed",
    detectedFactCount,
    accountedFactCount,
  };
}

function isSecretRejectedCard(card: AgentPkmPreviewCard): boolean {
  const hints = Array.isArray(card.validation_hints) ? card.validation_hints : [];
  return hints.some((hint) => String(hint).startsWith("sensitive_"));
}

/**
 * Drop cards whose value is already in Memory and force confirmation on
 * near matches. The check runs against the decrypted working set already in
 * this session's memory; values never leave the device for it.
 */
function applyLocalDuplicates(
  cards: AgentPkmPreviewCard[],
  findDuplicate: ((candidate: string) => PkmNaturalLanguageDuplicateMatch) | undefined,
): { cards: AgentPkmPreviewCard[]; dropped: number } {
  if (!findDuplicate) return { cards, dropped: 0 };
  let dropped = 0;
  const kept: AgentPkmPreviewCard[] = [];
  for (const card of cards) {
    if (card.write_mode === "do_not_save") {
      kept.push(card);
      continue;
    }
    const match = findDuplicate(String(card.source_text || ""));
    if (match?.kind === "exact") {
      dropped += 1;
      continue;
    }
    if (match?.kind === "possible") {
      kept.push({
        ...card,
        write_mode: "confirm_first",
        validation_hints: [...(card.validation_hints || []), "possible_duplicate"],
      });
      continue;
    }
    kept.push(card);
  }
  return { cards: kept, dropped };
}

/**
 * The one client-side ingestion path for user-authored free text before it is
 * encrypted into PKM. It keeps each proposal below the backend contract limit
 * and recursively narrows model-detected multi-fact chunks so no preview cards
 * are silently dropped. The proposal API owns semantic segmentation, dynamic
 * domain choice, and the PKM structure contract; this helper only carries the
 * approved cards into the existing encrypted write coordinator.
 *
 * Structured writers must not call this. They already have a typed domain
 * contract and must not send decrypted domain data back through an LLM.
 */
export async function prepareNaturalLanguagePkm(params: {
  userId: string;
  message: string;
  currentDomains: string[];
  currentManifests?: unknown[];
  vaultOwnerToken: string;
  source: string;
  /**
   * Local, in-memory duplicate check against the already-decrypted working
   * set (never a network call). An exact match drops the card; a possible
   * match keeps it but forces owner confirmation.
   */
  findDuplicate?: (candidate: string) => PkmNaturalLanguageDuplicateMatch;
  allowEmpty?: boolean;
  onProgress?: (progress: PkmNaturalLanguagePreparationProgress) => void;
}): Promise<PkmNaturalLanguagePreparationResult> {
  const message = params.message.trim();
  if (!message) {
    throw new Error("A memory import needs some text to process.");
  }

  const ingestionId = createIngestionId();
  // Structured exports from other assistants commonly arrive as numbered or
  // Markdown sections. Preserve every line while packing a bounded number of
  // sections into each semantic-agent call, so the agent's eight-card limit
  // cannot silently swallow the tail of a large profile import.
  const queue = splitStructuredText(message);
  const previews: AgentPkmPreviewResponse[] = [];
  const cards: AgentPkmPreviewCard[] = [];
  const sourceCoverage: PkmNaturalLanguageSourceCoverage[] = [];
  let failedBlocks = 0;
  logIngestion("started", {
    ingestion_id: ingestionId,
    source: params.source,
    chunk_count: queue.length,
    message_chars: message.length,
  });
  params.onProgress?.({
    phase: "preparing",
    chunkIndex: 0,
    chunkCount: queue.length,
    cardCount: 0,
  });

  for (let index = 0; index < queue.length; index += 1) {
    if (queue.length > MAX_PROPOSAL_CHUNKS) {
      throw new Error("This import is too large to prepare safely. Please split it into smaller sections.");
    }
    const chunk = queue[index]!;
    let preview: Awaited<ReturnType<typeof previewAgentPkmMemory>>;
    try {
      preview = await previewAgentPkmMemory({
        userId: params.userId,
        message: chunk,
        currentDomains: params.currentDomains,
        currentManifests: params.currentManifests,
        vaultOwnerToken: params.vaultOwnerToken,
        ingestionId,
        chunkIndex: index + 1,
      });
    } catch (error) {
      // One block failing must not discard every block already prepared. The
      // block is reported as failed so nothing is silently lost; the person
      // can re-paste just that section.
      failedBlocks += 1;
      sourceCoverage.push({
        sourceBlockId: `source_block_${String(sourceCoverage.length + 1).padStart(3, "0")}`,
        disposition: "failed",
        detectedFactCount: 0,
        accountedFactCount: 0,
      });
      logIngestion("chunk_failed", {
        ingestion_id: ingestionId,
        source: params.source,
        chunk_index: index + 1,
        message_chars: chunk.length,
        error_code: error instanceof Error ? error.message.slice(0, 80) : "unknown",
      });
      continue;
    }
    if (splitRecommendedPreview(preview)) {
      if (chunk.length <= MIN_RETRY_CHUNK_CHARS) {
        throw new Error("This import contains too many details in one short passage. Add line breaks or split it into smaller sections.");
      }
      const retryChunks = splitText(chunk, Math.ceil(chunk.length / 2));
      if (retryChunks.length < 2) {
        throw new Error("This import could not be separated safely. Please split it into smaller sections.");
      }
      queue.splice(index, 1, ...retryChunks);
      index -= 1;
      logIngestion("chunk_split", {
        ingestion_id: ingestionId,
        source: params.source,
        chunk_count: queue.length,
        chunk_index: index + 2,
        message_chars: chunk.length,
      });
      params.onProgress?.({
        phase: "splitting",
        chunkIndex: Math.max(0, index),
        chunkCount: queue.length,
        cardCount: cards.length,
      });
      continue;
    }
    previews.push(preview);
    const coverage = classifySourceBlock(preview, sourceCoverage.length);
    const deduped = applyLocalDuplicates(preview.cards, params.findDuplicate);
    if (deduped.dropped > 0) coverage.duplicateCount = deduped.dropped;
    const excludedSecretCount = preview.cards.filter(isSecretRejectedCard).length;
    if (excludedSecretCount > 0) coverage.excludedSecretCount = excludedSecretCount;
    if (deduped.cards.length === 0 && preview.cards.length > 0) {
      coverage.disposition = "intentionally_ignored";
    }
    sourceCoverage.push(coverage);
    cards.push(
      ...deduped.cards.map((card, cardIndex) => ({
        ...card,
        card_id: `${ingestionId}_${index + 1}_${card.card_id || cardIndex + 1}`,
      }))
    );
    logIngestion("chunk_prepared", {
      ingestion_id: ingestionId,
      source: params.source,
      chunk_index: index + 1,
      message_chars: chunk.length,
      card_count: preview.cards.length,
    });
    params.onProgress?.({
      phase: "preparing",
      chunkIndex: index + 1,
      chunkCount: queue.length,
      cardCount: cards.length,
    });
  }

  if (previews.length === 0 && failedBlocks > 0) {
    throw new Error("Memory preparation failed for every section. Please try again.");
  }
  if ((cards.length === 0 || previews.length === 0) && !params.allowEmpty) {
    throw new Error("We couldn't find saveable personal details in this import.");
  }

  params.onProgress?.({
    phase: "prepared",
    chunkIndex: previews.length,
    chunkCount: previews.length,
    cardCount: cards.length,
  });
  return {
    preview: previews[0] ?? {
      agent_id: "agent_memory_segmentation",
      agent_name: "Memory Segmentation Agent",
      model: "unknown",
      used_fallback: false,
      write_mode: "do_not_save",
      preview_cards: [],
    },
    previews,
    cards,
    chunkCount: previews.length,
    ingestionId,
    sourceCoverage,
  };
}

export async function ingestNaturalLanguagePkm(params: {
  userId: string;
  message: string;
  currentDomains: string[];
  vaultKey: string;
  vaultOwnerToken: string;
  source: string;
  confirmation: PkmWriteAuthorization;
  writePolicy?: PkmNaturalLanguageWritePolicy;
  onProgress?: (progress: PkmNaturalLanguagePreparationProgress) => void;
}): Promise<PkmNaturalLanguageIngestionResult> {
  const startedAt = performance.now();
  const prepared = await prepareNaturalLanguagePkm({
    ...params,
    allowEmpty: params.writePolicy === "auto_save_only",
  });
  const message = params.message.trim();
  const cards = params.writePolicy === "auto_save_only"
    ? getPkmAutoSaveCards(prepared.cards)
    : prepared.cards;

  const save = await addToPKM({
    userId: params.userId,
    cards,
    sourceMessage: message,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    source: params.source,
    confirmation: params.confirmation,
  });
  logIngestion("completed", {
    ingestion_id: prepared.ingestionId,
    source: params.source,
    chunk_count: prepared.previews.length,
    card_count: prepared.cards.length,
    saved: save.saved,
    failed: save.failed,
    duration_ms: Math.round(performance.now() - startedAt),
  });

  return {
    preview: prepared.preview,
    previews: prepared.previews,
    chunkCount: prepared.chunkCount,
    save,
  };
}
