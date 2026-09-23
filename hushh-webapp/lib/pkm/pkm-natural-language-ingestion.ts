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
import {
  PKM_PROPOSAL_CHARS, planPkmSourceChunks, sourceChunkRange, sourceChunkText, splitPkmSourceChunk,
  type PkmSourceChunk, type PkmSourceSpan,
} from "@/lib/pkm/pkm-source-chunks";

const MAX_PROPOSAL_CHUNKS = 32;
// A preview is an owner-review step, not an unbounded background job. The
// backend has its own per-proposal budget, but a large note can create several
// sequential proposal waves. Bound the whole client preparation so a provider
// outage or quota backoff cannot leave the review surface in "preparing"
// indefinitely. Incomplete coverage is returned as review-required and is
// never eligible for encrypted save.
const DEFAULT_PREPARATION_BUDGET_MS = 120_000;
// Preview calls are independent and read-only, but each server-side preview
// already fans out to bounded semantic workers. Keep this small so a long
// import does not create a provider burst while still avoiding a serial wait
// for every source block. Encrypted saves remain explicitly sequential.
const MAX_CONCURRENT_PROPOSALS = 2;

export type PkmNaturalLanguageIngestionResult = {
  preview: AgentPkmPreviewResponse;
  previews: AgentPkmPreviewResponse[];
  chunkCount: number;
  save: AgentPkmSaveResult;
  sourceCoverage: PkmNaturalLanguageSourceCoverage[];
};

export type PkmNaturalLanguageWritePolicy = "reviewable" | "auto_save_only";
export type PkmNaturalLanguageMemoryProfile = "general" | "kyc_identity_v1";

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
  sourceRange?: PkmSourceSpan;
  preparationIssue?:
    | "context_span_too_large"
    | "cannot_split_context"
    | "chunk_limit"
    | "preparation_timeout";
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

function splitRecommendedPreview(preview: AgentPkmPreviewResponse): boolean {
  return preview.preview_summary?.split_recommended === true;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function hasUnaccountedFacts(
  preview: AgentPkmPreviewResponse & { cards: AgentPkmPreviewCard[] },
): boolean {
  const detectedFactCount =
    readNonNegativeInteger(preview.preview_summary?.total_segments_detected) ??
    preview.cards.length;
  return detectedFactCount !== preview.cards.length || preview.cards.length === 0;
}

function isSuccessfulEmptyPreview(
  preview: AgentPkmPreviewResponse & { cards: AgentPkmPreviewCard[] },
): boolean {
  return preview.cards.length === 0 && !preview.error &&
    preview.used_fallback !== true &&
    (readNonNegativeInteger(preview.preview_summary?.total_segments_detected) ?? 0) === 0 &&
    !splitRecommendedPreview(preview);
}

function classifySourceBlock(
  preview: AgentPkmPreviewResponse & { cards: AgentPkmPreviewCard[] },
  blockIndex: number,
): PkmNaturalLanguageSourceCoverage {
  const detectedFactCount =
    readNonNegativeInteger(preview.preview_summary?.total_segments_detected) ??
    preview.cards.length;
  const accountedFactCount = preview.cards.length;
  if (accountedFactCount === 0) {
    // A pasted KYC profile can include a truthful negative statement (for
    // example that a government identifier was not supplied). One such block
    // must not discard separately prepared, saveable profile details. Record
    // the omission for the caller; the import still fails if *every* block is
    // unsaveable.
    return {
      sourceBlockId: `source_block_${String(blockIndex + 1).padStart(3, "0")}`,
      disposition:
        preview.error || preview.used_fallback === true || detectedFactCount > 0
          ? "review_required"
          : "intentionally_ignored",
      detectedFactCount,
      accountedFactCount: 0,
    };
  }
  // `total_segments_detected` is the structurer's advisory estimate, not a
  // second durable data contract. We already retry larger mismatched blocks
  // above; a short labelled field can still yield a valid card while the model
  // reports a higher estimate. Keep that card review-required instead of
  // making an otherwise valid owner-approved import impossible to save.
  const segmentCountMismatch = detectedFactCount !== accountedFactCount;
  const everyCardIgnored = preview.cards.every(
    (card) => card.write_mode === "do_not_save",
  );
  const needsReview =
    segmentCountMismatch ||
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
  memoryProfile?: PkmNaturalLanguageMemoryProfile;
  /**
   * Local, in-memory duplicate check against the already-decrypted working
   * set (never a network call). An exact match drops the card; a possible
   * match keeps it but forces owner confirmation.
   */
  findDuplicate?: (candidate: string) => PkmNaturalLanguageDuplicateMatch;
  allowEmpty?: boolean;
  /** Test/diagnostic override; production callers use the bounded default. */
  preparationBudgetMs?: number;
  beforeEffect?: () => Promise<void>;
  isEffectCurrent?: () => boolean;
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
  // KYC imports are intentionally one constrained extraction call. Splitting
  // an export first loses cross-field context and reintroduces model fan-out.
  let queue: PkmSourceChunk[] = params.memoryProfile === "kyc_identity_v1"
    ? [{ blocks: [{ start: 0, end: message.length, protectedContext: true }] }]
    : planPkmSourceChunks(message);
  const previews: AgentPkmPreviewResponse[] = [];
  const cards: AgentPkmPreviewCard[] = [];
  const sourceCoverage: PkmNaturalLanguageSourceCoverage[] = [];
  let failedBlocks = 0;
  if (queue.length > MAX_PROPOSAL_CHUNKS) {
    throw new Error("This import is too large to prepare safely. Please split it into smaller sections.");
  }
  const preparationController = new AbortController();
  const preparationBudgetMs = Math.max(
    50,
    Math.floor(params.preparationBudgetMs ?? DEFAULT_PREPARATION_BUDGET_MS),
  );
  let preparationTimedOut = false;
  const preparationTimer = globalThis.setTimeout(() => {
    preparationTimedOut = true;
    preparationController.abort();
  }, preparationBudgetMs);
  const unresolved = (chunk: PkmSourceChunk, preparationIssue: NonNullable<PkmNaturalLanguageSourceCoverage["preparationIssue"]>) => {
    sourceCoverage.push({
      sourceBlockId: `source_block_${String(sourceCoverage.length + 1).padStart(3, "0")}`,
      sourceRange: sourceChunkRange(chunk), preparationIssue,
      disposition: "review_required", detectedFactCount: 0, accountedFactCount: 0,
    });
  };
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

  type ChunkPreviewResult = {
    sourceChunk: PkmSourceChunk;
    chunk: string;
    index: number;
    preview?: Awaited<ReturnType<typeof previewAgentPkmMemory>>;
    failed?: boolean;
    timedOut?: boolean;
    oversized?: boolean;
  };
  const readyResults = new WeakMap<object, ChunkPreviewResult>();
  const requestChunkPreview = async (
    sourceChunk: PkmSourceChunk,
    index: number,
  ): Promise<ChunkPreviewResult> => {
    const ready = readyResults.get(sourceChunk);
    if (ready) {
      readyResults.delete(sourceChunk);
      // The request already completed in an earlier wave, but its queue index
      // may have shifted after a preceding source block was split.
      return { ...ready, index };
    }
    if (preparationTimedOut || preparationController.signal.aborted) {
      return {
        sourceChunk,
        chunk: sourceChunkText(message, sourceChunk),
        index,
        timedOut: true,
      };
    }
    await params.beforeEffect?.();
    const chunk = sourceChunkText(message, sourceChunk);
    if (params.memoryProfile !== "kyc_identity_v1" && chunk.length > PKM_PROPOSAL_CHARS) {
      return { sourceChunk, chunk, index, oversized: true };
    }
    try {
      const preview = await previewAgentPkmMemory({
        userId: params.userId,
        message: chunk,
        currentDomains: params.currentDomains,
        currentManifests: params.currentManifests,
        vaultOwnerToken: params.vaultOwnerToken,
        ingestionId,
        chunkIndex: index + 1,
        memoryProfile: params.memoryProfile,
        signal: preparationController.signal,
        isEffectCurrent: params.isEffectCurrent,
      });
      await params.beforeEffect?.();
      return { sourceChunk, chunk, index, preview };
    } catch {
      // A canceled session is not a failed source block and must not retry.
      await params.beforeEffect?.();
      return {
        sourceChunk,
        chunk,
        index,
        failed: !preparationTimedOut,
        timedOut: preparationTimedOut,
      };
    }
  };

  // The queue always contains only work that has not been processed. When a
  // result recommends splitting, later results from the same wave are held in
  // readyResults so split children are processed before later source blocks.
  // This keeps coverage, card ordering, and retry semantics identical to the
  // former serial implementation.
  try {
    while (queue.length > 0) {
      if (queue.length > MAX_PROPOSAL_CHUNKS) {
        throw new Error("This import is too large to prepare safely. Please split it into smaller sections.");
      }
      // Drain completed work even after the deadline. requestChunkPreview
      // returns retained results first and never starts fresh work when aborted.
      const wave = queue.slice(0, MAX_CONCURRENT_PROPOSALS);
      const results = await Promise.all(
        wave.map((sourceChunk, offset) => requestChunkPreview(sourceChunk, offset)),
      );
      const replacement: PkmSourceChunk[] = [];
      let splitEncountered = false;

      for (let offset = 0; offset < results.length; offset += 1) {
        const result = results[offset]!;
        const { sourceChunk, chunk, index } = result;
        if (result.timedOut) {
          unresolved(sourceChunk, "preparation_timeout");
          continue;
        }
        if (splitEncountered) {
          readyResults.set(sourceChunk, result);
          replacement.push(sourceChunk);
          continue;
        }
        if (result.oversized) {
          unresolved(sourceChunk, "context_span_too_large");
          continue;
        }
        if (result.failed) {
          failedBlocks += 1;
          sourceCoverage.push({
            sourceBlockId: `source_block_${String(sourceCoverage.length + 1).padStart(3, "0")}`,
            sourceRange: sourceChunkRange(sourceChunk),
            disposition: "failed",
            detectedFactCount: 0,
            accountedFactCount: 0,
          });
          logIngestion("chunk_failed", {
            ingestion_id: ingestionId,
            source: params.source,
            chunk_index: index + 1,
            message_chars: chunk.length,
            // Provider messages can echo submitted text. Diagnostics retain only
            // a fixed status, never arbitrary error names/messages or source text.
            error_code: "proposal_failed",
          });
          continue;
        }
        const preview = result.preview!;
        const incomplete = splitRecommendedPreview(preview) || (
          hasUnaccountedFacts(preview) &&
          !(params.allowEmpty && isSuccessfulEmptyPreview(preview)) &&
          chunk.length > 96
        );
        if (params.memoryProfile !== "kyc_identity_v1" && incomplete) {
          if (preparationTimedOut || preparationController.signal.aborted) {
            unresolved(sourceChunk, "preparation_timeout");
            continue;
          }
          const retryChunks = splitPkmSourceChunk(message, sourceChunk);
          const deferredWaveItems = results.length - offset - 1;
          if (!retryChunks || queue.length - wave.length + replacement.length + retryChunks.length + deferredWaveItems > MAX_PROPOSAL_CHUNKS) {
            unresolved(sourceChunk, retryChunks ? "chunk_limit" : "cannot_split_context");
            continue;
          }
          replacement.push(...retryChunks);
          splitEncountered = true;
          logIngestion("chunk_split", {
            ingestion_id: ingestionId,
            source: params.source,
            chunk_count: queue.length - wave.length + replacement.length,
            chunk_index: index + 1,
            message_chars: chunk.length,
          });
          params.onProgress?.({
            phase: "splitting",
            chunkIndex: index,
            chunkCount: queue.length - wave.length + replacement.length,
            cardCount: cards.length,
          });
          continue;
        }
        previews.push(preview);
        if (params.allowEmpty && isSuccessfulEmptyPreview(preview)) {
        // An auto-save-only caller (KYC) accepts a block with nothing durable
        // in it; that is a valid outcome, not an unaccounted block.
        sourceCoverage.push({
          sourceBlockId: `source_block_${String(sourceCoverage.length + 1).padStart(3, "0")}`,
          sourceRange: sourceChunkRange(sourceChunk),
          disposition: "intentionally_ignored",
          detectedFactCount: 0,
          accountedFactCount: 0,
        });
          continue;
        }
        const coverage = classifySourceBlock(preview, sourceCoverage.length);
        coverage.sourceRange = sourceChunkRange(sourceChunk);
        const deduped = applyLocalDuplicates(preview.cards, params.findDuplicate);
        if (deduped.dropped > 0) coverage.duplicateCount = deduped.dropped;
        const excludedSecretCount = preview.cards.filter(isSecretRejectedCard).length;
        if (excludedSecretCount > 0) coverage.excludedSecretCount = excludedSecretCount;
        if (deduped.cards.length === 0 && preview.cards.length > 0 &&
          coverage.detectedFactCount === coverage.accountedFactCount &&
          !preview.error && preview.used_fallback !== true) {
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
      queue.splice(0, wave.length, ...replacement);
    }
  } finally {
    globalThis.clearTimeout(preparationTimer);
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
  // Partial preparation cannot authorize automatic effects. Keep the model's
  // semantic fields intact and retain cards for explicit owner review/save.
  // A model-requested confirmation alone does not taint independent cards.
  const incompletePreparation = sourceCoverage.some((block) =>
    Boolean(block.preparationIssue) || block.disposition === "failed" ||
    block.detectedFactCount !== block.accountedFactCount,
  ) || previews.some((preview) => preview.used_fallback === true || Boolean(preview.error));
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
    cards: incompletePreparation
      ? cards.map((card) => ({ ...card, preparation_requires_review: true }))
      : cards,
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
  memoryProfile?: PkmNaturalLanguageMemoryProfile;
  /** See addToPKM: only constrained profile imports opt into this write path. */
  batchSimpleDomainExtensions?: boolean;
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
    batchSimpleDomainExtensions: params.batchSimpleDomainExtensions,
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
    sourceCoverage: prepared.sourceCoverage,
  };
}
