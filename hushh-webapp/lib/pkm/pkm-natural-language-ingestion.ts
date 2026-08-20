"use client";

import {
  addToPKM,
  previewAgentPkmMemory,
  type AgentPkmPreviewCard,
  type AgentPkmPreviewResponse,
  type AgentPkmSaveResult,
} from "@/lib/agent/agent-pkm-memory";
import type { PkmWriteAuthorization } from "@/lib/personal-knowledge-model/mutation-plan";

const MAX_PROPOSAL_MESSAGE_CHARS = 10_000;
const MIN_RETRY_CHUNK_CHARS = 96;
const MAX_PROPOSAL_CHUNKS = 32;

export type PkmNaturalLanguageIngestionResult = {
  preview: AgentPkmPreviewResponse;
  previews: AgentPkmPreviewResponse[];
  chunkCount: number;
  save: AgentPkmSaveResult;
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

function splitRecommendedPreview(preview: AgentPkmPreviewResponse): boolean {
  return preview.preview_summary?.split_recommended === true;
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
export async function ingestNaturalLanguagePkm(params: {
  userId: string;
  message: string;
  currentDomains: string[];
  vaultKey: string;
  vaultOwnerToken: string;
  source: string;
  confirmation: PkmWriteAuthorization;
}): Promise<PkmNaturalLanguageIngestionResult> {
  const message = params.message.trim();
  if (!message) {
    throw new Error("A memory import needs some text to process.");
  }

  const ingestionId = createIngestionId();
  const startedAt = performance.now();
  const queue = splitText(message, MAX_PROPOSAL_MESSAGE_CHARS);
  const previews: AgentPkmPreviewResponse[] = [];
  const cards: AgentPkmPreviewCard[] = [];
  logIngestion("started", {
    ingestion_id: ingestionId,
    source: params.source,
    chunk_count: queue.length,
    message_chars: message.length,
  });

  for (let index = 0; index < queue.length; index += 1) {
    if (queue.length > MAX_PROPOSAL_CHUNKS) {
      throw new Error("This import is too large to prepare safely. Please split it into smaller sections.");
    }
    const chunk = queue[index]!;
    const preview = await previewAgentPkmMemory({
      userId: params.userId,
      message: chunk,
      currentDomains: params.currentDomains,
      vaultOwnerToken: params.vaultOwnerToken,
      ingestionId,
      chunkIndex: index + 1,
    });
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
      continue;
    }
    previews.push(preview);
    cards.push(
      ...preview.cards.map((card, cardIndex) => ({
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
  }

  if (cards.length === 0 || previews.length === 0) {
    throw new Error("We couldn't find saveable personal details in this import.");
  }

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
    ingestion_id: ingestionId,
    source: params.source,
    chunk_count: previews.length,
    card_count: cards.length,
    saved: save.saved,
    failed: save.failed,
    duration_ms: Math.round(performance.now() - startedAt),
  });

  return { preview: previews[0]!, previews, chunkCount: previews.length, save };
}
