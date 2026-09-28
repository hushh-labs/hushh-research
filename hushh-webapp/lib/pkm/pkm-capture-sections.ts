/**
 * Owner-facing description of a note section that still needs another pass.
 *
 * The label is read from the owner's own note, in memory, for the owner's own
 * review screen. It is never logged, sent, or persisted.
 */
import { toPlainMemoryText } from "@/lib/pkm/memory-plain-text";
import type { PkmNaturalLanguageSourceCoverage } from "@/lib/pkm/pkm-natural-language-ingestion";

export type PkmCaptureSection = {
  /** Stable across preparations: blocks never overlap, so a range is unique. */
  key: string;
  label: string;
  reason: string;
  retryable: boolean;
};

const LABEL_CHARS = 80;

function clamp(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= LABEL_CHARS ? single : `${single.slice(0, LABEL_CHARS - 1).trimEnd()}…`;
}

function firstLine(source: string, start: number, end: number): string {
  for (const line of source.slice(start, end).split("\n")) {
    const plain = toPlainMemoryText(line);
    if (plain) return plain;
  }
  return "";
}

export function pkmCaptureSectionKey(block: PkmNaturalLanguageSourceCoverage): string {
  return block.sourceRange
    ? `${block.sourceRange.start}:${block.sourceRange.end}`
    : block.sourceBlockId;
}

function reasonFor(block: PkmNaturalLanguageSourceCoverage): string {
  switch (block.preparationIssue) {
    case "preparation_timeout":
      return "Preparing this section took too long.";
    case "context_span_too_large":
      return "This section is too long to prepare in one pass. Splitting it into shorter parts will help.";
    case "cannot_split_context":
      return "This section holds more details than One can prepare at once. Splitting it into shorter parts will help.";
    case "chunk_limit":
      return "This note has more sections than One can prepare at once.";
    case "degraded_preview":
      return "One couldn’t finish reading this section.";
    default:
      break;
  }
  if (block.disposition === "failed") return "This section couldn’t be prepared.";
  if (block.detectedFactCount > block.accountedFactCount) {
    return `${block.accountedFactCount} of ${block.detectedFactCount} details in this section were prepared.`;
  }
  return "This section needs another pass.";
}

export function describePkmCaptureSection(
  source: string,
  block: PkmNaturalLanguageSourceCoverage,
): PkmCaptureSection {
  const range = block.sourceRange;
  const heading = block.sourceContext?.length
    ? firstLine(source, block.sourceContext.at(-1)!.start, block.sourceContext.at(-1)!.end)
    : "";
  const opening = range ? firstLine(source, range.start, range.end) : "";
  const label = clamp([heading, opening].filter(Boolean).join(" · ")) || "Part of this note";
  return {
    key: pkmCaptureSectionKey(block),
    label,
    reason: reasonFor(block),
    retryable: Boolean(range),
  };
}
